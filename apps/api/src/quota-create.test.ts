import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {id} from '../../../packages/contracts/src/index.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool)('Quota group creation',()=>{
 it('creates all rules atomically, scopes access, preserves idempotency and audits once',async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const tokens=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
   const token=(scopes:string[],account_ids:string[]|null=null)=>issueToken(tx,{...scope,scopes,account_ids,max_grant_units:null,expires_at:null});
   return {admin:await token(['operations:admin','config:write']),read:await token(['operations:admin']),restricted:await token(['operations:admin','config:write'],[scope.account_id]),product:await token(['config:write'])};
  });
  const app=createApi(pool!),url='/v1/admin/provider-quotas';
  const group={name:'Synthetic shared account',provider:'fake',source:'Test fixture, not provider pricing',checked_at:null,concurrency_limit:4,scope:{provider_account:'synthetic-account',capability:'text.generate'},coordination_domain:'synthetic-account',rules:[{key:'rpm',metric:'requests',capacity:'90',provider_capacity:'100',window_ms:60000},{key:'daily',metric:'tokens',capacity:'10000',provider_capacity:null,window_ms:86400000}]};
  const payload={group,reason:'Create synthetic quota'};
  const create=(body:any=payload,key='create',token=tokens.admin.token)=>app.inject({method:'POST',url,headers:{authorization:`Bearer ${token}`,'idempotency-key':key},payload:body});
  try{
   expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
   for(const who of ['read','restricted','product'] as const)expect((await create(payload,who,tokens[who].token)).statusCode).toBe(403);
   for(const bad of [
    {...group,organization_id:'other'},
    {...group,scope:{api_key:'must-not-be-stored'}},
    {...group,concurrency_limit:0},
    {...group,rules:[]},
    {...group,rules:[group.rules[0],group.rules[0]]},
    {...group,rules:Array.from({length:33},(_,i)=>({...group.rules[0],key:`r${i}`}))},
    ...['0','101','9007199254740992'].map(capacity=>({...group,rules:[{...group.rules[0],capacity}]})),
    {...group,rules:[{...group.rules[0],window_ms:86400001}]},
    {...group,rules:[{...group.rules[0],metric:'unknown'}]}
   ])expect((await create({group:bad,reason:payload.reason},id('bad'))).statusCode).toBe(422);
   expect((await pool!.query('SELECT id FROM provider_quota_groups WHERE organization_id=$1',[scope.organization_id])).rows).toEqual([]);
   const concurrent=await Promise.all([create(),create()]);expect(concurrent.map(r=>r.statusCode)).toEqual([200,200]);
   const saved=concurrent[0].json();expect(concurrent[1].json()).toEqual(saved);
   expect(saved).toMatchObject({...group,rules:expect.arrayContaining(group.rules),rules_revision:1,settings_revision:1,held_slots:0,bindings:[]});
   expect(saved.rules).toEqual(expect.arrayContaining(group.rules));
   expect((await create({...payload,reason:'Different body'})).statusCode).toBe(409);
   const duplicate=await create(payload,'duplicate');expect(duplicate.statusCode).toBe(409);expect(duplicate.json().error.code).toBe('quota_name_conflict');
   expect((await pool!.query("SELECT metadata FROM audit_events WHERE organization_id=$1 AND action='quota.group.created'",[scope.organization_id])).rows).toEqual([{metadata:expect.objectContaining({after:expect.objectContaining({name:group.name,rules:group.rules})})}]);
   expect((await pool!.query('SELECT id FROM provider_quota_groups WHERE organization_id=$1',[scope.organization_id])).rows).toHaveLength(1);
   expect((await pool!.query('SELECT * FROM provider_quota_bindings WHERE group_id=$1',[saved.id])).rows).toEqual([]);
   const foreignScope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
   const foreign=await transaction(pool!,async tx=>{
    await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[foreignScope.application_id,foreignScope.organization_id]);
    return issueToken(tx,{...foreignScope,scopes:['operations:admin','config:write'],account_ids:null,max_grant_units:null,expires_at:null});
   });
   const other=await create(payload,'create',foreign.token);expect(other.statusCode).toBe(200);expect(other.json().id).not.toBe(saved.id);
   const list=await app.inject({method:'GET',url,headers:{authorization:`Bearer ${foreign.token}`}});expect(list.json().data.map((g:any)=>g.id)).toEqual([other.json().id]);
  }finally{await app.close()}
 });
});
