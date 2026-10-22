import {createHash} from 'node:crypto';
import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {id,systemClock} from '../../../packages/contracts/src/index.js';
import {enqueue,leaseNext} from '../../../packages/execution/src/index.js';
import {assertQuotaProof} from '../../../packages/execution/src/quota-proof.js';
import {recordAdmissionIntent,acquireDurable} from '../../../packages/queue/src/admission.js';
import {recordAdmissionBundle,acquireAdmissionBundle} from '../../../packages/queue/src/admission-bundle.js';
import {QuotaStore} from '../../../packages/queue/src/quota.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool||!process.env.REDIS_URL)('Quota rule capacity revisions',()=>{
 for(const coordinated of [false,true])it(`retains consumption and issued proof across rule edits (${coordinated?'bundle':'single'})`,async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota'),connection=id('conn'),installation=id('limits'),domain=coordinated?id('domain'):null;
  const tokens=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
   await tx.query("INSERT INTO provider_connections(id,organization_id,application_id,provider,name,account_scope,capabilities,limits,risk_policy,created_at,updated_at) VALUES($1,$2,$3,'fake','Fixture','{}','{}','{}','{}',now(),now())",[connection,scope.organization_id,scope.application_id]);
   await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,'fake','{}','test','synthetic',$3)",[group,scope.organization_id,domain]);
   await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'rpm','requests',100,60000)",[group]);
   await tx.query("INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,'fake',$2)",[connection,group]);
   const token=(scopes:string[])=>issueToken(tx,{...scope,scopes,account_ids:null,max_grant_units:null,expires_at:null});
   return {admin:await token(['operations:admin','config:write']),read:await token(['operations:admin'])};
  });
  const app=createApi(pool!),store=new QuotaStore(process.env.REDIS_URL!,installation,group,domain?JSON.stringify([scope.organization_id,domain]):undefined);await store.connect();
  const acquire=(input:Parameters<typeof acquireDurable>[2])=>coordinated?acquireAdmissionBundle(pool!,process.env.REDIS_URL!,installation,`bundle-${input.id}`):acquireDurable(pool!,store,input);
  const add=async(amount:number,capacity:number)=>{
   const request=await transaction(pool!,tx=>enqueue(tx,scope,systemClock,{operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'mock',input_ref:'mock',route:{primary:{connection_id:connection,model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(Date.now()+60000)}));
   const lease=await transaction(pool!,tx=>leaseNext(tx,systemClock,'test',{scope,account:10,application:10},undefined,request.id));
   const input={id:id('admission'),group_id:group,request_id:request.id,fence:String(lease.fencing_token),demands:[{key:'rpm',capacity,window_ms:60000,amount}]};if(coordinated)await recordAdmissionBundle(pool!,`bundle-${input.id}`,[input]);else await recordAdmissionIntent(pool!,input);return input;
  };
  const patch=(body:unknown,key:string,token=tokens.admin.token)=>app.inject({method:'PATCH',url:`/v1/admin/provider-quotas/${group}/rules`,headers:{authorization:`Bearer ${token}`,'idempotency-key':key},payload:body as Record<string,unknown>});
  const body={rules_revision:1,rules:[{key:'rpm',capacity:'50',provider_capacity:'100'}],reason:'Lower mock quota'};
  try{
   const issued=await add(80,100);expect((await acquire(issued)).allowed).toBe(true);
   const replace=await app.inject({method:'PUT',url:`/v1/admin/provider-quotas/${group}/rules`,headers:{authorization:`Bearer ${tokens.admin.token}`,'idempotency-key':'structural-live'},payload:{rules_revision:1,rules:[{key:'daily',metric:'tokens',capacity:'10000',provider_capacity:null,window_ms:86400000}],reason:'Must not reset live quota'}});
   expect(replace.statusCode).toBe(409);expect(replace.json().error.code).toBe('quota_rules_usage_active');
   expect((await pool!.query('SELECT rule_metrics FROM dispatch_admissions WHERE id=$1',[issued.id])).rows[0].rule_metrics).toEqual({rpm:'requests'});
   await expect(pool!.query("UPDATE dispatch_admissions SET rule_metrics='{}' WHERE id=$1",[issued.id])).rejects.toMatchObject({message:'admission_rule_metrics_immutable'});
   expect((await patch(body,'read',tokens.read.token)).statusCode).toBe(403);
   expect((await patch({...body,rules:[...body.rules,...body.rules]},'duplicate')).statusCode).toBe(422);
   const lowered=await patch(body,'lower');expect(lowered.statusCode).toBe(200);expect(lowered.json()).toMatchObject({rules_revision:2,settings_revision:1,rules:[{key:'rpm',capacity:'50',provider_capacity:'100'}]});
   expect((await pool!.query('SELECT rule_metrics FROM dispatch_admissions WHERE id=$1',[issued.id])).rows[0].rule_metrics).toEqual({rpm:'requests'});
   expect((await patch(body,'lower')).json()).toEqual(lowered.json());expect((await patch(body,'stale')).statusCode).toBe(409);
   await expect(transaction(pool!,tx=>assertQuotaProof(tx,issued.id,issued.request_id,issued.fence,connection,'fake'))).resolves.toBeUndefined();
   const blocked=await add(1,50);expect(await acquire(blocked)).toMatchObject({allowed:false,reason:'limited'});
   const tag=createHash('sha256').update(JSON.stringify([installation,domain?JSON.stringify([scope.organization_id,domain]):group])).digest('hex'),keys=await store.redis.keys(`uai-quota:{${tag}}:*`);expect(keys.length).toBeGreaterThan(0);await store.redis.del(...keys);
   const recovered=await add(1,50);expect(await acquire(recovered)).toMatchObject({allowed:false,reason:'limited'});
   const raise={rules_revision:2,rules:[{key:'rpm',capacity:'120',provider_capacity:'100'}],reason:'Raise mock quota'};
   expect((await patch(raise,'invalid-raise')).statusCode).toBe(422);
   expect((await patch({...raise,rules:[{key:'rpm',capacity:'120',provider_capacity:'200'}]},'raise')).statusCode).toBe(200);
   const next=await add(30,120);expect((await acquire(next)).allowed).toBe(true);
   expect((await pool!.query('SELECT recovery_epoch,settings_revision,revision FROM provider_quota_groups WHERE id=$1',[group])).rows[0]).toEqual({recovery_epoch:'test',settings_revision:1,revision:3});
   const audit=(await pool!.query("SELECT metadata FROM audit_events WHERE organization_id=$1 AND action='quota.rules.updated' ORDER BY created_at,id",[scope.organization_id])).rows;
   expect(audit).toHaveLength(2);expect(audit[0].metadata).toMatchObject({before:{rules_revision:1,rules:[{capacity:'100',provider_capacity:null}]},after:{rules_revision:2,rules:[{capacity:'50',provider_capacity:'100'}]}});
  }finally{await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);await app.close();await store.close()}
 });
});
