import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {isolatedTestDatabase} from '../../../packages/db/test/isolated-database.js';
import {id} from '../../../packages/contracts/src/index.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {UaiClient} from '../../../packages/sdk/src/index.js';
import {startScheduler} from '../../../packages/queue/src/scheduler-loop.js';
import {startBullmqWorker} from '../../../packages/queue/src/worker.js';
import {defaultRuntime} from '../../../packages/execution/src/default-runtime.js';
import {createApi} from './server.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());
const quantile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]!;

describe.skipIf(!enabled)('invocation latency',()=>{
 it('delivers the result of an instant call to ai.run on the request\'s own commit, without the stream poll',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  // The fallback poll is a minute here: only the request's own wake-up can deliver a result in time.
  vi.stubEnv('UAI_STREAM_POLL_MS','60000');
  const pool=database.pool!,installation=id('latency'),fixture=await seedLoadFixture(pool,1);
  await pool.query('UPDATE execution_admission_policies SET account_limit=100000,application_limit=100000').catch(()=>{});
  const app=createApi(pool);await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address() as {port:number},client=new UaiClient({baseUrl:`http://127.0.0.1:${address.port}`,token:fixture.token});
  const scheduler=startScheduler({pool,backend:'bullmq',installation,redisUrl:process.env.REDIS_URL!,intervalMs:1000});
  // A test provider that answers at once and does not stream, like a fast fixture provider.
  const deps=defaultRuntime(pool),base=deps.adapter;
  deps.adapter=async(...args)=>{const adapter=await base(...args),execute=adapter.execute.bind(adapter);adapter.execute=(input,context)=>execute(input,{...context,onDelta:undefined});return adapter};
  const worker=startBullmqWorker({pool,installation,redisUrl:process.env.REDIS_URL!,deps,name:'latency',queues:['text','maintenance'],concurrency:4,heartbeatMs:60000});
  try{
   const run=async(n:number)=>{
    let accepted=0;const started=performance.now();
    const result=await client.ai.run({account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:`Instant ${n}`},parameters:{max_output_tokens:100}},{key:id('run'),onAccepted:async()=>{accepted=performance.now()-started}});
    expect(result.execution_status).toBe('succeeded');
    return {accepted,result:performance.now()-started,request:result.id,received:Date.now()};
   };
   for(let n=0;n<5;n++)await run(n);
   const calls=[];for(let n=0;n<100;n++)calls.push(await run(n));
   // From the commit that made the call final to the moment ai.run has its result.
   const finished=new Map((await pool.query('SELECT r.id,a.finished_at FROM execution_requests r JOIN execution_attempts a ON a.request_id=r.id AND a.number=r.attempt_count WHERE r.id=ANY($1::text[])',[calls.map(c=>c.request)])).rows.map(row=>[row.id,new Date(row.finished_at).getTime()]));
   const delivery=calls.map(c=>c.received-finished.get(c.request)!);
   const report={calls:calls.length,delivery_median_ms:Math.round(quantile(delivery,0.5)),delivery_p90_ms:Math.round(quantile(delivery,0.9)),accepted_median_ms:Math.round(quantile(calls.map(c=>c.accepted),0.5)),result_median_ms:Math.round(quantile(calls.map(c=>c.result),0.5)),result_p90_ms:Math.round(quantile(calls.map(c=>c.result),0.9)),result_max_ms:Math.round(Math.max(...calls.map(c=>c.result)))};
   await mkdir('.data/test-reports',{recursive:true});await writeFile('.data/test-reports/invocation-latency.json',JSON.stringify(report,null,2)+'\n');
   // About 20 ms from the commit on a quiet machine; never anywhere near the minute-long poll.
   expect(Math.max(...delivery)).toBeLessThan(10000);
  }finally{await worker.close();await scheduler.stop();await app.close()}
 },180000);
});
