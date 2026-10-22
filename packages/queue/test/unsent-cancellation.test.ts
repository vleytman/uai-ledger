import {fork,type ChildProcess} from 'node:child_process';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {transaction} from '../../db/src/index.js';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {createApi} from '../../../apps/api/src/server.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {executeRequest} from '../../execution/src/runtime.js';
import {cancelRequest,expireRequests,prepareDispatch} from '../../execution/src/index.js';
import {ExecutionTransport} from '../src/transport.js';
import {providerAdmission} from '../src/provider-admission.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());
describe.skipIf(!enabled)('Unused provider quota on cancellation',()=>{
 for(const action of ['cancel','deadline'])it(`releases admission without provider execution or charge on ${action}`,async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,url=process.env.REDIS_URL!,installation=`crash_${id('cancel')}`;
  const fixture=await seedLoadFixture(pool,1,1),api=createApi(pool),transport=new ExecutionTransport(installation,url),broker=providerAdmission(pool,url,installation);
  const deps=defaultRuntime(pool);deps.onDelta=undefined;
  Object.assign(deps,{admit:broker.admit,onRateLimits:broker.onRateLimits,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission});
  const messages:any[]=[],faults:string[]=[];let child:ChildProcess|undefined;
  const create=async()=>{
   const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invocation')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'image.standard',input:{prompt:'Synthetic cancel before send'},parameters:{count:1,size:'1024x1024',quality:'standard'}}});
   expect(response.statusCode).toBe(202);return response.json();
  };
  try{
   await pool.query('UPDATE provider_quota_rules SET capacity=1 WHERE group_id IN (SELECT id FROM provider_quota_groups WHERE organization_id=$1)',[fixture.scope.organization_id]);
   const first=await create();
   child=fork(new URL('./fixtures/crash-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:database.url,UAI_CRASH_TEST_ONLY:'1',UAI_CRASH_BOUNDARY:'admitted',UAI_INSTALLATION_ID:installation},stdio:['ignore','ignore','pipe','ipc']});
   child.on('message',message=>messages.push(message));child.on('error',error=>faults.push(error.message));child.stderr?.on('data',chunk=>faults.push(String(chunk)));
   await vi.waitFor(()=>expect(messages.some(m=>m.type==='ready')).toBe(true),{timeout:10000});
   await transport.publish('image',{request_id:first.request_id,generation:0,purpose:'execute'});
   await vi.waitFor(()=>expect(messages.some(m=>m.type==='admitted')).toBe(true),{timeout:10000});
   const admission=(await pool.query('SELECT * FROM dispatch_admissions WHERE request_id=$1',[first.request_id])).rows[0];
   if(action==='cancel')await transaction(pool,tx=>cancelRequest(tx,fixture.scope,systemClock,first.request_id,deps.settle));
   else{
    await pool.query("UPDATE execution_requests SET deadline_at=now()-interval '1 second' WHERE id=$1",[first.request_id]);
    expect(await transaction(pool,tx=>expireRequests(tx,systemClock,deps.settle,fixture.scope))).toBe(1);
   }
   expect(messages.filter(m=>m.type==='provider-called')).toHaveLength(0);
   expect((await pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=$1',[first.request_id])).rows).toEqual([{execution_status:'canceled',settlement_status:'settled',attempt_count:0}]);
   expect((await pool.query('SELECT captured_units,(max_units-captured_units-released_units)::text AS held FROM reservations WHERE operation_id=$1',[first.operation_id])).rows).toEqual([{captured_units:'0',held:'0'}]);
   expect((await pool.query('SELECT unused_at IS NOT NULL AS unused,slot_released_at IS NOT NULL AS released FROM dispatch_admissions WHERE id=$1',[admission.id])).rows).toEqual([{unused:true,released:true}]);
   await expect(transaction(pool,tx=>prepareDispatch(tx,fixture.scope,systemClock,first.request_id,admission.fencing_token,undefined,admission.id))).rejects.toMatchObject({code:'stale_lease'});
   const second=await create();let calls=0;const adapter=deps.adapter;
   deps.adapter=async(...args)=>{const base=await adapter(...args),execute=base.execute.bind(base);base.execute=async(...input)=>{calls++;return execute(...input)};return base};
   expect(await executeRequest(pool,{...deps,limits:{backend:'bullmq',generation:0}},second.request_id)).toMatchObject({worked:true,state:'succeeded'});
   expect(calls).toBe(1);expect(faults).toEqual([]);
   expect((await pool.query('SELECT unused_refunded_at IS NOT NULL AS refunded FROM dispatch_admissions WHERE id=$1',[admission.id])).rows).toEqual([{refunded:true}]);
   expect((await pool.query('SELECT captured_units FROM reservations WHERE operation_id=$1',[second.operation_id])).rows).toEqual([{captured_units:'10000000'}]);
  }finally{
   if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGKILL');await exited}
   await transport.pause();await transport.queue('image').obliterate({force:true});await transport.close();await broker.close();await api.close();vi.unstubAllEnvs();
  }
 },30000);
});
