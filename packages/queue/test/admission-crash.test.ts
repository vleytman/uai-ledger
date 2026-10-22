import {fork,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {transaction} from '../../db/src/index.js';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {createApi} from '../../../apps/api/src/server.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {executeRequest} from '../../execution/src/runtime.js';
import {recoverExpiredLeases,prepareDispatch} from '../../execution/src/index.js';
import {ExecutionTransport} from '../src/transport.js';
import {providerAdmission} from '../src/provider-admission.js';
import {QuotaStore} from '../src/quota.js';
import {refundUnusedAdmissions} from '../src/unused-admissions.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL);
const enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});
afterAll(()=>database.close());
describe.skipIf(!enabled)('Worker crash before submission intent',()=>{
 for(const boundary of ['intent','redis-admitted','admitted'])for(const bundle of [false,true])for(const loseRedis of [false,true])it(`reclaims unused quota and executes once after duplicate delivery (${boundary}, ${bundle?'bundle':'single'}, Redis loss ${loseRedis})`,async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,installation=`crash_${id('admission')}`,url=process.env.REDIS_URL!;
  const fixture=await seedLoadFixture(pool,1,1),api=createApi(pool),transport=new ExecutionTransport(installation,url),broker=providerAdmission(pool,url,installation);
  const messages:any[]=[],faults:string[]=[];let child:ChildProcess|undefined;
  try{
   if(bundle){
    const domain=id('domain'),extra=id('quota');
    const original=(await pool.query("SELECT g.*,b.connection_id FROM provider_quota_groups g JOIN provider_quota_bindings b ON b.group_id=g.id WHERE g.organization_id=$1 AND b.model='fake-image'",[fixture.scope.organization_id])).rows[0];
    await pool.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[original.id,domain]);
    await pool.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,concurrency_limit,coordination_domain) VALUES($1,$2,$1,'fake','{}','load','synthetic',1,$3)",[extra,fixture.scope.organization_id,domain]);
    await pool.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',100000,60000)",[extra]);
    await pool.query("INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,'fake-image',$2)",[original.connection_id,extra]);
   }
   // One request per window: an unused admission must not consume the retry's RPM.
   await pool.query('UPDATE provider_quota_rules SET capacity=1 WHERE group_id IN (SELECT id FROM provider_quota_groups WHERE organization_id=$1)',[fixture.scope.organization_id]);
   const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invocation')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'image.standard',input:{prompt:'Synthetic pre-submission crash'},parameters:{count:1,size:'1024x1024',quality:'standard'}}});
   expect(response.statusCode).toBe(202);const {request_id,operation_id}=response.json();
   child=fork(new URL('./fixtures/crash-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:database.url,UAI_CRASH_TEST_ONLY:'1',UAI_CRASH_BOUNDARY:boundary,UAI_INSTALLATION_ID:installation},stdio:['ignore','ignore','pipe','ipc']});
   child.on('message',message=>messages.push(message));child.on('error',error=>faults.push(error.message));child.stderr?.on('data',chunk=>faults.push(String(chunk)));
   await vi.waitFor(()=>expect(messages.some(m=>m.type==='ready')).toBe(true),{timeout:10000});
   const delivery={request_id,generation:0,purpose:'execute' as const};await transport.publish('image',delivery);
   await vi.waitFor(()=>expect(messages.some(m=>m.type===boundary)).toBe(true),{timeout:10000});
   expect(messages.filter(m=>m.type==='provider-called')).toHaveLength(0);
   expect((await pool.query('SELECT id FROM execution_attempts WHERE request_id=$1',[request_id])).rows).toEqual([]);
   const entries=(await pool.query("SELECT id,state FROM dispatch_admissions WHERE request_id=$1 AND slot_released_at IS NULL",[request_id])).rows;
   expect(entries.every(row=>row.state===(boundary==='admitted'?'admitted':'intent'))).toBe(true);
   const original=entries.map(r=>r.id);
   const oldFence=(await pool.query('SELECT fencing_token FROM execution_requests WHERE id=$1',[request_id])).rows[0].fencing_token;
   expect(original).toHaveLength(bundle?2:1);
   const exited=new Promise(resolve=>child!.once('exit',(code,signal)=>resolve({code,signal})));child.kill('SIGKILL');expect(await exited).toEqual({code:null,signal:'SIGKILL'});
   await pool.query("UPDATE execution_requests SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[request_id]);
   expect(await transaction(pool,tx=>recoverExpiredLeases(tx,systemClock,fixture.scope))).toBe(1);
   expect((await pool.query('SELECT slot_released_at IS NOT NULL AS released FROM dispatch_admissions WHERE id=ANY($1::text[])',[original])).rows).toEqual(original.map(()=>({released:true})));
   await expect(transaction(pool,tx=>prepareDispatch(tx,fixture.scope,systemClock,request_id,oldFence,undefined,original[0]))).rejects.toMatchObject({code:'stale_lease'});
   await expect(pool.query('UPDATE dispatch_admissions SET unused_at=NULL WHERE id=ANY($1::text[])',[original])).rejects.toThrow('unused_admission_proof_immutable');
   const groups=(await pool.query('SELECT DISTINCT g.* FROM provider_quota_groups g JOIN dispatch_admissions a ON a.group_id=g.id WHERE a.request_id=$1',[request_id])).rows;
   for(const group of groups){
    const domain=group.coordination_domain?JSON.stringify([group.organization_id,group.coordination_domain]):undefined;
    const store=new QuotaStore(url,installation,group.id,domain);await store.connect();
    try{
     if(loseRedis){
      const tag=createHash('sha256').update(JSON.stringify([installation,domain??group.id])).digest('hex');
      const keys=await store.redis.keys(`uai-quota:{${tag}}*`);if(keys.length)await store.redis.del(...keys);
     }else if(!bundle){
      const discard=QuotaStore.discardUnsentMany;
      const lost=vi.spyOn(QuotaStore,'discardUnsentMany').mockImplementationOnce(async inputs=>{await discard(inputs);throw new Error('lost refund acknowledgement')});
      try{await expect(transaction(pool,async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8192))',[group.id]);await refundUnusedAdmissions(tx,store,group)})).rejects.toThrow('lost refund acknowledgement')}
      finally{lost.mockRestore()}
      expect((await pool.query('SELECT unused_refunded_at FROM dispatch_admissions WHERE id=ANY($1::text[])',[original])).rows).toEqual([{unused_refunded_at:null}]);
      expect(await store.snapshot(group.recovery_epoch,[{key:'requests',capacity:1,window_ms:60000}])).toMatchObject({ready:true,rules:[{used:'0',available:'1'}]});
     }
    }finally{await store.close()}
   }
   let calls=0,handled=0;const deps=defaultRuntime(pool),getAdapter=deps.adapter;deps.onDelta=undefined;
   deps.adapter=async(...args)=>{const adapter=await getAdapter(...args),execute=adapter.execute.bind(adapter);adapter.execute=async(...input)=>{calls++;return execute(...input)};return adapter};
   Object.assign(deps,{admit:broker.admit,onRateLimits:broker.onRateLimits,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission});
   transport.consume('image',1,async duplicate=>{await executeRequest(pool,{...deps,limits:{backend:'bullmq',generation:duplicate.generation}},duplicate.request_id);handled++},error=>faults.push(error.message));
   for(let n=0;n<2;n++)await transport.queue('image').add('duplicate',delivery,{jobId:id('duplicate')});
   await vi.waitFor(()=>expect(handled).toBe(2),{timeout:10000});
   expect(calls).toBe(1);expect(faults).toEqual([]);
   expect((await pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=$1',[request_id])).rows).toEqual([{execution_status:'succeeded',settlement_status:'settled',attempt_count:1}]);
   expect((await pool.query('SELECT cost_units,charged_units FROM execution_attempts WHERE request_id=$1',[request_id])).rows).toEqual([{cost_units:'10000000',charged_units:'10000000'}]);
   expect((await pool.query('SELECT captured_units,(max_units-captured_units-released_units)::text AS held FROM reservations WHERE operation_id=$1',[operation_id])).rows).toEqual([{captured_units:'10000000',held:'0'}]);
   expect((await pool.query('SELECT unused_refunded_at IS NOT NULL AS refunded FROM dispatch_admissions WHERE id=ANY($1::text[])',[original])).rows).toEqual(original.map(()=>({refunded:true})));
   for(const group of groups){
    const store=new QuotaStore(url,installation,group.id,group.coordination_domain?JSON.stringify([group.organization_id,group.coordination_domain]):undefined);await store.connect();
    try{expect(await store.snapshot(group.recovery_epoch,[{key:'requests',capacity:1,window_ms:60000}])).toMatchObject({ready:true,rules:[{used:'1',available:'0'}]})}finally{await store.close()}
   }
  }finally{
   if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGKILL');await exited}
   await transport.pause();await transport.queue('image').obliterate({force:true});await transport.close();await broker.close();await api.close();vi.unstubAllEnvs();
  }
 },30000);
});
