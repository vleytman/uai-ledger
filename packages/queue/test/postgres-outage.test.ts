import {describe,it,expect,vi} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {createApi} from '../../../apps/api/src/server.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {executeRequest} from '../../execution/src/runtime.js';
import {recoverExpiredLeases} from '../../execution/src/index.js';
import {ExecutionTransport} from '../src/transport.js';
import {providerAdmission} from '../src/provider-admission.js';
import {relayOne,reconcileDeliveries} from '../src/relay.js';
import {dedicatedRedis} from './fixtures/dedicated-redis.js';
import {dedicatedPostgres} from './fixtures/dedicated-postgres.js';

describe.skipIf(process.env.UAI_TEST_POSTGRES_OUTAGE!=='1')('Complete PostgreSQL outage',()=>{
 it('stops new sends, retains submitted uncertainty and recovers a failed unsent delivery',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');vi.stubEnv('UAI_DB_CONNECT_TIMEOUT_MS','500');
  const postgres=await dedicatedPostgres();
  let redis:Awaited<ReturnType<typeof dedicatedRedis>>|undefined,transport:ExecutionTransport|undefined,broker:ReturnType<typeof providerAdmission>|undefined;
  const pool=createPool(postgres.url),api=createApi(pool);
  try{
   redis=await dedicatedRedis();const fixture=await seedLoadFixture(pool,1),installation=id('pg-outage');
   transport=new ExecutionTransport(installation,redis.url);broker=providerAdmission(pool,redis.url,installation);
   const invoke=async(key=id('invoke'))=>api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':key},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:'Synthetic database outage'},parameters:{max_output_tokens:100}}});
   const first=await invoke(),second=await invoke();expect(first.statusCode,first.body).toBe(202);expect(second.statusCode,second.body).toBe(202);
   const active=first.json(),pending=second.json();
   expect(await relayOne(pool,transport)).toBe(true);expect(await relayOne(pool,transport)).toBe(true);
   let providerCalls=0,stopOnNext=true;const failures:string[]=[],handled:string[]=[];
   const deps=defaultRuntime(pool),adapter=deps.adapter;deps.onDelta=undefined;
   deps.adapter=async(...args)=>{const base=await adapter(...args),execute=base.execute.bind(base);base.execute=async(...input)=>{
    providerCalls++;const result=await execute(...input);if(stopOnNext){stopOnNext=false;await postgres.stop()}return result;
   };return base};
   Object.assign(deps,{admit:broker.admit,onRateLimits:broker.onRateLimits,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission});
   const worker=transport.consume('text',1,async delivery=>{const result=await executeRequest(pool,{...deps,limits:{backend:'bullmq',generation:delivery.generation}},delivery.request_id);handled.push(delivery.request_id);return result},()=>{});
   worker.on('failed',job=>{if(job)failures.push(job.data.request_id)});
   await expect.poll(()=>failures.length,{timeout:10000}).toBe(2);
   expect(providerCalls).toBe(1);expect(handled).toEqual([]);
   const retryKey=id('outage-invoke'),unavailable=await invoke(retryKey);
   expect(unavailable.statusCode).toBe(503);expect(unavailable.json().error).toMatchObject({code:'platform_unavailable',retryable:true});
   await expect(relayOne(pool,transport)).rejects.toBeDefined();expect(providerCalls).toBe(1);
   await postgres.start();expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
   expect((await pool.query('SELECT count(*)::int n FROM execution_requests')).rows[0].n).toBe(2);
   const request=(await pool.query('SELECT execution_status,attempt_count FROM execution_requests WHERE id=$1',[active.request_id])).rows[0];
   expect(request.attempt_count).toBe(1);expect(['submitting','running']).toContain(request.execution_status);
   await pool.query("UPDATE execution_requests SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[active.request_id]);
   expect(await transaction(pool,tx=>recoverExpiredLeases(tx,systemClock,fixture.scope))).toBe(1);
   expect((await pool.query('SELECT execution_status,settlement_status FROM execution_requests WHERE id=$1',[active.request_id])).rows[0]).toEqual({execution_status:'outcome_unknown',settlement_status:'unresolved'});
   const reservation=(await pool.query('SELECT captured_units,(max_units-captured_units-released_units)::text held FROM reservations WHERE operation_id=$1',[active.operation_id])).rows[0];
   expect(reservation.captured_units).toBe('0');expect(BigInt(reservation.held)).toBeGreaterThan(0n);
   expect(await reconcileDeliveries(pool,transport)).toBe(1);expect(await relayOne(pool,transport)).toBe(true);
   await expect.poll(()=>handled.includes(pending.request_id),{timeout:10000}).toBe(true);
   // Even a duplicate submitted request cannot authorize another send after PostgreSQL returns.
   await transport.queue('text').add('duplicate',{request_id:active.request_id,generation:0,purpose:'execute'},{jobId:id('duplicate')});
   await expect.poll(()=>handled.includes(active.request_id),{timeout:5000}).toBe(true);
   expect(providerCalls).toBe(2);
   expect((await pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=$1',[pending.request_id])).rows[0]).toEqual({execution_status:'succeeded',settlement_status:'settled',attempt_count:1});
   expect((await pool.query('SELECT count(*)::int n FROM execution_attempts')).rows[0].n).toBe(2);
   const retry=await invoke(retryKey);expect(retry.statusCode,retry.body).toBe(202);
   expect((await pool.query('SELECT count(*)::int n FROM execution_requests')).rows[0].n).toBe(3);
   expect(providerCalls).toBe(2);
  }finally{await transport?.close();await broker?.close();await api.close();await pool.end();await redis?.close();await postgres.close();vi.unstubAllEnvs()}
 },90000);
});
