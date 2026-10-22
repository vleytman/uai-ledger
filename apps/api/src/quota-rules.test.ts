import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {id} from '../../../packages/contracts/src/index.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool)('Structural quota rule revisions',()=>{
 it('preserves active feedback, scopes writes, changes the recovery epoch only for structural edits and audits retries once',async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota');
  const tokens=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
   await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','old','synthetic')",[group,scope.organization_id]);
   await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'rpm','requests',100,60000)",[group]);
   const token=(organization_id:string,scopes:string[],account_ids:string[]|null=null)=>issueToken(tx,{...scope,organization_id,scopes,account_ids,max_grant_units:null,expires_at:null});
   return {admin:await token(scope.organization_id,['operations:admin','config:write']),read:await token(scope.organization_id,['operations:admin']),restricted:await token(scope.organization_id,['operations:admin','config:write'],[scope.account_id]),foreign:await token(id('org'),['operations:admin','config:write'])};
  });
  const app=createApi(pool!),url=`/v1/admin/provider-quotas/${group}/rules`;
  const rule={key:'daily',metric:'tokens',capacity:'10000',provider_capacity:null,window_ms:86400000};
  const body={rules_revision:1,rules:[rule],reason:'Synthetic structure edit'};
  const put=(payload:any=body,key=id('command'),token=tokens.admin.token)=>app.inject({method:'PUT',url,headers:{authorization:`Bearer ${token}`,'idempotency-key':key},payload});
  const state=async()=>(await pool!.query('SELECT revision,recovery_epoch FROM provider_quota_groups WHERE id=$1',[group])).rows[0];
  try{
   expect((await app.inject({method:'PUT',url,payload:body})).statusCode).toBe(401);
   for(const who of ['read','restricted'] as const)expect((await put(body,id('c'),tokens[who].token)).statusCode).toBe(403);
   expect((await put(body,id('c'),tokens.foreign.token)).statusCode).toBe(404);
   for(const rules of [[],[rule,rule],[{...rule,capacity:'0'}],[{...rule,window_ms:86400001}],[{...rule,metric:'unknown'}]])expect((await put({...body,rules})).statusCode).toBe(422);
   const observation=id('obs');
   await pool!.query("INSERT INTO quota_observations(id,group_id,sent_at,headers,applied_at) VALUES($1,$2,now(),'{}',now())",[observation,group]);
   expect((await put()).json().error.code).toBe('quota_rules_usage_active');
   // Capacity changes use the existing history even through the full replacement API.
   const capacity=await put({...body,rules:[{key:'rpm',metric:'requests',capacity:'90',provider_capacity:'100',window_ms:60000}]});
   expect(capacity.statusCode).toBe(200);expect(await state()).toEqual({revision:2,recovery_epoch:'old'});
   await pool!.query("UPDATE quota_observations SET received_at=now()-interval '26 hours',sent_at=now()-interval '26 hours',applied_at=NULL WHERE id=$1",[observation]);
   const next={...body,rules_revision:2};
   expect((await put(next)).json().error.code).toBe('quota_rules_usage_active');
   await pool!.query('UPDATE quota_observations SET applied_at=now() WHERE id=$1',[observation]);
   await pool!.query("UPDATE provider_quota_groups SET blocked_until=now()+interval '1 hour' WHERE id=$1",[group]);
   expect((await put(next)).json().error.code).toBe('quota_rules_usage_active');
   await pool!.query('UPDATE provider_quota_groups SET blocked_until=NULL WHERE id=$1',[group]);
   const results=await Promise.all([put(next,'replace-once'),put(next,'replace-once')]);
   expect(results.map(r=>r.statusCode)).toEqual([200,200]);expect(results[0].json()).toEqual(results[1].json());
   expect(results[0].json()).toMatchObject({rules_revision:3,rules:[rule]});
   expect(await state()).toMatchObject({revision:3,recovery_epoch:expect.not.stringMatching(/^old$/)});
   expect((await put(next)).statusCode).toBe(409);
   const audit=(await pool!.query("SELECT metadata FROM audit_events WHERE organization_id=$1 AND action='quota.rules.replaced'",[scope.organization_id])).rows;
   expect(audit).toHaveLength(1);expect(audit[0].metadata).toMatchObject({before:{rules_revision:2,rules:[{key:'rpm'}]},after:{rules_revision:3,rules:[rule]}});
  }finally{await app.close()}
 });
});
