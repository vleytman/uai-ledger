import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id} from '../../contracts/src/index.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {createApi} from '../../../apps/api/src/server.js';
import {startScheduler} from '../src/scheduler-loop.js';
import {bullmqWorkerSettings,startBullmqWorker} from '../src/worker.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());

describe('BullMQ worker settings',()=>{
 it('reads the worker environment and keeps a caller default only where the environment is silent',()=>{
  expect(bullmqWorkerSettings({})).toEqual({queues:['text','image','audio','tools','observe','maintenance'],concurrency:4,interactive_reserve:1});
  expect(bullmqWorkerSettings({UAI_WORKER_QUEUES:'maintenance, observe',UAI_WORKER_CONCURRENCY:'2'},{queues:['text'],interactive_reserve:0})).toEqual({queues:['maintenance','observe'],concurrency:2,interactive_reserve:0});
  expect(()=>bullmqWorkerSettings({UAI_WORKER_QUEUES:'text,video'})).toThrow('invalid_execution_queue');
  expect(()=>bullmqWorkerSettings({UAI_WORKER_QUEUES:''})).toThrow('invalid_execution_queue');
  expect(()=>bullmqWorkerSettings({UAI_WORKER_CONCURRENCY:'1.5'})).toThrow('invalid_worker_concurrency');
 });
});

describe.skipIf(!enabled)('BullMQ worker and scheduler as functions',()=>{
 it('run calls through a substituted adapter, keep the paused worker idle and finish the call in hand on close',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,installation=id('worker-fn'),fixture=await seedLoadFixture(pool,1),api=createApi(pool);
  // The substitute answers through the fixture adapter but records every call and holds the first text call.
  const calls:string[]=[];let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});
  const deps=defaultRuntime(pool),base=deps.adapter;
  deps.adapter=async(...args)=>{
   const adapter=await base(...args),execute=adapter.execute.bind(adapter);
   adapter.execute=async(input,context)=>{calls.push(input.capability);if(input.capability==='text.generate'&&calls.filter(c=>c==='text.generate').length===1)await held;return execute(input,context)};
   return adapter;
  };
  const invoke=async(profile:'text.standard'|'image.standard')=>{
   const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invoke')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile,
    ...(profile==='text.standard'?{input:{text:'Substituted provider'},parameters:{max_output_tokens:100}}:{input:{prompt:'Substituted provider'},parameters:{count:1,size:'1024x1024',quality:'standard'}})}});
   expect(response.statusCode,response.body).toBe(202);return response.json().request_id as string;
  };
  const status=async(request:string)=>(await pool.query('SELECT execution_status FROM execution_requests WHERE id=$1',[request])).rows[0].execution_status;
  const heartbeats=async()=>(await pool.query('SELECT queue_kind,state,concurrency,active_jobs FROM execution_worker_heartbeats WHERE installation_id=$1 AND worker_id=$2 ORDER BY queue_kind',[installation,'substitute'])).rows;
  // Dispatch limits must not be what keeps a call waiting here: only the held call and the paused worker may.
  await pool.query('UPDATE execution_dispatch_policies SET account_limit=4,application_limit=4,queue_limit=4,active_account_limit=4');
  const scheduler=startScheduler({pool,backend:'bullmq',installation,redisUrl:process.env.REDIS_URL!,intervalMs:100});
  const worker=startBullmqWorker({pool,installation,redisUrl:process.env.REDIS_URL!,deps,name:'substitute',queues:['text','image','maintenance'],concurrency:2,interactive_reserve:0,heartbeatMs:100});
  try{
   const first=await invoke('text.standard'),second=await invoke('text.standard'),image=await invoke('image.standard');
   await expect.poll(async()=>[await status(second),await status(image)],{timeout:20000}).toEqual(['succeeded','succeeded']);
   expect(await status(first)).toBe('submitting');
   expect(calls.sort()).toEqual(['image.generate','text.generate','text.generate']);
   // Maintenance cycles come and go; the held text call stays in hand.
   await expect.poll(async()=>(await heartbeats()).map(row=>[row.queue_kind,row.state,row.concurrency,row.queue_kind==='maintenance'?'-':row.active_jobs]),{timeout:5000})
    .toEqual([['image','running',2,0],['maintenance','running',2,'-'],['text','running',2,1]]);
   // The maintenance queue of this worker runs the installation's cycles.
   await expect.poll(async()=>(await pool.query('SELECT generation FROM execution_maintenance_cycles WHERE installation_id=$1',[installation])).rows[0]?.generation??0,{timeout:10000}).toBeGreaterThan(1);

   await worker.pause();
   await expect.poll(async()=>(await heartbeats()).map(row=>row.state),{timeout:5000}).toEqual(['draining','draining','draining']);
   const late=await invoke('text.standard');
   // Published to the text queue, yet nobody takes it while the worker is paused.
   await expect.poll(async()=>(await pool.query('SELECT published_at FROM execution_dispatches WHERE request_id=$1',[late])).rows[0].published_at,{timeout:5000}).not.toBeNull();
   await delay(1000);expect(await status(late)).toBe('queued');expect(calls).toHaveLength(3);

   const closing=worker.close();await delay(200);release();await closing;
   expect(await status(first)).toBe('succeeded');
   expect(await heartbeats()).toEqual([
    {queue_kind:'image',state:'stopped',concurrency:2,active_jobs:0},
    {queue_kind:'maintenance',state:'stopped',concurrency:2,active_jobs:0},
    {queue_kind:'text',state:'stopped',concurrency:2,active_jobs:0}]);
   await scheduler.stop();
   // Neither function owns the pool.
   expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  }finally{release();await worker.close();await scheduler.stop()}
 },40000);
});
