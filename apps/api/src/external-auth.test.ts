import {afterAll,describe,expect,test} from 'vitest';
import {createPool,transaction,type Tx} from '../../../packages/db/src/index.js';
import {id,ManualClock,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {encodeExternalIdentity,EXTERNAL_IDENTITY_HEADER,type ExternalIdentity} from '../../../packages/contracts/external-identity.js';
import {UaiClient} from '../../../packages/sdk/src/index.js';
import * as accounting from '../../../packages/accounting/src/index.js';
import * as execution from '../../../packages/execution/src/index.js';
import * as quoting from '../../../packages/quoting/src/index.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';
import {ConnectionService} from '../../../packages/reconciliation/src/connections.js';
import {createApi} from './server.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const integration=process.env.DATABASE_URL?describe:describe.skip,pool=process.env.DATABASE_URL?createPool():null;
const apis:ReturnType<typeof createApi>[]=[];
afterAll(async()=>{await Promise.all(apis.map(api=>api.close()));await pool?.end()});
const scopes=['identity:assert','accounts:write','accounts:spending','credits:grant','credits:refund','credits:revoke','wallets:read','ai:read','ai:quote','ai:execute','content:write','operations:admin','config:write'];
const staff=(user_id:string,role:'admin'|'viewer'='admin'):ExternalIdentity=>({version:1,kind:'staff',user_id,role});
const user=(account_id:string,user_id='shared-human'):ExternalIdentity=>({version:1,kind:'user',user_id,account_id});
async function fixture(){
 const organization_id=id('org'),application_id=id('app'),clock=new ManualClock(new Date());
 const api=createApi(pool!,clock);apis.push(api);const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
 await pool!.query('INSERT INTO applications VALUES($1,$2,$3)',[application_id,organization_id,'External identity API fixture']);
 const issue=(s=scopes,account_ids:string[]|null=null)=>run(tx=>issueToken(tx,{organization_id,application_id,account_ids,scopes:s,max_grant_units:'100000',expires_at:null}));
 const credential=await issue();
 const transport:typeof fetch=async(url,init)=>{const response=await api.inject({method:init?.method as any??'GET',url:new URL(String(url)).pathname+new URL(String(url)).search,headers:init?.headers as Record<string,string>,payload:init?.body instanceof Blob?Buffer.from(await init.body.arrayBuffer()):init?.body as string|undefined});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}})};
 const service=new UaiClient({baseUrl:'http://fixture',token:credential.token,fetch:transport});
 const body={external_account_id:'team-a',create_wallet:{credit_unit_id:'ai-credit-usd-v1' as const}};
 const both=await Promise.all([service.accounts.create(body,'provision-a'),service.accounts.create(body,'provision-b')]);expect(both[0]).toEqual(both[1]);
 const first=both[0],second=await service.accounts.create({...body,external_account_id:'team-b'},'team-b');
 const scope:Scope={organization_id,application_id,account_id:first.id};
 const client=(identity:ExternalIdentity)=>service.forIdentity(identity);
 const raw=(method:string,url:string,identity?:ExternalIdentity,body?:unknown,token=credential.token)=>api.inject({method:method as any,url,headers:{authorization:`Bearer ${token}`,'idempotency-key':id('key'),...(identity?{[EXTERNAL_IDENTITY_HEADER]:encodeExternalIdentity(identity)}:{})},...(body===undefined?{}:{payload:body as any})});
 const grant=(key='fund',identity=staff('staff-alice'))=>client(identity).wallets.grant(first.wallet!.id,{amount_units:'10000',source:'purchase',external_reference:key,terms_version:'fixture',expires_at:null,reason:'Fixture funds'},key);
 return {api,clock,run,organization_id,application_id,scope,first,second,credential,service,client,raw,issue,grant};
}
async function profile(f:Awaited<ReturnType<typeof fixture>>){return f.run(async tx=>{
 const service=new CatalogService(tx,f.clock);const connections=new ConnectionService(tx,f.clock);const connection=await connections.create(f.scope,{provider:'fake',name:'HTTP test fixture',account_scope:{fixture:f.first.id},capabilities:{usage_reporting:true,cost_reporting:true,balance_reporting:false,request_cost_lookup:false,reporting_granularity:['request'],reporting_lag_seconds:0},limits:{},risk_policy:{}},{actor_id:'test',reason:'synthetic fixture'});
 const models=await service.createDraft(f.scope,{kind:'catalog',key:'models',version:1,payload:{models:[{id:'fake-text',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'}]},author:'test',comment:'synthetic fixture'});await service.publish(f.scope,models.id,1);
 const rates=await service.createDraft(f.scope,{kind:'rate_card',key:'rates',version:1,payload:{id:id('card'),currency:'USD',source:'synthetic fixture',checked_at:f.clock.now().toISOString(),rates:[{id:'in',dimension:'input.uncached',unit:'tokens',unit_size:'1000000',amount:'0.00001',effective_from:'2025-01-01'},{id:'out',dimension:'output.text',unit:'tokens',unit_size:'1000000',amount:'0.00001',effective_from:'2025-01-01'}]},author:'test',comment:'synthetic fixture'});await service.publish(f.scope,rates.id,1,[{usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'1'}]},context:{at:f.clock.now().toISOString()}}]);
 const route=await service.createDraft(f.scope,{kind:'route',key:'route',version:1,payload:{capability:'text.generate',primary:{catalog_version_id:models.id,model:'fake-text',connection_id:connection.id,max_cost_units:'100'},deadline_seconds:1800,platform_risk_budget_units:'400'},author:'test',comment:'synthetic fixture'});await service.publish(f.scope,route.id,1);
 await execution.configureBudget(tx,f.scope,'provider',connection.id,'10000');await execution.configureBudget(tx,f.scope,'period','period','10000');
 const definition:quoting.RecipeDefinition={key:'http.text',version:1,period_budget_key:'period',components:[{key:'answer',capability:'text.generate',route_version_id:route.id,rate_card_version_id:rates.id,count:{constant:1},limits:{input_tokens:1000,output_tokens:100,max_assets:1,image_input_tokens_per_asset:10}}]};await quoting.publishRecipe(tx,f.scope,f.clock,definition);return definition;
});}
integration('external identity through real API and SDK',()=>{
 test('concurrent provisioning and immutable clients keep parallel teams isolated',async()=>{
  const f=await fixture(),a=f.client(user(f.first.id)),b=f.client(user(f.second.id));
  await f.service.assertExternalIdentitySupport();
  const wallets=await Promise.all([a.wallets.get(f.first.wallet!.id),b.wallets.get(f.second.wallet!.id)]);
  expect(wallets.map(w=>w.account_id)).toEqual([f.first.id,f.second.id]);expect(f.service.identity).toBeUndefined();
  await expect(a.wallets.get(f.second.wallet!.id)).rejects.toMatchObject({status:404});
  await expect(b.wallets.get(f.first.wallet!.id)).rejects.toMatchObject({status:404});
  expect((await f.raw('POST','/v1/quotes',user(f.first.id),{account_id:f.second.id,profile:'missing',input:{text:'forged'}})).statusCode).toBe(404);
 });
 test('foreign asset upload, read, download and event filters reject the selected wrong team',async()=>{
  const f=await fixture(),a=f.client(user(f.first.id)),b=f.client(user(f.second.id));
  const upload=await a.assets.createUpload({account_id:f.first.id,media_type:'text/plain',size_bytes:1,content_hash:'sha256:'+'0'.repeat(64)},'upload');
  await expect(b.assets.uploadBytes(upload.asset_id,new Uint8Array([120]))).rejects.toMatchObject({status:404});
  await expect(b.assets.completeUpload(upload.asset_id,'complete')).rejects.toMatchObject({status:404});
  const asset=id('asset');
  await pool!.query("INSERT INTO storage_assets(id,organization_id,application_id,account_id,kind,blob_key,content_hash,media_type,size_bytes,expires_at) VALUES($1,$2,$3,$4,'input',$1,$5,'text/plain',1,now()+interval '1 hour')",[asset,f.organization_id,f.application_id,f.first.id,'sha256:'+'0'.repeat(64)]);
  expect((await a.assets.get(asset)).id).toBe(asset);
  await expect(b.assets.get(asset)).rejects.toMatchObject({status:404});
  await expect(b.assets.download(asset)).rejects.toMatchObject({status:404});
  expect((await f.raw('GET',`/v1/events?account_id=${f.first.id}`,user(f.second.id))).statusCode).toBe(404);
 });
 test('unprivileged token cannot assert identity and human context cannot grant scopes',async()=>{
  const f=await fixture(),plain=await f.issue(scopes.filter(s=>s!=='identity:assert'));
  expect((await f.raw('GET',`/v1/wallets/${f.first.wallet!.id}`,user(f.first.id),undefined,plain.token)).statusCode).toBe(403);
  const narrow=await f.issue(['identity:assert','wallets:read']);
  expect((await f.raw('GET','/v1/admin/overview',staff('admin'),undefined,narrow.token)).statusCode).toBe(403);
  for(const identity of [user(f.first.id),staff('viewer','viewer')]){
   expect((await f.raw('POST',`/v1/wallets/${f.first.wallet!.id}/grants`,identity,{})).statusCode).toBe(403);
   expect((await f.raw('POST','/v1/accounts',identity,{})).statusCode).toBe(403);
  }
  expect((await f.raw('GET','/v1/admin/overview',user(f.first.id))).statusCode).toBe(403);
  const malformed=await f.api.inject({method:'GET',url:`/v1/wallets/${f.first.wallet!.id}`,headers:{authorization:`Bearer ${f.credential.token}`,[EXTERNAL_IDENTITY_HEADER]:encodeURIComponent(JSON.stringify({...staff('fake'),organization_id:'forged'}))}});
  expect(malformed.statusCode).toBe(400);
 });
 test('viewer reads configuration but direct mutation methods remain forbidden',async()=>{
  const f=await fixture(),viewer=staff('viewer','viewer');
  expect((await f.raw('GET','/v1/admin/rate-cards',viewer)).statusCode).toBe(200);
  for(const [method,url] of [['POST','/v1/admin/rate-cards'],['PATCH','/v1/admin/rate-cards/missing/display-name'],['POST','/v1/admin/rate-cards/missing/publish'],['POST',`/v1/accounts/${f.first.id}/spending/suspend`],['POST','/v1/operations/missing/cancel'],['PUT','/v1/assets/missing/upload']]){
   expect((await f.raw(method,url,viewer,{})).statusCode,`${method} ${url}`).toBe(403);
  }
 });
 test('shared service staff attribution and idempotent replay preserve the first actor',async()=>{
  const f=await fixture();const alice=await f.grant('same',staff('alice')),bob=await f.grant('same',staff('bob'));
  expect(bob.lot_id).toBe(alice.lot_id);
  const lot=(await pool!.query('SELECT actor_id,audit_identity FROM credit_lots WHERE id=$1',[alice.lot_id])).rows[0];
  expect(lot).toMatchObject({actor_id:f.credential.principal.id,audit_identity:{user_id:'alice',service_principal_id:f.credential.principal.id,account_id:f.first.id,external_team_id:'team-a'}});
  await f.client(staff('alice')).accounts.suspend(f.first.id,{reason:'pause',external_reference:'pause'},'pause');
  await f.client(staff('bob')).accounts.resume(f.first.id,{reason:'resume',external_reference:'resume'},'resume');
  const events=(await pool!.query("SELECT audit_identity FROM audit_events WHERE application_id=$1 AND action IN ('spending.suspend','spending.resume') ORDER BY created_at",[f.application_id])).rows;
  expect(events.map(r=>r.audit_identity.user_id).sort()).toEqual(['alice','bob']);
 });
 test('revision-based configuration PATCHes sharing one key keep separate staff audit records',async()=>{
  const f=await fixture(),admin=f.client(staff('creator'));
  const first=await admin.request<{id:string}>('POST','/v1/admin/rate-cards',{key:'audit-first',version:1,payload:{},comment:'fixture'},{key:'create-first'});
  const second=await admin.request<{id:string}>('POST','/v1/admin/rate-cards',{key:'audit-second',version:1,payload:{},comment:'fixture'},{key:'create-second'});
  for(const [resource,revision,actor] of [[first.id,1,'alice'],[first.id,2,'bob'],[second.id,1,'charlie']] as const){
   const response=await f.api.inject({method:'PATCH',url:`/v1/admin/rate-cards/${resource}`,headers:{authorization:`Bearer ${f.credential.token}`,[EXTERNAL_IDENTITY_HEADER]:encodeExternalIdentity(staff(actor)),'idempotency-key':'reused-config-key','if-match':String(revision)},payload:{payload:{},comment:'same body'}});
   expect(response.statusCode).toBe(200);expect(response.json().revision).toBe(revision+1);
  }
  const events=(await pool!.query("SELECT resource_id,audit_identity FROM audit_events WHERE application_id=$1 AND action='PATCH /v1/admin/rate-cards/:id'",[f.application_id])).rows;
  expect(events).toHaveLength(3);
  expect(events.map(event=>[event.resource_id,event.audit_identity.user_id]).sort()).toEqual([[first.id,'alice'],[first.id,'bob'],[second.id,'charlie']].sort());
 });
 test('accepted operation, nested resources and staff refund retain original account and initiating human',async()=>{
  const f=await fixture();await profile(f);await f.grant();
  const a=f.client(user(f.first.id,'initiator')),b=f.client(user(f.second.id,'initiator'));
  const payload={account_id:f.first.id,profile:'http.text',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100},budget:{max_units:'1000'}};
  const accepted=await a.request<any>('POST','/v1/invocations',payload,{key:'accepted'});
  const retry=await f.client(user(f.first.id,'second-human')).request<any>('POST','/v1/invocations',payload,{key:'accepted'});expect(retry).toEqual(accepted);
  await expect(b.request('POST','/v1/invocations',payload,{key:'accepted'})).rejects.toMatchObject({status:404});
  for(const path of [`/v1/operations/${accepted.operation_id}`,`/v1/requests/${accepted.request_id}`,`/v1/quotes/${accepted.quote_id}`])await expect(b.request('GET',path)).rejects.toMatchObject({status:404});
  const original=(await pool!.query('SELECT audit_identity FROM operations WHERE id=$1',[accepted.operation_id])).rows[0];
  expect(original.audit_identity).toMatchObject({user_id:'initiator',account_id:f.first.id,external_team_id:'team-a'});
  const capture=await f.run(tx=>accounting.settleClaim(tx,f.scope,f.clock,{request_id:accepted.request_id,charged_units:'50',idempotency_key:'capture'}));
  const body={capture_id:capture.capture_id!,amount_units:'20',external_reference:'case',reason:'refund'};
  await expect(f.client(staff('refund-staff')).wallets.refund(f.second.wallet!.id,body,'wrong')).rejects.toMatchObject({status:404});
  const refund=await f.client(staff('refund-staff')).wallets.refund(f.first.wallet!.id,body,'refund');
  const recorded=(await pool!.query('SELECT audit_identity FROM journal_transactions WHERE id=$1',[refund.transaction_id])).rows[0];
  expect(recorded.audit_identity).toMatchObject({user_id:'refund-staff',account_id:f.first.id,external_team_id:'team-a',operation_id:accepted.operation_id});
  expect((await pool!.query('SELECT audit_identity FROM operations WHERE id=$1',[accepted.operation_id])).rows[0]).toEqual(original);
 });
 test.each(['scope','account'])('live SSE closes after service %s access is revoked',async kind=>{
  const f=await fixture(),credential=await f.issue(scopes,[f.first.id]);
  const address=await f.api.listen({host:'127.0.0.1',port:0}),abort=new AbortController();
  const response=await fetch(`${address}/v1/events?account_id=${f.first.id}`,{headers:{authorization:`Bearer ${credential.token}`,[EXTERNAL_IDENTITY_HEADER]:encodeExternalIdentity(user(f.first.id))},signal:abort.signal});
  expect(response.status).toBe(200);const reader=response.body!.getReader();
  try{
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
   if(kind==='scope')await pool!.query("UPDATE service_tokens SET scopes=ARRAY['identity:assert'] WHERE id=$1",[credential.principal.id]);
   else await pool!.query('UPDATE service_tokens SET account_ids=$2 WHERE id=$1',[credential.principal.id,[f.second.id]]);
   let closed=false;const timer=setTimeout(()=>abort.abort(),4000);
   try{while(!(await reader.read()).done){}closed=true}finally{clearTimeout(timer)}
   expect(closed).toBe(true);
  }finally{abort.abort();await reader.cancel().catch(()=>{});reader.releaseLock()}
 },10000);
});
