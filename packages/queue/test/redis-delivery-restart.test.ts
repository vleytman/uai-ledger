import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id} from '../../contracts/src/index.js';
import {createApi} from '../../../apps/api/src/server.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {executeRequest} from '../../execution/src/runtime.js';
import {ExecutionTransport} from '../src/transport.js';
import {providerAdmission} from '../src/provider-admission.js';
import {relayOne,reconcileDeliveries} from '../src/relay.js';
import {dedicatedRedis} from './fixtures/dedicated-redis.js';
const enabled=process.env.UAI_TEST_REDIS_RESTART==='1'&&!!process.env.DATABASE_URL;
const database=isolatedTestDatabase(process.env.DATABASE_URL);
beforeAll(async()=>{if(enabled)await database.initialize()});
afterAll(()=>database.close());
describe.skipIf(!enabled)('BullMQ recovery after actual Redis data loss',()=>{
 for(const mode of ['rollback','empty'] as const)it(`restores pending requests after ${mode} without repeating settled requests`,async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const redis=await dedicatedRedis(),pool=database.pool!,installation=id('queue-fault'),fixture=await seedLoadFixture(pool,1),api=createApi(pool);
  let transport=new ExecutionTransport(installation,redis.url),broker=providerAdmission(pool,redis.url,installation);
  let providerCalls=0;const faults:string[]=[],handled:string[]=[];
  const runtime=()=>{
   const deps=defaultRuntime(pool),adapter=deps.adapter;deps.onDelta=undefined;
   deps.adapter=async(...args)=>{const base=await adapter(...args),execute=base.execute.bind(base);base.execute=async(...call)=>{providerCalls++;return execute(...call)};return base};
   return {...deps,admit:broker.admit,onRateLimits:broker.onRateLimits,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission};
  };
  const invoke=async()=>{
   const result=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invoke')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:'Synthetic Redis recovery'},parameters:{max_output_tokens:100}}});
   expect(result.statusCode,result.body).toBe(202);return result.json() as {request_id:string;operation_id:string};
  };
  try{
   const completed=await invoke(),pending=await invoke();
   expect(await relayOne(pool,transport)).toBe(true);expect(await relayOne(pool,transport)).toBe(true);
   // Persist two waiting jobs. PostgreSQL will later settle the first, leaving a stale job in this snapshot.
   await transport.close();await broker.close();await redis.checkpoint();
   transport=new ExecutionTransport(installation,redis.url);broker=providerAdmission(pool,redis.url,installation);
   expect(await executeRequest(pool,{...runtime(),limits:{backend:'bullmq',generation:0}},completed.request_id)).toMatchObject({worked:true,state:'succeeded'});
   const chargeBefore=(await pool.query('SELECT captured_units FROM reservations WHERE operation_id=$1',[completed.operation_id])).rows[0].captured_units;
   expect(BigInt(chargeBefore)).toBeGreaterThan(0n);
   const lost=await invoke();expect(await relayOne(pool,transport)).toBe(true);
   await transport.close();await broker.close();await redis.lose(mode);
   transport=new ExecutionTransport(installation,redis.url);broker=providerAdmission(pool,redis.url,installation);
   expect(await transport.queue('text').getWaitingCount()).toBe(mode==='rollback'?2:0);
   expect(await reconcileDeliveries(pool,transport)).toBe(mode==='rollback'?1:2);
   while(await relayOne(pool,transport));
   expect(await transport.queue('text').getWaitingCount()).toBe(mode==='rollback'?3:2);
   const deps=runtime(),worker=transport.consume('text',3,async delivery=>{
    const result=await executeRequest(pool,{...deps,limits:{backend:'bullmq',generation:delivery.generation}},delivery.request_id);
    if(delivery.request_id===completed.request_id)expect(result).toEqual({worked:false});
    handled.push(delivery.request_id);return result;
   },error=>faults.push(error.message));
   worker.on('failed',(_job,error)=>faults.push(error.message));
   await expect.poll(()=>handled.length,{timeout:10000}).toBe(mode==='rollback'?3:2);
   await transport.close();
   expect(providerCalls).toBe(3);expect(faults).toEqual([]);
   const ids=[completed.request_id,pending.request_id,lost.request_id];
   expect((await pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=ANY($1::text[])',[ids])).rows).toEqual(Array.from({length:3},()=>({execution_status:'succeeded',settlement_status:'settled',attempt_count:1})));
   expect((await pool.query('SELECT count(*)::int n FROM execution_attempts WHERE request_id=ANY($1::text[])',[ids])).rows[0].n).toBe(3);
   expect((await pool.query('SELECT captured_units FROM reservations WHERE operation_id=$1',[completed.operation_id])).rows[0].captured_units).toBe(chargeBefore);
   expect(await reconcileDeliveries(pool,transport)).toBe(0);
  }finally{await transport.close().catch(()=>{});await broker.close();await api.close();await redis.close();vi.unstubAllEnvs()}
 },60000);
});
