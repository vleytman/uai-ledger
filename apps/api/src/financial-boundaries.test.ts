import {afterAll,describe,expect,test} from 'vitest';
import {createPool,transaction,type Tx} from '../../../packages/db/src/index.js';
import {id,ManualClock,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import * as accounting from '../../../packages/accounting/src/index.js';
import * as execution from '../../../packages/execution/src/index.js';
import * as quoting from '../../../packages/quoting/src/index.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';
import {ConnectionService} from '../../../packages/reconciliation/src/connections.js';
import {createApi} from './server.js';
import {apiSchemas,apiEndpoints} from '../../../packages/contracts/api.js';
import * as storage from '../../../packages/storage/src/index.js';
import {UaiClient} from '../../../packages/sdk/src/index.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const integration=process.env.DATABASE_URL?describe:describe.skip;const pool=process.env.DATABASE_URL?createPool():null;const apis:ReturnType<typeof createApi>[]=[];
afterAll(async()=>{await Promise.all(apis.map(api=>api.close()));await pool?.end();});
const fullScopes=['accounts:write','accounts:spending','credits:grant','credits:refund','credits:revoke','wallets:read','ai:read','ai:quote','ai:execute','content:write','operations:admin','config:write'];
async function fixture(){
 const organization_id=id('org'),application_id=id('app');const clock=new ManualClock(new Date('2026-01-01T00:00:00Z'));const api=createApi(pool!,clock);apis.push(api);
 const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[application_id,organization_id,'HTTP financial boundaries']);
 const token=async(scopes:string[],account_ids:string[]|null=null,max_grant_units:string|null='1000')=>(await run(tx=>issueToken(tx,{organization_id,application_id,account_ids,scopes,max_grant_units,expires_at:null}))).token;
 const admin=await token(fullScopes),rotated=await token(fullScopes);
 const checked=async(response:Awaited<ReturnType<typeof api.inject>>,method:string,url:string)=>{
  if(response.statusCode>=400){apiSchemas.ErrorResponse.parse(response.json());return response;}
  const endpoint=apiEndpoints.find(e=>e.method===method&&new RegExp('^'+e.path.replace(/\{[^}]+\}/g,'[^/]+')+'$').test(url.split('?')[0]));
  if(endpoint&&!endpoint.binaryResponse&&!endpoint.sse)apiSchemas[endpoint.response].parse(response.json());
  return response;
 };
 const post=async(url:string,payload:unknown,key:string|undefined=id('key'),bearer=admin)=>checked(await api.inject({method:'POST',url,headers:{authorization:`Bearer ${bearer}`,...(key===undefined?{}:{'idempotency-key':key})},payload:payload as any}),'post',url);
 const get=async(url:string,bearer=admin)=>checked(await api.inject({method:'GET',url,headers:{authorization:`Bearer ${bearer}`}}),'get',url);
 const createAccount=async()=>{const r=await post('/v1/accounts',{external_account_id:id('external'),create_wallet:{credit_unit_id:'ai-credit-usd-v1'}});expect(r.statusCode).toBe(200);return r.json();};
 const first=await createAccount(),second=await createAccount();const scope:Scope={organization_id,application_id,account_id:first.id};
 const reader=await token(['wallets:read','ai:read'],[first.id],null);const limited=await token(['credits:grant','wallets:read'],[first.id],'50');
 const grant=(amount_units='100',extra:Record<string,unknown>={},key=id('grant'),bearer=admin,wallet=first.wallet.id)=>post(`/v1/wallets/${wallet}/grants`,{amount_units,source:'purchase',external_reference:id('payment'),terms_version:'v1',expires_at:null,reason:'Fixture purchase',...extra},key,bearer);
 const capture=async(amount='80')=>run(async tx=>{const operation_id=id('op'),request_id=id('req');await accounting.reserve(tx,scope,clock,{operation_id,max_units:amount,idempotency_key:id('reserve')});await accounting.claim(tx,scope,clock,{operation_id,request_id,max_units:amount,idempotency_key:id('claim')});return accounting.settleClaim(tx,scope,clock,{request_id,charged_units:amount,idempotency_key:id('capture')});});
 return {organization_id,application_id,clock,api,run,token,admin,rotated,reader,limited,post,get,first,second,scope,grant,capture};
}
async function profile(f:Awaited<ReturnType<typeof fixture>>){return f.run(async tx=>{
 const service=new CatalogService(tx,f.clock);const connections=new ConnectionService(tx,f.clock);const connection=await connections.create(f.scope,{provider:'fake',name:'HTTP test fixture',account_scope:{fixture:f.first.id},capabilities:{usage_reporting:true,cost_reporting:true,balance_reporting:false,request_cost_lookup:false,reporting_granularity:['request'],reporting_lag_seconds:0},limits:{},risk_policy:{}},{actor_id:'test',reason:'synthetic fixture'});
 const models=await service.createDraft(f.scope,{kind:'catalog',key:'models',version:1,payload:{models:[{id:'fake-text',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'}]},author:'test',comment:'synthetic fixture'});await service.publish(f.scope,models.id,1);
 const rates=await service.createDraft(f.scope,{kind:'rate_card',key:'rates',version:1,payload:{id:id('card'),currency:'USD',source:'synthetic fixture',checked_at:f.clock.now().toISOString(),rates:[{id:'in',dimension:'input.uncached',unit:'tokens',unit_size:'1000000',amount:'0.00001',effective_from:'2025-01-01'},{id:'out',dimension:'output.text',unit:'tokens',unit_size:'1000000',amount:'0.00001',effective_from:'2025-01-01'}]},author:'test',comment:'synthetic fixture'});await service.publish(f.scope,rates.id,1,[{usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'1'}]},context:{at:f.clock.now().toISOString()}}]);
 const route=await service.createDraft(f.scope,{kind:'route',key:'route',version:1,payload:{capability:'text.generate',primary:{catalog_version_id:models.id,model:'fake-text',connection_id:connection.id,max_cost_units:'100'},deadline_seconds:1800,platform_risk_budget_units:'400'},author:'test',comment:'synthetic fixture'});await service.publish(f.scope,route.id,1);
 await execution.configureBudget(tx,f.scope,'provider',connection.id,'10000');await execution.configureBudget(tx,f.scope,'period','period','10000');
 const definition:quoting.RecipeDefinition={key:'http.text',version:1,period_budget_key:'period',components:[{key:'answer',capability:'text.generate',route_version_id:route.id,rate_card_version_id:rates.id,count:{constant:1},limits:{input_tokens:1000,output_tokens:100,max_assets:1,image_input_tokens_per_asset:10}}]};await quoting.publishRecipe(tx,f.scope,f.clock,definition);return definition;
});}
integration('HTTP financial authorization and identity boundaries',()=>{
 test('A01/A02 purchase replay survives token rotation and rejects source mutation',async()=>{
  const f=await fixture();const body={external_reference:'same-payment'};
  const first=await f.grant('100',body,'same');const rotated=await f.grant('100',body,'same',f.rotated);expect(first.statusCode).toBe(200);expect(rotated.statusCode).toBe(200);expect(rotated.json().lot_id).toBe(first.json().lot_id);
  const changed=await f.grant('101',body,'different');expect(changed.statusCode).toBe(409);expect(changed.json().error.code).toBe('idempotency_conflict');
  const moved=await f.grant('100',body,'move',f.admin,f.second.wallet.id);expect(moved.statusCode).toBe(409);
  expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json().balance_units).toBe('100');expect((await f.get(`/v1/wallets/${f.second.wallet.id}`)).json().balance_units).toBe('0');
 });
 test('A42 grants enforce scope, token ceiling, explicit expiry and server-owned issuer',async()=>{
  const f=await fixture();expect((await f.grant('100',{},'reader',f.reader)).statusCode).toBe(403);expect((await f.grant('51',{},'limit',f.limited)).statusCode).toBe(403);
  expect((await f.grant('1',{},'foreign',f.limited,f.second.wallet.id)).statusCode).toBe(404);expect((await f.grant('-1')).statusCode).toBe(422);expect((await f.grant('100',{expires_at:undefined})).statusCode).toBe(422);expect((await f.grant('100',{issuer:'attacker'})).statusCode).toBe(422);
  expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json().balance_units).toBe('0');
 });
 test('HTTP grant idempotency key cannot be rebound to another wallet payload',async()=>{
  const f=await fixture();expect((await f.grant('100',{external_reference:'event-a'},'one-key')).statusCode).toBe(200);
  const duplicate=await f.grant('200',{external_reference:'event-b'},'one-key',f.admin,f.second.wallet.id);expect(duplicate.statusCode).toBe(409);
  expect((await f.get(`/v1/wallets/${f.second.wallet.id}`)).json().balance_units).toBe('0');
 });
 test('financial HTTP commands reject malformed idempotency keys before effects',async()=>{
  const f=await fixture();const result=await f.grant('100',{},'invalid key with spaces');expect(result.statusCode).toBe(422);
  const missing=await f.api.inject({method:'POST',url:`/v1/wallets/${f.first.wallet.id}/grants`,headers:{authorization:`Bearer ${f.admin}`},payload:{amount_units:'100',source:'purchase',external_reference:'missing',terms_version:'v1',expires_at:null,reason:'test'}});expect(missing.statusCode).toBe(422);
  expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json().balance_units).toBe('0');
 });
 test('A09 HTTP refund replay and concurrency cannot exceed captured funds',async()=>{
  const f=await fixture();await f.grant();const captured=await f.capture();const body={capture_id:captured.capture_id,amount_units:'60',external_reference:'case',reason:'delivery_failure'};
  const results=await Promise.all([f.post(`/v1/wallets/${f.first.wallet.id}/refunds`,body,'refund'),f.post(`/v1/wallets/${f.first.wallet.id}/refunds`,body,'refund',f.rotated)]);expect(results.map(r=>r.statusCode)).toEqual([200,200]);expect(results[0].json().transaction_id).toBe(results[1].json().transaction_id);
  expect((await f.post(`/v1/wallets/${f.first.wallet.id}/refunds`,{...body,amount_units:'21',external_reference:'excess'},'excess')).statusCode).toBe(409);
  expect((await f.post(`/v1/wallets/${f.second.wallet.id}/refunds`,{...body,amount_units:'1',external_reference:'foreign'},'foreign')).statusCode).toBe(404);
  expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json().available_units).toBe('80');
 });
 test('A08/A65 HTTP refund after expiry creates compensation and preserves expired remainder',async()=>{
  const f=await fixture();await f.grant('100',{expires_at:'2026-01-01T00:01:00Z'});const capture=await f.capture();f.clock.advance(120000);
  expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json().available_units).toBe('0');
  const refund=await f.post(`/v1/wallets/${f.first.wallet.id}/refunds`,{capture_id:capture.capture_id,amount_units:'80',reason:'overcharge',external_reference:'refund'},'refund');expect(refund.statusCode).toBe(200);
  const lots=(await f.get(`/v1/wallets/${f.first.wallet.id}/lots`)).json().data;expect(lots.find((l:any)=>l.source==='purchase').expired).toBe('20');const compensation=lots.find((l:any)=>l.source==='refund');expect(compensation.available).toBe('80');expect(new Date(compensation.expires_at).getTime()-f.clock.now().getTime()).toBe(30*86400000);
 });
 test('A10 reserve competing with HTTP purchase revocation cannot use the same credits',async()=>{
  const f=await fixture();const grant=await f.grant();const grantId=grant.json().grant_id;
  const results=await Promise.allSettled([f.run(tx=>accounting.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'80',idempotency_key:'reserve'})),f.post(`/v1/wallets/${f.first.wallet.id}/grant-revocations`,{grant_id:grantId,amount_units:'80',external_reference:'revoke',reason:'purchase_refund'},'prepare')]);
  const reserveSucceeded=results[0].status==='fulfilled';const revokeSucceeded=results[1].status==='fulfilled'&&results[1].value.statusCode===200;expect(Number(reserveSucceeded)+Number(revokeSucceeded)).toBe(1);
  const wallet=(await f.get(`/v1/wallets/${f.first.wallet.id}`)).json();expect(wallet).toMatchObject({available_units:'20',reserved_units:'80'});
 });
 test('A11/A48 revocation hold survives timeout and only matching commit/cancel closes it',async()=>{
  const f=await fixture();const grant=await f.grant('100',{expires_at:'2026-01-01T00:01:00Z'});const prepare=await f.post(`/v1/wallets/${f.first.wallet.id}/grant-revocations`,{grant_id:grant.json().grant_id,amount_units:'60',external_reference:'revoke',reason:'purchase_refund'},'prepare');expect(prepare.statusCode).toBe(200);const revocation=prepare.json().revocation_id;
  f.clock.advance(7200000);expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json()).toMatchObject({available_units:'0',reserved_units:'60'});
  const commit=await f.post(`/v1/grant-revocations/${revocation}/commit`,{reason:'billing confirmed'},'commit');expect(commit.statusCode).toBe(200);expect((await f.post(`/v1/grant-revocations/${revocation}/commit`,{reason:'billing confirmed'},'commit',f.rotated)).statusCode).toBe(200);
  expect((await f.post(`/v1/grant-revocations/${revocation}/cancel`,{reason:'too late'},'cancel')).statusCode).toBe(409);expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json().balance_units).toBe('0');
  const otherToken=await f.token(['credits:revoke'],[f.second.id],null);expect((await f.post(`/v1/grant-revocations/${revocation}/commit`,{reason:'foreign'},'foreign',otherToken)).statusCode).toBe(404);
 });
 test('A75 suspend cancels unsent work and resume allows new work without reviving old requests',async()=>{
  const f=await fixture();await profile(f);await f.grant('200');const payload={account_id:f.first.id,profile:'http.text',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100},budget:{max_units:'100'}};
  const invoked=await f.post('/v1/invocations',payload,'invoke');expect(invoked.statusCode).toBe(202);const ids=invoked.json();
  const suspend=await f.post(`/v1/accounts/${f.first.id}/spending/suspend`,{reason:'billing hold',external_reference:'hold'},'status');expect(suspend.statusCode).toBe(200);
  expect((await f.get(`/v1/requests/${ids.request_id}`)).json()).toMatchObject({execution_status:'canceled',settlement_status:'settled'});expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json()).toMatchObject({available_units:'200',reserved_units:'0'});
  expect((await f.post('/v1/invocations',payload,'blocked')).statusCode).toBe(403);
  expect((await f.post(`/v1/accounts/${f.first.id}/spending/resume`,{reason:'billing cleared',external_reference:'clear'},'status')).statusCode).toBe(200);
  expect((await f.post('/v1/invocations',payload,'new')).statusCode).toBe(202);expect((await f.get(`/v1/requests/${ids.request_id}`)).json().execution_status).toBe('canceled');
 });
 test('A75 suspension after dispatch keeps active claim until confirmed cancellation settlement',async()=>{
  const f=await fixture();await profile(f);await f.grant('200');const invoked=await f.post('/v1/invocations',{account_id:f.first.id,profile:'http.text',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100},budget:{max_units:'100'}},'invoke');expect(invoked.statusCode).toBe(202);
  const request=await f.run(tx=>execution.leaseNext(tx,f.clock,'fixture',{scope:f.scope}));const attempt=await f.run(tx=>execution.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  expect((await f.post(`/v1/accounts/${f.first.id}/spending/suspend`,{reason:'hold',external_reference:'hold'},'hold')).statusCode).toBe(200);expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json().reserved_units).toBe('100');
  await f.run(tx=>execution.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'canceled',outcome:'canceled',cost_units:'30',charged_units:'30'},(t,sc,i)=>quoting.settleRequest(t,sc,f.clock,i)));
  expect((await f.get(`/v1/wallets/${f.first.wallet.id}`)).json()).toMatchObject({available_units:'170',reserved_units:'0'});
 });
 test('A33 late operation commands preserve completed HTTP projections and still enforce authorization',async()=>{
  const f=await fixture();await profile(f);await f.grant('200');
  const invoked=await f.post('/v1/invocations',{account_id:f.first.id,profile:'http.text',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100},budget:{max_units:'100'}},'invoke');expect(invoked.statusCode).toBe(202);
  const {operation_id,request_id}=invoked.json();const url=`/v1/operations/${operation_id}`;
  const request=await f.run(tx=>execution.leaseNext(tx,f.clock,'fixture',{scope:f.scope}));const attempt=await f.run(tx=>execution.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  await f.run(tx=>execution.observeAttempt(tx,f.scope,f.clock,{request_id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'success',outcome:'success',result_available:true,cost_units:'30',charged_units:'30'},(t,sc,i)=>quoting.settleRequest(t,sc,f.clock,i)));
  const before=(await f.get(url)).json();expect(before).toMatchObject({execution_status:'completed',settlement_status:'settled',captured_units:'30',reserved_units:'0',wallet:{available_units:'170',reserved_units:'0'}});
  f.clock.advance(5000);
  const responses=await Promise.all(['complete','cancel','finish-partial'].map(action=>f.post(`${url}/${action}`,{},`late-${action}`,f.rotated)));
  for(const response of responses){expect(response.statusCode).toBe(200);expect(response.json()).toEqual(before)}
  expect((await f.post(`${url}/cancel`,{},'late-cancel')).json()).toEqual(before);
  expect((await f.get(url)).json()).toEqual(before);expect((await f.get(`/v1/requests/${request_id}`)).json().execution_status).toBe('succeeded');
  expect((await f.post(`${url}/cancel`,{},'reader-cancel',f.reader)).statusCode).toBe(403);
  const foreign=await f.token(['ai:execute'],[f.second.id],null);expect((await f.post(`${url}/cancel`,{},'foreign-cancel',foreign)).statusCode).toBe(404);
  expect((await f.get(url)).json()).toEqual(before);
 });
 test('A42 admin read scopes exclude account-limited and foreign principals',async()=>{
  const f=await fixture();await f.grant();const restricted=await f.token(['operations:admin'],[f.first.id],null);expect((await f.get('/v1/admin/wallets',restricted)).statusCode).toBe(403);expect((await f.get('/v1/admin/overview',f.reader)).statusCode).toBe(403);
  const other=await fixture();const listed=(await other.get('/v1/admin/wallets')).json().data;expect(listed.every((w:any)=>w.id!==f.first.wallet.id)).toBe(true);
 });
 test('admin can publish an application recipe without a synthetic system account',async()=>{
  const f=await fixture();const definition=await profile(f);const published=await f.post('/v1/admin/recipes',{definition:{...definition,key:'admin.new'},reason:'Publish reviewed fixture'},'publish');expect(published.statusCode).toBe(200);expect(published.json().key).toBe('admin.new');
 });
 test('wallet history pagination preserves entries with equal timestamps',async()=>{
  const f=await fixture();await f.grant('10');await f.grant('20');const first=(await f.get(`/v1/wallets/${f.first.wallet.id}/transactions?limit=1`)).json().data[0];const second=(await f.get(`/v1/wallets/${f.first.wallet.id}/transactions?limit=1&cursor=${encodeURIComponent(first.cursor)}`)).json().data[0];expect(first.id).not.toBe(second.id);
 });
 test('actual quote/request/ACK responses and SDK asset reupload obey shared wire types',async()=>{
  const f=await fixture();await profile(f);await f.grant('200');
  const q=await f.post('/v1/quotes',{account_id:f.first.id,profile:'http.text',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100},budget:{max_units:'100'}},'quote');expect(q.statusCode).toBe(200);
  const operation=await f.post('/v1/operations',{quote_id:q.json().id,client_operation_key:'contract'},'accept');expect(operation.statusCode).toBe(202);
  const accepted=await f.post(`/v1/operations/${operation.json().id}/requests`,{client_request_key:'request',component:'answer',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100}},'request');expect(accepted.statusCode).toBe(202);
  const requestId=accepted.json().id;expect((await f.get(`/v1/requests/${requestId}`)).json().result).toBeNull();
  const pending=(await f.get(`/v1/requests/${requestId}/diagnostics`)).json();expect(pending.customer_charge_units).toBeNull();expect(pending.settlement_status).not.toBe('settled');
  const leased=await f.run(tx=>execution.leaseNext(tx,f.clock,'contract',{scope:f.scope}));const attempt=await f.run(tx=>execution.prepareDispatch(tx,f.scope,f.clock,leased.id,leased.fencing_token));
  const bytes=Buffer.from('independent fixture asset');const blobKey=id('blob');await new storage.LocalBlobStore(process.env.UAI_BLOB_ROOT??'.data/blobs').put(blobKey,bytes);
  const output=await f.run(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(41827430)');
   const asset=await storage.registerAsset(tx,f.scope,f.clock,{kind:'output',blob_key:blobKey,content_hash:storage.contentHash(bytes),media_type:'text/plain',size_bytes:bytes.length,operation_id:operation.json().id,expires_at:new Date(f.clock.now().getTime()+600000)});
   await storage.createManifest(tx,f.scope,f.clock,{request_id:requestId,operation_id:operation.json().id,content:{text:'fixture result'},asset_ids:[asset.id],ttl_seconds:600});
   await execution.observeAttempt(tx,f.scope,f.clock,{request_id:requestId,attempt_id:attempt.id,fence:leased.fencing_token,observation_key:'success',outcome:'success',cost_units:'10',charged_units:'10'},(t,sc,i)=>quoting.settleRequest(t,sc,f.clock,i));return asset;
  });
  const result=(await f.get(`/v1/requests/${requestId}`)).json();expect(result.result.assets[0].size_bytes).toBe(String(bytes.length));
  const rejected=await f.post('/v1/invocations',{account_id:f.first.id,profile:'http.text',kind:'text.generate',input:{text:'next',asset_ids:[output.id]},parameters:{max_output_tokens:100},budget:{max_units:'100'}},'reject-output');expect(rejected.statusCode).toBe(422);expect(rejected.json().error.code).toBe('invalid_input');
  expect((await pool!.query('SELECT count(*)::int count FROM execution_requests WHERE account_id=$1',[f.first.id])).rows[0].count).toBe(1);
  const sdk=new UaiClient({baseUrl:'http://fixture',token:f.admin,fetch:async(url,init)=>{
   const body=init?.body instanceof Blob?Buffer.from(await init.body.arrayBuffer()):init?.body;
   const response=await f.api.inject({method:(init?.method??'GET') as any,url:new URL(String(url)).pathname+new URL(String(url)).search,headers:init?.headers as any,payload:body as any});
   return new Response(Uint8Array.from(response.rawPayload),{status:response.statusCode,headers:response.headers as any});
  }});
  const uploaded=await sdk.assets.reupload(output.id,f.first.id,'independent-input');apiSchemas.AssetResponse.parse(uploaded);expect(uploaded.id).not.toBe(output.id);expect(uploaded.size_bytes).toBe(String(bytes.length));
  const dependent=await f.post('/v1/invocations',{account_id:f.first.id,profile:'http.text',kind:'text.generate',input:{text:'next',asset_ids:[uploaded.id]},parameters:{max_output_tokens:100},budget:{max_units:'100'}},'accept-input');expect(dependent.statusCode,dependent.body).toBe(202);
  const ack=await f.post(`/v1/requests/${requestId}/acknowledge`,{result_version:result.delivery.result_version,manifest_hash:result.delivery.manifest_hash},'ack');expect(ack.statusCode).toBe(200);
  expect((await f.get(`/v1/requests/${requestId}`)).json().result).toBeNull();
  expect(await sdk.assets.download(uploaded.id)).toEqual(new Uint8Array(bytes));
  await expect(f.run(tx=>storage.getAsset(tx,f.scope,f.clock,uploaded.id,true))).resolves.toMatchObject({kind:'input'});
  const diagnostics=(await f.get(`/v1/requests/${requestId}/diagnostics`)).json();expect(diagnostics.customer_charge_units).toBe('10');
 });

});
