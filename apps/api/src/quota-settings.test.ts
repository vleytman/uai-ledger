import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {id,systemClock} from '../../../packages/contracts/src/index.js';
import {enqueue,leaseNext} from '../../../packages/execution/src/index.js';
import {recordAdmissionIntent,acquireDurable} from '../../../packages/queue/src/admission.js';
import {QuotaStore} from '../../../packages/queue/src/quota.js';
import {createApi} from './server.js';

const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool)('Provider quota settings API',()=>{
 it('scopes reads and writes, checks revision and idempotency, and audits without changing rule versions',async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota'),foreign=id('quota');
  const tokens=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
   for(const [groupId,organization] of [[group,scope.organization_id],[foreign,id('other-org')]]){
    await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','test','synthetic')",[groupId,organization]);
    await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'rpm','requests',100,60000)",[groupId]);
   }
   const token=(scopes:string[],account_ids:string[]|null=null)=>issueToken(tx,{...scope,scopes,account_ids,max_grant_units:null,expires_at:null});
   return {admin:await token(['operations:admin','config:write']),read:await token(['operations:admin']),restricted:await token(['operations:admin','config:write'],[scope.account_id]),product:await token(['config:write'])};
  });
  const app=createApi(pool!),base='/v1/admin/provider-quotas',headers={authorization:`Bearer ${tokens.admin.token}`,'idempotency-key':'save'};
  const settings={name:'Text concurrency',source:'Synthetic verification',checked_at:null,concurrency_limit:2};
  const body={settings_revision:1,settings,reason:'Configure mock concurrency'};
  const patch=(payload:any=body,extra={},groupId=group)=>app.inject({method:'PATCH',url:`${base}/${groupId}`,headers:{...headers,...extra},payload});
  try{
   expect((await app.inject({method:'GET',url:base})).statusCode).toBe(401);
   for(const who of ['restricted','product'] as const)expect((await app.inject({method:'GET',url:base,headers:{authorization:`Bearer ${tokens[who].token}`}})).statusCode).toBe(403);
   const list=await app.inject({method:'GET',url:base,headers});expect(list.statusCode).toBe(200);
   expect(list.json().data).toEqual([expect.objectContaining({id:group,settings_revision:1,rules_revision:1,held_slots:0,rules:[{key:'rpm',metric:'requests',capacity:'100',provider_capacity:null,window_ms:60000}]})]);
   expect((await patch(body,{authorization:`Bearer ${tokens.read.token}`})).statusCode).toBe(403);
   expect((await patch(body,{},foreign)).statusCode).toBe(404);
   expect((await patch({...body,settings:{...settings,concurrency_limit:0}})).statusCode).toBe(422);
   expect((await patch({...body,settings:{...settings,slot_lease_ms:10000}})).statusCode).toBe(422);
   const saved=await patch();expect(saved.statusCode).toBe(200);expect(saved.json()).toMatchObject({...settings,settings_revision:2,rules_revision:1});
   expect((await patch()).json()).toEqual(saved.json());
   expect((await patch({...body,reason:'Different payload'})).statusCode).toBe(409);
   expect((await patch(body,{'idempotency-key':'stale'})).statusCode).toBe(409);
   const competing=await Promise.all([patch({...body,settings_revision:2},{'idempotency-key':'a'}),patch({...body,settings_revision:2,settings:{...settings,concurrency_limit:3}},{'idempotency-key':'b'})]);
   expect(competing.map(r=>r.statusCode).sort()).toEqual([200,409]);
   const audits=(await pool!.query("SELECT metadata FROM audit_events WHERE organization_id=$1 AND action='quota.settings.updated' ORDER BY created_at,id",[scope.organization_id])).rows;
   expect(audits).toHaveLength(2);expect(audits[0].metadata).toMatchObject({before:{settings_revision:1,concurrency_limit:8},after:{settings_revision:2,concurrency_limit:2}});
   expect((await pool!.query('SELECT revision,recovery_epoch,slot_lease_ms,unknown_hold_ms FROM provider_quota_groups WHERE id=$1',[group])).rows[0]).toEqual({revision:1,recovery_epoch:'test',slot_lease_ms:30000,unknown_hold_ms:300000});
   const second=id('quota');await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','test','synthetic')",[second,scope.organization_id]);
   const rename={...settings,name:'Same quota name'};
   const collision=await Promise.all([patch({...body,settings_revision:3,settings:rename},{'idempotency-key':'name-a'}),patch({...body,settings_revision:1,settings:rename},{'idempotency-key':'name-b'},second)]);
   expect(collision.map(r=>r.statusCode).sort()).toEqual([200,409]);expect(collision.find(r=>r.statusCode===409)!.json().error.code).toBe('quota_name_conflict');
  }finally{await app.close()}
 });
 it.skipIf(!process.env.REDIS_URL)('does not invalidate a durable admission intent when operational settings change',async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota');
  const token=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
   await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','test','synthetic')",[group,scope.organization_id]);
   await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'rpm','requests',100,60000)",[group]);
   return issueToken(tx,{...scope,scopes:['operations:admin','config:write'],account_ids:null,max_grant_units:null,expires_at:null});
  });
  const request=await transaction(pool!,tx=>enqueue(tx,scope,systemClock,{operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'mock',input_ref:'mock',route:{primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(Date.now()+60000)}));
  const lease=await transaction(pool!,tx=>leaseNext(tx,systemClock,'test',{scope},undefined,request.id));
  const input={id:id('admission'),group_id:group,request_id:request.id,fence:String(lease.fencing_token),demands:[{key:'rpm',capacity:100,window_ms:60000,amount:1}]};
  await recordAdmissionIntent(pool!,input);
  const app=createApi(pool!),store=new QuotaStore(process.env.REDIS_URL!,id('quota-settings'),group);await store.connect();
  try{
   const saved=await app.inject({method:'PATCH',url:`/v1/admin/provider-quotas/${group}`,headers:{authorization:`Bearer ${token.token}`,'idempotency-key':'rename'},payload:{settings_revision:1,settings:{name:'Renamed group',source:'Synthetic test',checked_at:null,concurrency_limit:1},reason:'Rename while admission is in progress'}});
   expect(saved.statusCode).toBe(200);
   expect(await acquireDurable(pool!,store,input)).toMatchObject({allowed:true});
   const state=await app.inject({method:'GET',url:'/v1/admin/provider-quotas',headers:{authorization:`Bearer ${token.token}`}});
   expect(state.json().data[0]).toMatchObject({held_slots:1,settings_revision:2,rules_revision:1});
  }finally{await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE id=$1",[request.id]);await store.close();await app.close()}
 });
});
