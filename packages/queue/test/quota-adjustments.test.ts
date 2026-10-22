import {afterAll,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createPool,transaction} from '../../db/src/index.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {enqueue,leaseNext} from '../../execution/src/index.js';
import {recordAdmissionIntent,acquireDurable} from '../src/admission.js';
import {recordAdmissionBundle,acquireAdmissionBundle} from '../src/admission-bundle.js';
import {providerAdmission} from '../src/provider-admission.js';
import {QuotaStore} from '../src/quota.js';
const pool=process.env.DATABASE_URL?createPool():null,url=process.env.REDIS_URL;
afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool||!url)('Confirmed quota excess',()=>{
 it('does not renew expired excess and decrements active provider observations only once',async()=>{
  const store=new QuotaStore(url!,'test',id('quota')),rule={key:'tokens',capacity:100,window_ms:60000};
  try{
   await store.connect();await store.markRestored('epoch');const at=await store.currentTime();
   await store.observe('tokens',20,at-1000,at+60000);
   await store.applyExcess('epoch','extra',{...rule,amount:5},at);await store.applyExcess('epoch','extra',{...rule,amount:5},at);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{used:'5',available:'15',provider:{remaining:'15'}}]});
   await store.applyExcess('epoch','expired',{...rule,amount:50},at-61000);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{used:'5',available:'15'}]});
   await store.closeGate();expect(await store.applyExcess('epoch','blocked',{...rule,amount:1},at)).toBe(false);
   await store.applyExcess('epoch','expired',{...rule,amount:50},at-61000,true);await store.markRestored('epoch');
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{used:'5',available:'15'}]});
  }finally{await store.close()}
 });
 for(const coordinated of [false,true,'multi'] as const)it(`preserves excess across duplicate feedback, lost acknowledgements and Redis loss (${coordinated==='multi'?'multi-group':coordinated?'bundle':'single'})`,async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota'),installation=id('test'),domain=coordinated?id('domain'):null,otherGroup=id('quota');
  for(const g of [group,...(coordinated==='multi'?[otherGroup]:[])]){
  await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,'fake','{}','epoch','synthetic',$3)",[g,scope.organization_id,domain]);
  await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'tokens','tokens',100,60000)",[g]);
  }
  const otherStore=coordinated==='multi'?new QuotaStore(url!,installation,otherGroup,JSON.stringify([scope.organization_id,domain])):null;
  const store=new QuotaStore(url!,installation,group,domain?JSON.stringify([scope.organization_id,domain]):undefined),broker=providerAdmission(pool!,url!,installation);
  const add=async(amount:number)=>{
   const request=await transaction(pool!,tx=>enqueue(tx,scope,systemClock,{operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'test',input_ref:'test',route:{primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(Date.now()+60000)}));
   const lease=await transaction(pool!,tx=>leaseNext(tx,systemClock,'test',{scope,account:20,application:20},undefined,request.id));
   const input={id:id('admission'),group_id:group,request_id:request.id,fence:String(lease.fencing_token),demands:[{key:'tokens',capacity:100,window_ms:60000,amount}]};
   if(coordinated)await recordAdmissionBundle(pool!,`bundle-${input.id}`,[input,...(otherStore?[{...input,id:input.id+'-other',group_id:otherGroup}]:[])]);else await recordAdmissionIntent(pool!,input);
   const result=coordinated?await acquireAdmissionBundle(pool!,url!,installation,`bundle-${input.id}`):await acquireDurable(pool!,store,input);
   return {input,result};
  };
  try{
   await store.connect();await otherStore?.connect();const first=await add(40);expect(first.result.allowed).toBe(true);
   const report=(tokens:number)=>broker.onProviderResult(scope,{id:first.input.request_id},{quota_admission_id:first.input.id},{outcome:'success',output:{content_type:'text/plain'},usage:{state:'unknown',reason:'cache split missing'},limit_usage:{requests:1,tokens}});
   await Promise.all([report(80),report(80)]);
   expect(await store.snapshot('epoch',first.input.demands)).toMatchObject({ready:true,rules:[{used:'80',available:'20'}]});
   expect((await add(21)).result).toMatchObject({allowed:false,reason:'limited'});
   const original=QuotaStore.prototype.applyExcess;
   const lost=vi.spyOn(QuotaStore.prototype,'applyExcess').mockImplementationOnce(async function(this:QuotaStore,...args){await original.apply(this,args);throw new Error('lost Redis acknowledgement')});
   try{await expect(report(90)).rejects.toThrow('lost Redis acknowledgement')}finally{lost.mockRestore()}
   await report(90);await report(50);
   expect(await store.snapshot('epoch',first.input.demands)).toMatchObject({ready:true,rules:[{used:'90',available:'10'}]});
   expect((await pool!.query('SELECT delta_units::text,reported_units::text,applied_at IS NOT NULL AS applied FROM quota_usage_adjustments WHERE group_id=$1 ORDER BY reported_units',[group])).rows).toEqual([{delta_units:'40',reported_units:'80',applied:true},{delta_units:'10',reported_units:'90',applied:true}]);
   const unavailable=vi.spyOn(QuotaStore.prototype,'applyExcess').mockRejectedValueOnce(new Error('Redis unavailable'));
   try{await expect(report(95)).rejects.toThrow('Redis unavailable')}finally{unavailable.mockRestore()}
   expect((await pool!.query('SELECT delta_units::text FROM quota_usage_adjustments WHERE group_id=$1 AND applied_at IS NULL',[group])).rows).toEqual([{delta_units:'5'}]);
   // A new admission must flush committed excess before checking availability.
   expect((await add(6)).result).toMatchObject({allowed:false,reason:'limited'});
   expect(await store.snapshot('epoch',first.input.demands)).toMatchObject({ready:true,rules:[{used:'95',available:'5'}]});
   // A maintenance mistake must not alter the facts used after Redis loss.
   for(const change of ["id=id||'-changed'","group_id=group_id||'-changed'","admission_id=admission_id||'-changed'","rule_key='other'","reported_units=reported_units+1","delta_units=delta_units+1","window_ms=window_ms+1","observed_at=observed_at+interval '1 minute'"]){
    await expect(pool!.query(`UPDATE quota_usage_adjustments SET ${change} WHERE group_id=$1`,[group])).rejects.toThrow('quota_adjustment_facts_immutable');
   }
   // Delivery metadata remains writable; replay must still be idempotent.
   await pool!.query('UPDATE quota_usage_adjustments SET applied_at=NULL WHERE group_id=$1',[group]);
   await report(95);
   expect(await store.snapshot('epoch',first.input.demands)).toMatchObject({ready:true,rules:[{used:'95',available:'5'}]});
   // Lose only this test namespace. Admission must restore estimates AND excess.
   const tag=createHash('sha256').update(JSON.stringify([installation,domain?JSON.stringify([scope.organization_id,domain]):group])).digest('hex');const keys=await store.redis.keys(`uai-quota:{${tag}}:*`);await store.redis.del(...keys);
   expect((await add(6)).result).toMatchObject({allowed:false,reason:'limited'});
   expect(await store.snapshot('epoch',first.input.demands)).toMatchObject({ready:true,rules:[{used:'95',available:'5'}]});
   if(otherStore)expect(await otherStore.snapshot('epoch',first.input.demands)).toMatchObject({ready:true,rules:[{used:'95',available:'5'}]});
   expect((await add(5)).result.allowed).toBe(true);
   expect((await pool!.query('SELECT demands FROM dispatch_admissions WHERE id=$1',[first.input.id])).rows[0].demands).toEqual(first.input.demands);
  }finally{await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);await broker.close();await store.close();await otherStore?.close()}
 });
});
