import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id} from '../../contracts/src/index.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {createApi} from '../../../apps/api/src/server.js';
import {startScheduler} from '../src/scheduler-loop.js';
import {startBullmqWorker} from '../src/worker.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());

describe.skipIf(!enabled)('waiting for a tight quota rule',()=>{
 it('keeps admitting three discussions under a rule that holds two calls, as refunds free the window',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,installation=id('waiters'),fixture=await seedLoadFixture(pool,1),api=createApi(pool);
  // Room for two calls of 8 400 tokens a minute; each call really spends 300.
  const group=(await pool.query("SELECT b.group_id FROM provider_quota_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE c.organization_id=$1 AND b.model='fake-text'",[fixture.scope.organization_id])).rows[0].group_id;
  await pool.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'tokens','tokens',17160,60000)",[group]);
  await pool.query('UPDATE execution_dispatch_policies SET account_limit=4,application_limit=4,queue_limit=4,active_account_limit=4');
  const deps=defaultRuntime(pool),base=deps.adapter;
  deps.adapter=async(...args)=>{
   const adapter=await base(...args),execute=adapter.execute.bind(adapter);
   adapter.estimateLimitUsage=()=>({requests:1,tokens:8400});
   adapter.execute=async(input,context)=>{await delay(400);return {...await execute(input,context),limit_usage:{requests:1,tokens:300}}};
   return adapter;
  };
  const scheduler=startScheduler({pool,backend:'bullmq',installation,redisUrl:process.env.REDIS_URL!,intervalMs:100});
  const worker=startBullmqWorker({pool,installation,redisUrl:process.env.REDIS_URL!,deps,name:'waiters',queues:['text','maintenance'],concurrency:4,interactive_reserve:0,heartbeatMs:60000,maintenance:{interval_ms:200,idle_interval_ms:200}});
  const status=async(request:string)=>(await pool.query('SELECT execution_status,reason FROM execution_requests WHERE id=$1',[request])).rows[0];
  const started=Date.now();
  try{
   const discussion=async(n:number)=>{
    for(let turn=0;turn<6;turn++){
     const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invoke')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:`Discussion ${n}, turn ${turn}`},parameters:{max_output_tokens:100}}});
     expect(response.statusCode,response.body).toBe(202);const request=response.json().request_id;
     await expect.poll(async()=>(await status(request)).execution_status,{timeout:90000,interval:50}).not.toMatch(/^(queued|leased|submitting|running|waiting_retry)$/);
     expect((await status(request)).execution_status,`discussion ${n} turn ${turn}`).toBe('succeeded');
    }
   };
   await Promise.all([0,1,2].map(discussion));
   const waits=(await pool.query(`SELECT EXTRACT(EPOCH FROM a.created_at-r.enqueued_at)*1000 AS wait_ms FROM execution_requests r JOIN execution_attempts a ON a.request_id=r.id WHERE r.organization_id=$1 ORDER BY 1`,[fixture.scope.organization_id])).rows.map(row=>Number(row.wait_ms));
   const report={calls:waits.length,total_ms:Date.now()-started,longest_wait_ms:Math.round(Math.max(...waits)),median_wait_ms:Math.round(waits[Math.floor(waits.length/2)]!),refunds:(await pool.query('SELECT count(*)::int AS n FROM quota_usage_refunds WHERE group_id=$1',[group])).rows[0].n};
   await mkdir('.data/test-reports',{recursive:true});await writeFile('.data/test-reports/quota-waiters.json',JSON.stringify(report,null,2)+'\n');
   expect(report.calls).toBe(18);
   // Before the fix a refused call slept for most of the minute-long window; with only the 5 s retry ceiling, about 10 s.
   expect(report.longest_wait_ms).toBeLessThan(8000);
   expect(report.refunds).toBe(18);
  }finally{await worker.close();await scheduler.stop()}
 },120000);
});
