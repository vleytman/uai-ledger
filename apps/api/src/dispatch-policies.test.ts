import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {id,systemClock} from '../../../packages/contracts/src/index.js';
import {enqueue,leaseNext,cancelRequest} from '../../../packages/execution/src/index.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>pool?.end());
describe.skipIf(!pool)('Installation dispatch policy API',()=>{
 it('applies active capacity changes to subsequent leases without interrupting existing work',async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};
  const token=await transaction(pool!,async tx=>{await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Live capacity test']);return issueToken(tx,{...scope,scopes:['operations:admin','config:write'],account_ids:null,max_grant_units:null,expires_at:null})});
  const app=createApi(pool!),original=(await pool!.query("SELECT * FROM execution_dispatch_policies WHERE queue_kind='tools'")).rows[0];
  let revision=original.revision;
  const setCapacity=async(account:number,application:number,queue:number)=>{
   const response=await app.inject({method:'PATCH',url:'/v1/admin/dispatch-policies/tools',headers:{authorization:`Bearer ${token.token}`,'idempotency-key':id('change')},payload:{revision,reason:'Runtime capacity verification',settings:{account_limit:original.account_limit,application_limit:original.application_limit,queue_limit:original.queue_limit,active_account_limit:account,active_application_limit:application,active_queue_limit:queue}}});
   expect(response.statusCode).toBe(200);revision=response.json().revision;
  };
  try{
   const route={primary:{connection_id:'fake',model:'fake',endpoint_scope:id('endpoint'),max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
   const requests=await Promise.all(Array.from({length:3},()=>transaction(pool!,tx=>enqueue(tx,scope,systemClock,{priority:10,backend:'bullmq',capability:'search',operation_id:id('op'),component:'search',client_request_key:id('request'),input_hash:'test',input_ref:'test',route,max_units:'0',deadline_at:new Date(Date.now()+60000)}))));
   const lease=(request:any)=>transaction(pool!,tx=>leaseNext(tx,systemClock,'capacity-worker',{scope,backend:'bullmq'},undefined,request.id,true));
   await setCapacity(1,2,3);expect(await lease(requests[0])).toMatchObject({id:requests[0].id});expect(await lease(requests[1])).toBeNull();
   await setCapacity(2,2,3);expect(await lease(requests[1])).toMatchObject({id:requests[1].id});
   await setCapacity(1,1,1);expect(await lease(requests[2])).toBeNull();
   expect((await pool!.query("SELECT count(*)::int n FROM execution_requests WHERE organization_id=$1 AND execution_status='leased'",[scope.organization_id])).rows[0].n).toBe(2);
   await transaction(pool!,tx=>cancelRequest(tx,scope,systemClock,requests[0].id));expect(await lease(requests[2])).toBeNull();
   await transaction(pool!,tx=>cancelRequest(tx,scope,systemClock,requests[1].id));expect(await lease(requests[2])).toMatchObject({id:requests[2].id});
  }finally{
   await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);
   await pool!.query("UPDATE execution_dispatch_policies SET active_account_limit=$1,active_application_limit=$2,active_queue_limit=$3 WHERE queue_kind='tools'",[original.active_account_limit,original.active_application_limit,original.active_queue_limit]);
   await app.close();
  }
 });
 it('authorizes installation admins and enforces revision, idempotency, validation and audit atomically',async()=>{
  const scope={organization_id:id('org'),application_id:id('app')};
  const tokens=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Dispatch policy fixture']);
   const token=(scopes:string[],account_ids:string[]|null=null)=>issueToken(tx,{...scope,scopes,account_ids,max_grant_units:null,expires_at:null});
   return {admin:await token(['operations:admin','config:write']),read:await token(['operations:admin']),restricted:await token(['operations:admin','config:write'],['account']),product:await token(['config:write'])};
  });
  const app=createApi(pool!),original=(await pool!.query("SELECT * FROM execution_dispatch_policies WHERE queue_kind='observe'")).rows[0];
  const activeOriginal=(await pool!.query("SELECT * FROM execution_dispatch_policies WHERE queue_kind='tools'")).rows[0];
  const base='/v1/admin/dispatch-policies',headers={authorization:`Bearer ${tokens.admin.token}`,'idempotency-key':'policy-save'};
  const body={revision:original.revision,settings:{account_limit:3,application_limit:12,queue_limit:48},reason:'Mock dispatcher capacity test'};
  const patch=(payload:unknown=body,extra={})=>app.inject({method:'PATCH',url:base+'/observe',headers:{...headers,...extra},payload:payload as Record<string,unknown>});
  try{
   expect((await app.inject({method:'GET',url:base})).statusCode).toBe(401);
   for(const who of ['restricted','product'] as const)expect((await app.inject({method:'GET',url:base,headers:{authorization:`Bearer ${tokens[who].token}`}})).statusCode).toBe(403);
   expect((await patch(body,{authorization:`Bearer ${tokens.read.token}`})).statusCode).toBe(403);
   const list=await app.inject({method:'GET',url:base,headers});expect(list.statusCode).toBe(200);expect(list.json().data).toHaveLength(6);
   const invalid=await patch({...body,settings:{...body.settings,account_limit:49}});expect(invalid.statusCode).toBe(422);
   const first=await patch();expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({...body.settings,revision:original.revision+1});
   expect((await patch()).json()).toEqual(first.json());
   expect((await patch({...body,reason:'Different command'})).statusCode).toBe(409);
   expect((await patch(body,{'idempotency-key':'stale'})).statusCode).toBe(409);
   const next={...body,revision:first.json().revision};
   const competing=await Promise.all([patch(next,{'idempotency-key':'race-a'}),patch({...next,settings:{...next.settings,queue_limit:49}},{'idempotency-key':'race-b'})]);
   expect(competing.map(r=>r.statusCode).sort()).toEqual([200,409]);
   const audits=(await pool!.query("SELECT metadata FROM audit_events WHERE application_id=$1 AND action='dispatch.policy.updated' ORDER BY created_at,id",[scope.application_id])).rows;
   expect(audits).toHaveLength(2);expect(audits[0].metadata).toMatchObject({scope:'installation',before:{revision:original.revision},after:{revision:original.revision+1,account_limit:3}});
   const current=(await pool!.query("SELECT * FROM execution_dispatch_policies WHERE queue_kind='observe'")).rows[0];
   expect(current.revision).toBe(original.revision+2);
   expect((await patch({...body,revision:current.revision,reason:'   '},{'idempotency-key':'empty-reason'})).statusCode).toBe(422);
   expect((await pool!.query("SELECT revision FROM execution_dispatch_policies WHERE queue_kind='observe'")).rows[0].revision).toBe(current.revision);
   const activeSettings={account_limit:activeOriginal.account_limit,application_limit:activeOriginal.application_limit,queue_limit:activeOriginal.queue_limit,active_account_limit:4,active_application_limit:16,active_queue_limit:32};
   const activeBody={revision:activeOriginal.revision,settings:activeSettings,reason:'Separate execution capacity'};
   const saveActive=(payload:any,key:string)=>app.inject({method:'PATCH',url:base+'/tools',headers:{...headers,'idempotency-key':key},payload});
   expect((await saveActive({...activeBody,settings:{...activeSettings,active_account_limit:17}},'invalid-active')).statusCode).toBe(422);
   expect((await patch({...body,revision:current.revision,settings:{...body.settings,active_queue_limit:32}},{'idempotency-key':'unsupported-active'})).statusCode).toBe(422);
   const activeSaved=await saveActive(activeBody,'active-save');expect(activeSaved.statusCode).toBe(200);
   expect(activeSaved.json()).toMatchObject({...activeSettings,revision:activeOriginal.revision+1});
   expect((await saveActive(activeBody,'active-save')).json()).toEqual(activeSaved.json());
   expect((await saveActive(activeBody,'active-stale')).statusCode).toBe(409);
   const preserved=await saveActive({revision:activeSaved.json().revision,settings:{account_limit:activeOriginal.account_limit,application_limit:activeOriginal.application_limit,queue_limit:activeOriginal.queue_limit},reason:'Old client preserves active limits'},'old-client');
   expect(preserved.statusCode).toBe(200);expect(preserved.json()).toMatchObject({active_account_limit:4,active_application_limit:16,active_queue_limit:32});
   const activeAudit=(await pool!.query("SELECT metadata FROM audit_events WHERE application_id=$1 AND action='dispatch.policy.updated' AND metadata->'after'->>'revision'=$2",[scope.application_id,String(activeSaved.json().revision)])).rows;
   expect(activeAudit.some(row=>row.metadata.after.active_account_limit===4)).toBe(true);
  }finally{
   await pool!.query("UPDATE execution_dispatch_policies SET active_account_limit=$1,active_application_limit=$2,active_queue_limit=$3 WHERE queue_kind='tools'",[activeOriginal.active_account_limit,activeOriginal.active_application_limit,activeOriginal.active_queue_limit]);
   await pool!.query("UPDATE execution_dispatch_policies SET account_limit=$1,application_limit=$2,queue_limit=$3 WHERE queue_kind='observe'",[original.account_limit,original.application_limit,original.queue_limit]);
   await app.close();
  }
 });
});
