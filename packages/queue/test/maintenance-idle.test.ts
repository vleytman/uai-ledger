import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {createPool} from '../../db/src/index.js';
import {id} from '../../contracts/src/index.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {createApi} from '../../../apps/api/src/server.js';
import {maintenanceIntervals,maintenanceWorked} from '../src/maintenance.js';
import {startScheduler} from '../src/scheduler-loop.js';
import {startBullmqWorker} from '../src/worker.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());

describe('maintenance interval settings',()=>{
 it('keeps one second by default, rejects an idle interval shorter than the active one and reads work from a cycle result',()=>{
  expect(maintenanceIntervals({})).toEqual({interval_ms:1000,idle_interval_ms:1000});
  expect(maintenanceIntervals({UAI_MAINTENANCE_INTERVAL_MS:'500'})).toEqual({interval_ms:500,idle_interval_ms:500});
  expect(maintenanceIntervals({UAI_MAINTENANCE_IDLE_INTERVAL_MS:'30000'})).toEqual({interval_ms:1000,idle_interval_ms:30000});
  expect(()=>maintenanceIntervals({UAI_MAINTENANCE_INTERVAL_MS:'2000',UAI_MAINTENANCE_IDLE_INTERVAL_MS:'1000'})).toThrow('invalid_maintenance_idle_interval');
  expect(()=>maintenanceIntervals({UAI_MAINTENANCE_INTERVAL_MS:'50'})).toThrow('invalid_maintenance_interval');
  expect(()=>maintenanceIntervals({UAI_MAINTENANCE_IDLE_INTERVAL_MS:'abc'})).toThrow('invalid_maintenance_idle_interval');
  // The shape of an idle cycle: zero counts, false flags, no delivery, an empty monitor list, nothing expired.
  const idle={quota_feedback:0,quota_observations:{selected:0,applied:0},quota_cooldowns:0,revocations:0,operations:0,deadlines:0,closed:0,maintenance_accounts:0,maintenance_busy_accounts:0,recovered:0,expired:undefined,native:{worked:false},purged:false,monitors:[],events:0,delivery:null};
  expect(maintenanceWorked(idle)).toBe(false);
  for(const busy of [{maintenance_busy_accounts:1},{native:{worked:true,request_id:'r'}},{delivery:'delivered'},{monitors:[{signal:'x'}]},{quota_observations:{selected:1,applied:0}}])
   expect(maintenanceWorked({...idle,...busy}),JSON.stringify(busy)).toBe(true);
 });
});

describe.skipIf(!enabled)('idle maintenance',()=>{
 it('slows down without work, wakes for a new call, expires it at its deadline and slows down again',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,installation=id('idle'),fixture=await seedLoadFixture(pool,1),api=createApi(pool);
  // The worker has its own pool, so every query it sends is counted.
  const workerPool=createPool(database.url,'worker');let queries=0;
  workerPool.on('connect',client=>{const query=client.query.bind(client) as any;(client as any).query=(...args:any[])=>{queries++;return query(...args)}});
  const cycle=async()=>(await pool.query('SELECT generation,due_at,wake_after,completed_at FROM execution_maintenance_cycles WHERE installation_id=$1',[installation])).rows[0];
  const window=async(ms:number)=>{const g=(await cycle()).generation,q=queries,started=Date.now();await delay(ms);const seconds=(Date.now()-started)/1000;return {cycles:(await cycle()).generation-g,queries_per_second:Math.round((queries-q)/seconds*10)/10}};
  const scheduler=startScheduler({pool,backend:'bullmq',installation,redisUrl:process.env.REDIS_URL!,intervalMs:100});
  // Only maintenance: a call stays queued, as when the generation workers are busy elsewhere.
  const worker=startBullmqWorker({pool:workerPool,installation,redisUrl:process.env.REDIS_URL!,name:'idle-maintenance',queues:['maintenance'],concurrency:1,heartbeatMs:60000,maintenance:{interval_ms:200,idle_interval_ms:30000}});
  try{
   await expect.poll(async()=>(await cycle())?.wake_after??null,{timeout:10000}).not.toBeNull();
   const planned=await cycle();
   expect(new Date(planned.due_at).getTime()-new Date(planned.completed_at).getTime()).toBe(30000);
   const idle=await window(2500);
   expect(idle.cycles).toBe(0);

   const before=(await cycle()).generation,invoked=Date.now();
   const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invoke')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:'Wake maintenance'},parameters:{max_output_tokens:100}}});
   expect(response.statusCode,response.body).toBe(202);const {request_id,operation_id}=response.json();
   await expect.poll(async()=>(await cycle()).generation,{timeout:3000,interval:20}).toBeGreaterThan(before);
   const wakeMs=Date.now()-invoked;
   expect(wakeMs).toBeLessThan(2000);
   const busy=await window(2000);
   // Spaced by the active interval, not back to back: at most ten cycles in two seconds, fewer when cycles are slow under load.
   expect(busy.cycles).toBeGreaterThanOrEqual(2);expect(busy.cycles).toBeLessThanOrEqual(12);
   expect((await cycle()).wake_after).toBeNull();

   // The deadline is closer than the idle interval; the call must still close on time.
   const deadline=new Date(Date.now()+1000);
   await pool.query('UPDATE execution_requests SET deadline_at=$2 WHERE id=$1',[request_id,deadline]);
   await pool.query('UPDATE operations SET deadline_at=$2 WHERE id=$1',[operation_id,deadline]);
   await expect.poll(async()=>(await pool.query('SELECT execution_status,reason,financial_closed_at FROM execution_requests WHERE id=$1',[request_id])).rows[0],{timeout:5000,interval:50})
    .toMatchObject({execution_status:'canceled',reason:'admission_timeout',financial_closed_at:expect.any(Date)});
   const closedMs=Date.now()-deadline.getTime();
   expect(closedMs).toBeLessThan(1500);
   expect((await pool.query('SELECT admission_status FROM operations WHERE id=$1',[operation_id])).rows[0].admission_status).not.toBe('open');

   await expect.poll(async()=>(await cycle()).wake_after,{timeout:5000}).not.toBeNull();
   const idleAgain=await window(2500);
   expect(idleAgain.cycles).toBe(0);
   expect(idleAgain.queries_per_second).toBeLessThan(busy.queries_per_second/10);
   const report={installation,intervals:{interval_ms:200,idle_interval_ms:30000},scheduler_tick_ms:100,idle,wake_after_invocation_ms:wakeMs,busy,deadline_closed_after_ms:closedMs,idle_again:idleAgain};
   await mkdir('.data/test-reports',{recursive:true});await writeFile('.data/test-reports/maintenance-idle.json',JSON.stringify(report,null,2)+'\n');
  }finally{await worker.close();await scheduler.stop();await workerPool.end()}
 },60000);
});
