import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {id,systemClock} from '../../../packages/contracts/src/index.js';
import {checkAdmissionBackpressure} from '../../../packages/quoting/src/backpressure.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>pool?.end());
describe.skipIf(!pool)('Application admission policy API',()=>{
 it('isolates applications, audits revision changes and applies saved limits immediately',async()=>{
  const scope={organization_id:id('org'),application_id:id('app')},foreign={...scope,application_id:id('app')};
  const tokens=await transaction(pool!,async tx=>{
   for(const s of [scope,foreign])await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[s.application_id,s.organization_id,'Admission policy test']);
   const token=(s:typeof scope,scopes:string[],account_ids:string[]|null=null)=>issueToken(tx,{...s,scopes,account_ids,max_grant_units:null,expires_at:null});
   return {admin:await token(scope,['operations:admin','config:write']),read:await token(scope,['operations:admin']),restricted:await token(scope,['operations:admin','config:write'],['one-account']),foreign:await token(foreign,['operations:admin','config:write'])};
  });
  const app=createApi(pool!),url='/v1/admin/admission-policy',headers={authorization:`Bearer ${tokens.admin.token}`,'idempotency-key':'first'};
  const body={revision:0,settings:{account_limit:3,application_limit:10,max_queue_age_ms:60000},reason:'Admission capacity test'};
  const patch=(payload:unknown=body,key='first')=>app.inject({method:'PATCH',url,headers:{...headers,'idempotency-key':key},payload:payload as Record<string,unknown>});
  try{
   expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
   expect((await app.inject({method:'GET',url,headers:{authorization:`Bearer ${tokens.restricted.token}`}})).statusCode).toBe(403);
   expect((await app.inject({method:'PATCH',url,headers:{...headers,authorization:`Bearer ${tokens.read.token}`},payload:body})).statusCode).toBe(403);
   const initial=await app.inject({method:'GET',url,headers});expect(initial.json()).toMatchObject({...scope,enabled:false,revision:0,account_limit:20,application_limit:200,max_queue_age_ms:900000});
   expect((await pool!.query('SELECT * FROM execution_admission_policies WHERE application_id=$1',[scope.application_id])).rowCount).toBe(0);
   expect((await patch({...body,settings:{...body.settings,application_limit:2}},'invalid')).statusCode).toBe(422);
   const saved=await patch();expect(saved.statusCode).toBe(200);expect(saved.json()).toMatchObject({...body.settings,enabled:true,revision:1});
   expect((await patch()).json()).toEqual(saved.json());
   expect((await patch({...body,reason:'Changed command'})).statusCode).toBe(409);
   expect((await patch(body,'stale')).statusCode).toBe(409);
   const other=await app.inject({method:'GET',url,headers:{authorization:`Bearer ${tokens.foreign.token}`}});expect(other.json()).toMatchObject({...foreign,enabled:false,revision:0,account_limit:20});
   await expect(transaction(pool!,tx=>checkAdmissionBackpressure(tx,{...scope,account_id:'account'},systemClock,4))).rejects.toMatchObject({code:'queue_backpressure',details:{reason:'account_backlog'}});
   const next={...body,revision:1};
   const competing=await Promise.all([patch({...next,settings:{...next.settings,account_limit:4}},'race-a'),patch({...next,settings:{...next.settings,account_limit:5}},'race-b')]);
   expect(competing.map(r=>r.statusCode).sort()).toEqual([200,409]);
   await transaction(pool!,tx=>checkAdmissionBackpressure(tx,{...scope,account_id:'account'},systemClock,4));
   const audits=(await pool!.query("SELECT metadata FROM audit_events WHERE application_id=$1 AND action='admission.policy.updated' ORDER BY created_at,id",[scope.application_id])).rows;
   expect(audits).toHaveLength(2);expect(audits[0].metadata).toMatchObject({before:{enabled:false,revision:0},after:{enabled:true,revision:1,account_limit:3}});expect(audits[1].metadata).toMatchObject({before:{revision:1,account_limit:3},after:{revision:2}});
  }finally{await app.close()}
 });
});
