import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {id,systemClock} from '../../../packages/contracts/src/index.js';
import {ConnectionService} from '../../../packages/reconciliation/src/connections.js';
import {configureBudget,enqueue,leaseNext,prepareDispatch} from '../../../packages/execution/src/index.js';
import {recordAdmissionBundle,acquireAdmissionBundle} from '../../../packages/queue/src/admission-bundle.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
async function fixture(){
 const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
 const setup=await transaction(pool!,async tx=>{
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
  const token=(scopes:string[],account_ids:string[]|null=null)=>issueToken(tx,{...scope,scopes,account_ids,max_grant_units:null,expires_at:null});
  const tokens={admin:await token(['operations:admin','config:write']),read:await token(['operations:admin']),restricted:await token(['operations:admin','config:write'],[scope.account_id])};
  const connection=await new ConnectionService(tx,systemClock).create(scope,{provider:'fake',name:'Binding test',account_scope:{fixture:'test'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'test',reason:'Quota binding verification'});
  await tx.query(`INSERT INTO configuration_versions(id,organization_id,application_id,kind,key,version,status,payload,author,comment,created_at,published_at)
   VALUES($1,$2,$3,'catalog','fixture',1,'published',$4,'test','test',now(),now())`,[id('catalog'),scope.organization_id,scope.application_id,{models:[{id:'fake-model',provider:'fake',status:'active',capabilities:['text.generate'],allowed_parameters:[]}]}]);
  const groups:string[]=[];
  for(const [provider,domain,organization] of [['fake','account',scope.organization_id],['fake','account',scope.organization_id],['other','account',scope.organization_id],['fake','different',scope.organization_id],['fake','account',id('foreign')]]){
   const group=id('quota');groups.push(group);
   await tx.query(`INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,$3,'{}','epoch','synthetic',$4)`,[group,organization,provider,domain]);
   await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',100,60000)",[group]);
  }
  return {tokens,connection,groups};
 });
 const app=createApi(pool!),url='/v1/admin/provider-quota-bindings',auth={authorization:`Bearer ${setup.tokens.admin.token}`};
 const read=(extra={},model='fake-model')=>app.inject({method:'GET',url:`${url}?connection_id=${setup.connection.id}&model=${model}`,headers:{...auth,...extra}});
 const write=(revision:string,groups:string[],key=id('cmd'),extra={},model='fake-model')=>app.inject({method:'PUT',url,headers:{...auth,'idempotency-key':key,...extra},payload:{connection_id:setup.connection.id,model,bindings_revision:revision,group_ids:groups,reason:'Update synthetic bindings'}});
 return {...setup,scope,app,read,write};
}
describe.skipIf(!pool)('Quota route bindings API',()=>{
 it('validates ownership, published models, providers, domains and optimistic concurrency',async()=>{
  const f=await fixture();
  try{
   const empty=await f.read();expect(empty.statusCode).toBe(200);expect(empty.json().groups).toEqual([]);const revision=empty.json().bindings_revision;
   expect((await f.read({authorization:`Bearer ${f.tokens.restricted.token}`})).statusCode).toBe(403);
   expect((await f.write(revision,[f.groups[0]],id('cmd'),{authorization:`Bearer ${f.tokens.read.token}`})).statusCode).toBe(403);
   const bad=await f.write(revision,[f.groups[4]]);expect(bad.statusCode).toBe(404);
   expect((await f.write(revision,[f.groups[2]])).json().error.code).toBe('quota_provider_mismatch');
   expect((await f.write(revision,[f.groups[0],f.groups[3]])).json().error.code).toBe('quota_domains_must_match');
   expect((await f.write(revision,[f.groups[0],f.groups[0]])).statusCode).toBe(422);
   const missing=(await f.read({},'missing-model')).json();expect((await f.write(missing.bindings_revision,[f.groups[0]],id('cmd'),{},'missing-model')).json().error.code).toBe('quota_model_not_published');
   await pool!.query(`UPDATE provider_quota_groups SET scope='{"capability":"image.generate"}' WHERE id=$1`,[f.groups[0]]);
   expect((await f.write(revision,[f.groups[0]])).json().error.code).toBe('quota_capability_mismatch');
   await pool!.query("UPDATE provider_quota_groups SET scope='{}' WHERE id=$1",[f.groups[0]]);
   await pool!.query('DELETE FROM provider_quota_rules WHERE group_id=$1',[f.groups[1]]);
   expect((await f.write(revision,[f.groups[1]])).json().error.code).toBe('quota_rules_missing');
   await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',100,60000)",[f.groups[1]]);
   const key=id('cmd'),first=await f.write(revision,[f.groups[0]],key);expect(first.statusCode).toBe(200);
   expect((await f.write(revision,[f.groups[0]],key)).json()).toEqual(first.json());
   expect((await f.write(revision,[f.groups[1]])).statusCode).toBe(409);
   const both=await Promise.all([f.write(first.json().bindings_revision,[f.groups[0],f.groups[1]]),f.write(first.json().bindings_revision,[])]);
   expect(both.map(r=>r.statusCode).sort()).toEqual([200,409]);
   expect((await pool!.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='quota.bindings.updated'",[f.scope.organization_id])).rows).toHaveLength(2);
   const foreign=await transaction(pool!,async tx=>{
    const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
    return issueToken(tx,{...scope,scopes:['operations:admin','config:write'],account_ids:null,max_grant_units:null,expires_at:null});
   });
   expect((await f.read({authorization:`Bearer ${foreign.token}`})).statusCode).toBe(404);
   const sibling=await transaction(pool!,async tx=>{
    const application=id('app');await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[application,f.scope.organization_id]);
    return issueToken(tx,{...f.scope,application_id:application,scopes:['operations:admin','config:write'],account_ids:null,max_grant_units:null,expires_at:null});
   });
   expect((await f.read({authorization:`Bearer ${sibling.token}`})).statusCode).toBe(404);
   expect((await f.write(revision,[f.groups[0]],id('cmd'),{authorization:`Bearer ${sibling.token}`})).statusCode).toBe(404);

  }finally{await f.app.close()}
 });
 it.skipIf(!process.env.REDIS_URL)('invalidates unsent proof on additive binding and prevents resetting consumed quotas by replacement',async()=>{
  const f=await fixture();let requestId:string|undefined;
  try{
   const revision=(await f.read()).json().bindings_revision;
   const bound=await f.write(revision,[f.groups[0]]);expect(bound.statusCode).toBe(200);
   const request=await transaction(pool!,async tx=>{
    await configureBudget(tx,f.scope,'provider',f.connection.id,'0');await configureBudget(tx,f.scope,'period','test','0');
    return enqueue(tx,f.scope,systemClock,{operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'test',input_ref:'test',route:{primary:{connection_id:f.connection.id,model:'fake-model',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(Date.now()+60000)});
   });requestId=request.id;
   const lease=await transaction(pool!,tx=>leaseNext(tx,systemClock,'worker',{scope:f.scope},undefined,request.id));
   const input={id:id('admission'),group_id:f.groups[0],request_id:request.id,fence:String(lease.fencing_token),demands:[{key:'requests',capacity:100,amount:1,window_ms:60000}]},bundle=id('bundle');
   await recordAdmissionBundle(pool!,bundle,[input]);expect((await acquireAdmissionBundle(pool!,process.env.REDIS_URL!,'binding-test',bundle)).allowed).toBe(true);
   await pool!.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=$1",[request.id]);
   const added=await f.write(bound.json().bindings_revision,[f.groups[0],f.groups[1]]);expect(added.statusCode).toBe(200);
   await expect(transaction(pool!,tx=>prepareDispatch(tx,f.scope,systemClock,request.id,input.fence,undefined,input.id))).rejects.toMatchObject({code:'quota_admission_invalid'});
   expect((await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[request.id])).rows).toEqual([]);
   const blocked=await f.write(added.json().bindings_revision,[f.groups[1]]);expect(blocked.statusCode).toBe(409);expect(blocked.json().error.code).toBe('quota_binding_usage_active');
   expect((await f.read()).json().groups).toHaveLength(2);
   // A finished call's recent window is protected even after its concurrency slot was released.
   await pool!.query('UPDATE dispatch_admissions SET slot_released_at=now() WHERE id=$1',[input.id]);
   expect((await f.write(added.json().bindings_revision,[f.groups[1]])).json().error.code).toBe('quota_binding_usage_active');
   await pool!.query("UPDATE dispatch_admissions SET admitted_at=now()-interval '2 minutes' WHERE id=$1",[input.id]);
   expect((await f.write(added.json().bindings_revision,[f.groups[1]])).statusCode).toBe(200);
   expect((await pool!.query('SELECT route,max_units FROM execution_requests WHERE id=$1',[request.id])).rows[0]).toEqual({route:request.route,max_units:request.max_units});
  }finally{if(requestId)await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE id=$1",[requestId]);await f.app.close()}
 });
});
