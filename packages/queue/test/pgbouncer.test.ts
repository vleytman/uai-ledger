import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import pg from 'pg';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {createPool} from '../../db/src/index.js';
import {id} from '../../contracts/src/index.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {createApi} from '../../../apps/api/src/server.js';
import {startScheduler} from '../src/scheduler-loop.js';
import {startBullmqWorker} from '../src/worker.js';

// Owns its PgBouncer container; the image must already be local (no pull).
const enabled=process.env.UAI_TEST_PGBOUNCER==='1'&&!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
const database=isolatedTestDatabase(process.env.DATABASE_URL),exec=promisify(execFile),name=`uai-pgbouncer-${randomUUID().slice(0,8)}`,serverPoolSize=4;
beforeAll(async()=>{if(enabled)await database.initialize()});
afterAll(async()=>{if(enabled)await exec('docker',['rm','-f',name]).catch(()=>{});await database.close()});

// One PgBouncer container for the file, started on first use.
let started:Promise<URL>|undefined;
const pooler=()=>started??=(async()=>{
  const direct=new URL(database.url!),port=String(40000+Math.floor(Math.random()*20000));
  const host=['127.0.0.1','localhost'].includes(direct.hostname)?'host.docker.internal':direct.hostname;
  await exec('docker',['run','-d','--pull=never','--name',name,'-p',`127.0.0.1:${port}:5432`,
   '-e',`DB_HOST=${host}`,'-e',`DB_PORT=${direct.port||'5432'}`,'-e',`DB_USER=${decodeURIComponent(direct.username)}`,'-e',`DB_PASSWORD=${decodeURIComponent(direct.password)}`,
   '-e','POOL_MODE=transaction','-e','AUTH_TYPE=scram-sha-256','-e',`DEFAULT_POOL_SIZE=${serverPoolSize}`,'-e','MAX_CLIENT_CONN=200','-e',`ADMIN_USERS=${decodeURIComponent(direct.username)}`,
   process.env.UAI_TEST_PGBOUNCER_IMAGE??'edoburu/pgbouncer:latest'],{timeout:60000});
  const pooled=new URL(database.url!);pooled.hostname='127.0.0.1';pooled.port=port;
  return pooled;
})();

describe.skipIf(!enabled)('UAI through PgBouncer in transaction mode',()=>{
 it('admits quota calls with group locks, wakes the scheduler through its own LISTEN and keeps server connections within the pooler',async()=>{
  const pooled=await pooler();
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');vi.stubEnv('DATABASE_DIRECT_URL',database.url!);
  const admin=database.pool!,pool=createPool(pooled.href,'worker');
  await vi.waitFor(async()=>expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1),{timeout:15000,interval:250});
  const fixture=await seedLoadFixture(admin,1),installation=id('pgbouncer'),api=createApi(pool);
  const group=(await admin.query("SELECT b.group_id FROM provider_quota_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE c.organization_id=$1 AND b.model='fake-text'",[fixture.scope.organization_id])).rows[0].group_id;
  await admin.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'tokens','tokens',17160,60000)",[group]);
  await admin.query('UPDATE execution_dispatch_policies SET account_limit=4,application_limit=4,queue_limit=4,active_account_limit=4');
  const deps=defaultRuntime(pool),base=deps.adapter;
  deps.adapter=async(...args)=>{
   const adapter=await base(...args),execute=adapter.execute.bind(adapter);
   adapter.estimateLimitUsage=()=>({requests:1,tokens:8400});
   adapter.execute=async(input,context)=>{await delay(200);return {...await execute(input,context),limit_usage:{requests:1,tokens:300}}};
   return adapter;
  };
  // A long tick: new work reaches the scheduler through its LISTEN, not through polling.
  const scheduler=startScheduler({pool,backend:'bullmq',installation,redisUrl:process.env.REDIS_URL!,intervalMs:5000});
  const worker=startBullmqWorker({pool,installation,redisUrl:process.env.REDIS_URL!,deps,name:'pgbouncer',queues:['text','maintenance'],concurrency:4,interactive_reserve:0,heartbeatMs:60000,maintenance:{interval_ms:200,idle_interval_ms:200}});
  const servers:number[]=[];let sampling=true;
  const sample=(async()=>{while(sampling){servers.push((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND application_name NOT IN ('uai-tool','uai-scheduler-wakeup','uai-api-transient')")).rows[0].n);await delay(100)}})();
  const started=Date.now();
  try{
   const discussion=async(n:number)=>{
    for(let turn=0;turn<4;turn++){
     const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invoke')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:`Pooled ${n}.${turn}`},parameters:{max_output_tokens:100}}});
     expect(response.statusCode,response.body).toBe(202);const request=response.json().request_id;
     await expect.poll(async()=>(await admin.query('SELECT execution_status FROM execution_requests WHERE id=$1',[request])).rows[0].execution_status,{timeout:30000,interval:50}).toBe('succeeded');
    }
   };
   await Promise.all([0,1,2].map(discussion));
   const listeners=(await admin.query("SELECT application_name,count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('uai-scheduler-wakeup','uai-api-transient') GROUP BY 1 ORDER BY 1")).rows;
   sampling=false;await sample;
   const report={calls:12,total_ms:Date.now()-started,pooler_server_connections_max:Math.max(...servers),pooler_pool_size:serverPoolSize,direct_listeners:listeners,
    refunds:(await admin.query('SELECT count(*)::int AS n FROM quota_usage_refunds WHERE group_id=$1',[group])).rows[0].n,
    lock_holders_left:(await admin.query("SELECT count(*)::int AS n FROM pg_locks l WHERE l.locktype='advisory' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n};
   await mkdir('.data/test-reports',{recursive:true});await writeFile('.data/test-reports/pgbouncer.json',JSON.stringify(report,null,2)+'\n');
   // Every application connection goes through the pooler; only LISTEN has a server connection of its own.
   expect(report.pooler_server_connections_max).toBeLessThanOrEqual(serverPoolSize);
   expect(listeners).toEqual([{application_name:'uai-scheduler-wakeup',n:1}]);
   expect(report.refunds).toBe(12);expect(report.lock_holders_left).toBe(0);
   // Twelve calls of 200 ms with a 5 s scheduler tick: polling alone would take a minute.
   expect(report.total_ms).toBeLessThan(30000);
  }finally{sampling=false;await sample;await worker.close();await scheduler.stop();await pool.end()}
 },120000);
 it('admits 64 calls of one quota group at once through a server pool of four without a deadlock',async()=>{
  const pooled=await pooler();
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');vi.stubEnv('DATABASE_DIRECT_URL',database.url!);vi.stubEnv('UAI_DB_POOL_MAX_WORKER','72');
  const admin=database.pool!,pool=createPool(pooled.href,'worker');
  const fixture=await seedLoadFixture(admin,8,200),installation=id('pgbouncer-crowd'),api=createApi(pool);
  await admin.query('UPDATE execution_dispatch_policies SET account_limit=200,application_limit=200,queue_limit=200,active_account_limit=200,active_application_limit=200,active_queue_limit=200,interactive_reserve=0');
  await admin.query('UPDATE execution_admission_policies SET account_limit=1000,application_limit=1000').catch(()=>{});
  const scheduler=startScheduler({pool,backend:'bullmq',installation,redisUrl:process.env.REDIS_URL!,intervalMs:200});
  const worker=startBullmqWorker({pool,installation,redisUrl:process.env.REDIS_URL!,name:'pgbouncer-crowd',queues:['text','maintenance'],concurrency:64,interactive_reserve:0,heartbeatMs:60000,maintenance:{interval_ms:200,idle_interval_ms:200}});
  const started=Date.now();
  try{
   const responses=await Promise.all(Array.from({length:64},(_,n)=>api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invoke')},payload:{account_id:fixture.accounts[n%8]!.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:`Crowd ${n}`},parameters:{max_output_tokens:100}}})));
   expect(responses.map(r=>r.statusCode).filter(code=>code!==202),responses.find(r=>r.statusCode!==202)?.body).toEqual([]);
   const ids=responses.map(r=>r.json().request_id);
   await expect.poll(async()=>(await admin.query("SELECT count(*)::int AS n FROM execution_requests WHERE id=ANY($1::text[]) AND execution_status='succeeded'",[ids])).rows[0].n,{timeout:60000,interval:200}).toBe(64);
   // PgBouncer's own view: how long clients waited for a server connection, and whether any still wait.
   const console=new URL(pooled.href);console.pathname='/pgbouncer';
   const bouncer=new pg.Client({connectionString:console.href});await bouncer.connect();
   const stats=(await bouncer.query('SHOW STATS')).rows.find((row:any)=>row.database===new URL(database.url!).pathname.slice(1));
   const pools=(await bouncer.query('SHOW POOLS')).rows.find((row:any)=>row.database===new URL(database.url!).pathname.slice(1));
   await bouncer.end();
   const admission=(await admin.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM a.submission_intent_at-d.first_leased_at)*1000) AS median,max(EXTRACT(EPOCH FROM a.submission_intent_at-d.first_leased_at)*1000) AS max
    FROM execution_requests r JOIN execution_dispatches d ON d.request_id=r.id AND d.generation=r.dispatch_generation JOIN execution_attempts a ON a.request_id=r.id AND a.number=1 WHERE r.id=ANY($1::text[])`,[ids])).rows[0];
   const report={calls:64,worker_concurrency:64,uai_pool:72,pooler_server_connections:serverPoolSize,total_ms:Date.now()-started,
    lease_to_sent_median_ms:Math.round(admission.median),lease_to_sent_max_ms:Math.round(admission.max),
    pooler_avg_wait_us:Number(stats?.avg_wait_time??NaN),pooler_total_wait_ms:Math.round(Number(stats?.total_wait_time??NaN)/1000),pooler_clients_waiting_after:Number(pools?.cl_waiting??NaN)};
   await mkdir('.data/test-reports',{recursive:true});await writeFile('.data/test-reports/pgbouncer-crowd.json',JSON.stringify(report,null,2)+'\n');
  }finally{await worker.close();await scheduler.stop();await pool.end()}
 },150000);
});
