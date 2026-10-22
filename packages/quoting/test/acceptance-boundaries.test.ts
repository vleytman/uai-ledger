import sharp from 'sharp';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateOutput} from '../../execution/src/runtime.js';
import {createApi} from '../../../apps/api/src/server.js';
import {issueToken} from '../../auth/src/index.js';
import {UaiClient} from '../../sdk/src/index.js';
import {afterAll,describe,test,expect} from 'vitest';
import {createPool,transaction,type Tx} from '../../db/src/index.js';
import {id,ManualClock,type Scope} from '../../contracts/src/index.js';
import {CatalogService,type RouteDefinition} from '../../catalog/src/index.js';
import * as a from '../../accounting/src/index.js';
import * as e from '../../execution/src/index.js';
import * as s from '../../storage/src/index.js';
import * as q from '../src/index.js';
import {executeOne,type WorkerDependencies} from '../../execution/src/runtime.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {FakeAdapter} from '../../providers/src/index.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const integration=process.env.DATABASE_URL?describe:describe.skip;const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end();});
async function fixture(organization_id=id('org')){
 const scope:Scope={organization_id,application_id:id('app'),account_id:id('acct')};const clock=new ManualClock(new Date('2026-01-01T00:00:00Z'));const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Quoting integration']);await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
 let primary='',fallback='';
 const def=await run(async tx=>{
  const connections=new ConnectionService(tx,clock);
  for(const name of ['primary','fallback']){const connection=await connections.create(scope,{provider:'fake',name,account_scope:{fixture:scope.account_id},capabilities:{usage_reporting:true,cost_reporting:true,balance_reporting:false,request_cost_lookup:false,reporting_granularity:['request'],reporting_lag_seconds:0},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'test'});if(name==='primary')primary=connection.id;else fallback=connection.id;}
  const catalog=new CatalogService(tx,clock);const models=await catalog.createDraft(scope,{kind:'catalog',key:'models',version:1,payload:{models:[{id:'fake-text',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'}]},author:'test',comment:'synthetic fixture'});await catalog.publish(scope,models.id,1);
  const card=await catalog.createDraft(scope,{kind:'rate_card',key:'text-rates',version:1,payload:{id:'fake-prices',currency:'USD',source:'synthetic fixture, not provider prices',checked_at:clock.now().toISOString(),rates:[{id:'in',dimension:'input.uncached',unit:'tokens',unit_size:'1000000',amount:'0.001',effective_from:'2025-01-01'},{id:'out',dimension:'output.text',unit:'tokens',unit_size:'1000000',amount:'0.001',effective_from:'2025-01-01'}]},author:'test',comment:'synthetic fixture'});await catalog.publish(scope,card.id,1,[{usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'1000'},{dimension:'output.text',unit:'tokens',quantity:'100'}]},context:{at:clock.now().toISOString()}}]);
  const route:RouteDefinition={capability:'text.generate',primary:{catalog_version_id:models.id,model:'fake-text',connection_id:primary,max_cost_units:'2000'},fallback:{catalog_version_id:models.id,model:'fake-text',connection_id:fallback,max_cost_units:'3000'},deadline_seconds:1800,platform_risk_budget_units:'12000'};
  const routeVersion=await catalog.createDraft(scope,{kind:'route',key:'text-route',version:1,payload:route,author:'test',comment:'synthetic fixture'});await catalog.publish(scope,routeVersion.id,1);
  for(const key of [primary,fallback])await e.configureBudget(tx,scope,'provider',key,'1000000');await e.configureBudget(tx,scope,'period','test-period','1000000');
  const definition:q.RecipeDefinition={key:'text',version:1,period_budget_key:'test-period',components:[{key:'answer',capability:'text.generate',route_version_id:routeVersion.id,rate_card_version_id:card.id,count:{constant:1},limits:{input_tokens:1000,output_tokens:100}}]};await q.publishRecipe(tx,scope,clock,definition);
  await q.publishRecipe(tx,scope,clock,{...definition,key:'discussion',inputs:{participants:{type:'integer',minimum:1,maximum:4}},components:[{...definition.components[0],count:{input:'participants'}}]});
  await a.grant(tx,scope,clock,{idempotency_key:'fund',source:'purchase',external_reference:'fixture-grant',amount_units:'100000',terms_version:'fixture',expires_at:null});return definition;
 });
 const quote=(input:Partial<q.QuoteInput>={})=>run(tx=>q.createQuote(tx,scope,clock,{priority:'interactive',idempotency_key:id('key'),recipe:{key:'discussion',version:1},inputs:{participants:2},...input}));
 const invoke=(input:Partial<q.QuoteInput&{quote_id:string}>={})=>run(tx=>q.invoke(tx,scope,clock,{priority:'interactive',idempotency_key:id('invoke'),profile:'text',input:{messages:[{role:'user',content:'Hello'}]},parameters:{max_output_tokens:100},budget:{max_units:'3000'},...input}));
 return {scope,clock,run,def,quote,invoke,primary,fallback};
}
async function publishNewRate(f:Awaited<ReturnType<typeof fixture>>,amount:string){await f.run(async tx=>{const service=new CatalogService(tx,f.clock);const version=await service.createDraft(f.scope,{kind:'rate_card',key:'text-rates',version:2,payload:{id:'updated-fixture',currency:'USD',source:'synthetic test',checked_at:f.clock.now().toISOString(),rates:[{id:'in2',dimension:'input.uncached',unit:'tokens',unit_size:'1000000',amount,effective_from:'2025-01-01'},{id:'out2',dimension:'output.text',unit:'tokens',unit_size:'1000000',amount,effective_from:'2025-01-01'}]},author:'test',comment:'rate change'});await service.publish(f.scope,version.id,1,[{usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'1'}]},context:{at:f.clock.now().toISOString()}}]);});}
function workerDependencies(f:Awaited<ReturnType<typeof fixture>>):WorkerDependencies{return {
 blobStore:{async put(){},async get(){throw new Error('No binary fixture');},async delete(){}},limits:{scope:f.scope},
 context:async(scope,request,variant)=>{const c=await q.getExecutionContext(pool!,scope,f.clock,request.id);return {input:{capability:'text.generate',model:variant.model,input:'Hello',max_output_tokens:100},accepted_rate_card:c.accepted_rate_card,current_rate_card:c.current_rate_card,accepted_at:new Date(c.accepted_at).toISOString(),maximum_items:c.component.maximum_items};},
 adapter:async()=>new FakeAdapter([{outcome:'success',text:'Valid fixture',usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'100'},{dimension:'output.text',unit:'tokens',quantity:'20'}]}}]),
 settle:(tx,scope,input)=>q.settleRequest(tx,scope,f.clock,input),
};}

async function operation(f:Awaited<ReturnType<typeof fixture>>,participants:number){const quote=await f.quote({inputs:{participants}});return f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:id('flow'),idempotency_key:id('accept')}));}
async function request(f:Awaited<ReturnType<typeof fixture>>,operationId:string){const r=await f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:operationId,component:'answer',kind:'text.generate',input:{text:'Discussion contribution'},parameters:{max_output_tokens:100},client_request_key:id('part'),idempotency_key:id('request')}));f.clock.advance(1);return r;}
async function dispatch(f:Awaited<ReturnType<typeof fixture>>,requestId:string){const leased=await f.run(tx=>e.leaseNext(tx,f.clock,'acceptance',{scope:f.scope}));expect(leased.id).toBe(requestId);const attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,leased.id,leased.fencing_token));return {leased,attempt};}
async function observe(f:Awaited<ReturnType<typeof fixture>>,active:Awaited<ReturnType<typeof dispatch>>,outcome:'success'|'invalid'|'canceled',charge:string,assets:string[]=[]){return f.run(async tx=>{
 await tx.query('SELECT pg_advisory_xact_lock(41827430)');
 if(outcome==='success')await s.createManifest(tx,f.scope,f.clock,{request_id:active.leased.id,operation_id:active.leased.operation_id,content:{text:'Valid accepted result'},asset_ids:assets,ttl_seconds:600});
 return e.observeAttempt(tx,f.scope,f.clock,{request_id:active.leased.id,attempt_id:active.attempt.id,fence:active.leased.fencing_token,observation_key:id('observation'),outcome,cost_units:charge,charged_units:charge,result_available:outcome==='success'},(tx,scope,input)=>q.settleRequest(tx,scope,f.clock,input));
});}
async function http(f:Awaited<ReturnType<typeof fixture>>){const app=createApi(pool!,f.clock);apis.push(app);const {token}=await f.run(tx=>issueToken(tx,{organization_id:f.scope.organization_id,application_id:f.scope.application_id,account_ids:[f.scope.account_id],scopes:['ai:quote','ai:execute','ai:read','wallets:read','content:write'],max_grant_units:null,expires_at:null}));
 const fetcher:typeof fetch=async(url,init)=>{const response=await app.inject({method:(init?.method??'GET') as any,url:new URL(String(url)).pathname,headers:init?.headers as any,payload:init?.body as any});return new Response(response.body,{status:response.statusCode,headers:response.headers as any});};
 return {app,token,fetcher};
}
const apis:ReturnType<typeof createApi>[]=[];
afterAll(async()=>{await Promise.all(apis.map(app=>app.close()));});

integration('Full accounting/quoting acceptance boundaries',()=>{
 test('A42 ordinary app token cannot issue credits or read another app request',async()=>{
  const f=await fixture();const other=await fixture(f.scope.organization_id);const own=await f.invoke();await observe(f,await dispatch(f,own.request_id),'success','1000');const server=await http(other);
  const client=new UaiClient({baseUrl:'http://fixture',token:server.token,fetch:server.fetcher});const wallet=await other.run(tx=>a.getWallet(tx,other.scope,other.clock));
  await expect(client.wallets.grant(wallet.id,{amount_units:'1',source:'internal',external_reference:'forbidden',terms_version:'v1',expires_at:null,reason:'forbidden'},'grant')).rejects.toMatchObject({status:403,error:{code:'scope_denied'}});
  await expect(client.requests.get(own.request_id)).rejects.toMatchObject({status:404,error:{code:'not_found'}});
  const denied=await server.app.inject({method:'GET',url:`/v1/requests/${own.request_id}`,headers:{authorization:`Bearer ${server.token}`}});expect(denied.body).not.toContain('Valid accepted result');expect(denied.body).not.toContain(own.operation_id);
  expect((await other.run(tx=>a.getWallet(tx,other.scope,other.clock))).balance_units).toBe('100000');
 });
 test('A45 a new app defines another recipe without kernel changes and cannot see the first app recipes',async()=>{
  const first=await fixture();const second=await fixture(first.scope.organization_id);
  await second.run(tx=>q.publishRecipe(tx,second.scope,second.clock,{...second.def,key:'external.review',components:[{...second.def.components[0],key:'critique',count:{constant:2}}]}));
  expect((await first.run(tx=>q.listRecipes(tx,first.scope))).some(r=>r.key==='external.review')).toBe(false);
  const quote=await second.quote({recipe:{key:'external.review',version:1},inputs:{}});expect(quote).toMatchObject({max_units:'6000',breakdown:[{component:'critique',count:2}]});
  const accepted=await second.run(tx=>q.acceptQuote(tx,second.scope,second.clock,{quote_id:quote.id,client_operation_key:'new-application-flow',idempotency_key:'accept'}));
  await second.run(tx=>q.createRequest(tx,second.scope,second.clock,{operation_id:accepted.id,component:'critique',client_request_key:'first-review',idempotency_key:'first-review',kind:'text.generate',input:{text:'Review this'},parameters:{max_output_tokens:100}}));
  await expect(first.run(tx=>q.getQuote(tx,first.scope,quote.id))).rejects.toMatchObject({code:'not_found'});await expect(first.run(tx=>q.createQuote(tx,first.scope,first.clock,{recipe:{key:'external.review',version:1},idempotency_key:'foreign-recipe'}))).rejects.toMatchObject({code:'not_found'});
  expect((await first.run(tx=>a.getWallet(tx,first.scope,first.clock))).reserved_units).toBe('0');expect((await second.run(tx=>a.getWallet(tx,second.scope,second.clock))).reserved_units).toBe('6000');
 });
 test('A47 concurrent complete/admission never reuses released reservation',async()=>{
  const f=await fixture();const op=await operation(f,1);
  const outcomes=await Promise.allSettled([f.run(tx=>q.complete(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'concurrent-close'})),request(f,op.id)]);expect(outcomes[0].status).toBe('fulfilled');
  const after=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,op.id));expect(after.admission_status).toBe('closed');
  if(outcomes[1].status==='fulfilled'){const admitted=outcomes[1].value;expect(after.requests).toHaveLength(1);expect(after.reserved_units).toBe('3000');await f.run(tx=>e.cancelRequest(tx,f.scope,f.clock,admitted.id,(tx,scope,input)=>q.settleRequest(tx,scope,f.clock,input)));}
  else {expect(outcomes[1].reason.code).toBe('operation_admission_closed');expect(after.requests).toHaveLength(0);expect(after.reserved_units).toBe('0');}
  const settled=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,op.id));expect(settled).toMatchObject({reserved_units:'0',captured_units:'0',settlement_status:'settled'});
  await expect(request(f,op.id)).rejects.toMatchObject({code:'operation_admission_closed'});expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).balance_units).toBe('100000');
 });
 test('A73 failed SDK persistence sends no ACK and resumes the same result without recharge',async()=>{
  const f=await fixture();const accepted=await f.invoke();await observe(f,await dispatch(f,accepted.request_id),'success','1000');const server=await http(f);const urls:string[]=[];
  const client=new UaiClient({baseUrl:'http://fixture',token:server.token,fetch:async(url,init)=>{urls.push(String(url));return server.fetcher(url,init);}});
  await expect(client.resume(accepted.request_id,{persist:async()=>{throw new Error('Disk unavailable')}})).rejects.toThrow('Disk unavailable');expect(urls.some(url=>url.endsWith('/acknowledge'))).toBe(false);
  expect((await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,accepted.request_id)))?.status).toBe('available');f.clock.advance(1000);
  let durableCopy:unknown;await client.resume(accepted.request_id,{persist:async result=>{durableCopy=result.result?.content;}});expect(durableCopy).toEqual({text:'Valid accepted result'});expect(urls.filter(url=>url.endsWith('/acknowledge'))).toHaveLength(1);
  expect((await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,accepted.request_id)))?.status).toBe('acknowledged');expect((await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id)))).toMatchObject({captured_units:'1000',reserved_units:'0'});
  expect((await pool!.query('SELECT count(*)::int n FROM execution_attempts WHERE request_id=$1',[accepted.request_id])).rows[0].n).toBe(1);expect((await pool!.query("SELECT count(*)::int n FROM journal_transactions WHERE wallet_id=(SELECT id FROM wallets WHERE account_id=$1) AND type='capture'",[f.scope.account_id])).rows[0].n).toBe(1);
 });
 test('A21 four image units retain three real PNG results and all four financial statuses',async()=>{
  const f=await fixture();const root=await mkdtemp(join(tmpdir(),'uai-image-acceptance-'));const blobs=new s.LocalBlobStore(root);
  try{
   await f.run(async tx=>{
    const catalog=new CatalogService(tx,f.clock);const models=await catalog.createDraft(f.scope,{kind:'catalog',key:'image-models',version:1,payload:{models:[{id:'fake-image',provider:'fake',capabilities:['image.generate'],allowed_parameters:['count','size','quality'],status:'active'}]},author:'test',comment:'synthetic image fixture'});await catalog.publish(f.scope,models.id,1);
    const card=await catalog.createDraft(f.scope,{kind:'rate_card',key:'image-rates',version:1,payload:{id:'image-fixture',currency:'USD',source:'synthetic',checked_at:f.clock.now().toISOString(),rates:[{id:'image',dimension:'output.image',unit:'images',unit_size:'1',amount:'0.000001',effective_from:'2025-01-01'}]},author:'test',comment:'synthetic image fixture'});await catalog.publish(f.scope,card.id,1,[{usage:{state:'known',items:[{dimension:'output.image',unit:'images',quantity:'1'}]},context:{at:f.clock.now().toISOString()}}]);
    const route=await catalog.createDraft(f.scope,{kind:'route',key:'image-route',version:1,payload:{capability:'image.generate',primary:{catalog_version_id:models.id,model:'fake-image',connection_id:f.primary,max_cost_units:'3000'},deadline_seconds:1800,platform_risk_budget_units:'12000'},author:'test',comment:'synthetic image fixture'});await catalog.publish(f.scope,route.id,1);
    await q.publishRecipe(tx,f.scope,f.clock,{key:'four-images',version:1,period_budget_key:'test-period',components:[{key:'image',capability:'image.generate',route_version_id:route.id,rate_card_version_id:card.id,count:{constant:4},limits:{image_count:1,image_sizes:['32x32'],image_qualities:['standard']}}]});
   });
   const quote=await f.quote({recipe:{key:'four-images',version:1},inputs:{}});expect(quote.max_units).toBe('12000');
   const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'four-images',idempotency_key:'accept-images'}));const requests:string[]=[];const images:Uint8Array[]=[];
   for(let i=0;i<4;i++){
    const r=await f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:op.id,component:'image',kind:'image.generate',input:{prompt:`Image ${i}`},parameters:{count:1,size:'32x32',quality:'standard'},client_request_key:`image-${i}`,idempotency_key:`image-${i}`}));requests.push(r.id);f.clock.advance(1);
    const active=await dispatch(f,r.id);
    if(i<3){const bytes=await sharp({create:{width:32,height:32,channels:4,background:{r:40+i*50,g:120,b:180,alpha:1}}}).png().toBuffer();await validateOutput({content_type:'image/png',bytes},undefined,'32x32');images.push(bytes);const key=id('png');await blobs.put(key,bytes);
     const asset=await f.run(tx=>s.registerAsset(tx,f.scope,f.clock,{kind:'output',blob_key:key,content_hash:s.contentHash(bytes),media_type:'image/png',size_bytes:bytes.length,operation_id:op.id,expires_at:new Date(f.clock.now().getTime()+600000)}));await observe(f,active,'success','1000',[asset.id]);
    }else await observe(f,active,'invalid','0');
   }
   const final=await f.run(tx=>q.complete(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'complete-images'}));expect(final).toMatchObject({captured_units:'3000',reserved_units:'0',execution_status:'partial',settlement_status:'settled'});expect(final.requests).toHaveLength(4);
   expect(final.requests.map(r=>r.execution_status)).toEqual(['succeeded','succeeded','succeeded','failed']);expect(final.requests.every(r=>r.settlement_status==='settled')).toBe(true);
   for(let i=0;i<3;i++){const delivery=await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,requests[i]));expect(delivery?.status).toBe('available');expect(delivery?.result?.assets).toHaveLength(1);const asset=await f.run(tx=>s.getAsset(tx,f.scope,f.clock,delivery!.result!.assets[0].id));expect(await blobs.get(asset.blob_key)).toEqual(images[i]);}
   expect(await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,requests[3]))).toBeNull();
   const claims=(await pool!.query('SELECT status,charged_units FROM request_budget_claims WHERE operation_id=$1 ORDER BY request_id',[op.id])).rows;expect(claims).toHaveLength(4);expect(claims.every(c=>c.status==='closed')).toBe(true);expect(claims.map(c=>c.charged_units).sort()).toEqual(['0','1000','1000','1000']);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 test('A51 subjective dissatisfaction preserves the charge and a new variant needs new spending authority',async()=>{
  const f=await fixture();const first=await f.invoke({idempotency_key:'first'});await observe(f,await dispatch(f,first.request_id),'success','1200');
  const original=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,first.operation_id));expect(original.captured_units).toBe('1200');
  await expect(f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:first.operation_id,component:'answer',kind:'text.generate',input:{text:'I want another style'},parameters:{max_output_tokens:100},client_request_key:'subjective-variant',idempotency_key:'variant'}))).rejects.toMatchObject({code:'operation_admission_closed'});
  await expect(f.invoke({idempotency_key:'unfunded-variant',input:{text:'I want another style'},budget:{max_units:'0'}})).rejects.toMatchObject({code:'budget_conflict'});
  const second=await f.invoke({idempotency_key:'authorized-variant',input:{text:'I want another style'}});expect(second.operation_id).not.toBe(first.operation_id);
  const wallet=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));expect(wallet).toMatchObject({balance_units:'98800',available_units:'95800',reserved_units:'3000'});
  expect((await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,first.request_id)))?.status).toBe('available');
 });
 test('A52 last discussion failure leaves every earlier valid contribution paid and available',async()=>{
  const f=await fixture();const op=await operation(f,3);const parts:Awaited<ReturnType<typeof request>>[]=[];
  for(let i=0;i<3;i++){const r=await request(f,op.id);parts.push(r);await observe(f,await dispatch(f,r.id),i===2?'invalid':'success',i===2?'0':'1000');}
  const final=await f.run(tx=>q.complete(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'close'}));expect(final).toMatchObject({captured_units:'2000',reserved_units:'0',settlement_status:'settled',execution_status:'partial'});
  expect(final.requests.map(r=>r.execution_status)).toEqual(['succeeded','succeeded','failed']);expect(final.requests.every(r=>r.settlement_status==='settled')).toBe(true);
  for(const r of parts.slice(0,2))expect((await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,r.id)))?.status).toBe('available');
  expect(await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,parts[2].id))).toBeNull();expect(final.wallet.balance_units).toBe('98000');
 });
 test('A71 SDK retries a lost accepted HTTP response with one operation/request/reservation',async()=>{
  const f=await fixture();const server=await http(f);let calls=0;const identities:string[]=[];
  const client=new UaiClient({baseUrl:'http://fixture',token:server.token,fetch:async(url,init)=>{calls++;identities.push((init?.headers as Record<string,string>)['idempotency-key']);const response=await server.fetcher(url,init);if(calls===1){expect(response.status).toBe(202);throw new Error('Response lost after committed acceptance');}return response;}});
  const accepted=await client.request<{operation_id:string;request_id:string}>('POST','/v1/invocations',{account_id:f.scope.account_id,profile:'text',input:{text:'One billable action'},parameters:{max_output_tokens:100},budget:{max_units:'3000'}},{key:'stable-lost-response'});
  expect(identities).toEqual(['stable-lost-response','stable-lost-response']);
  for(const table of ['operations','execution_requests','reservations'])expect((await pool!.query(`SELECT count(*)::int n FROM ${table} WHERE ${table==='reservations'?'wallet_id=(SELECT id FROM wallets WHERE account_id=$1)':'account_id=$1'}`,[f.scope.account_id])).rows[0].n).toBe(1);
  expect((await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id))).requests[0].id).toBe(accepted.request_id);
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).reserved_units).toBe('3000');
 });
 test('A72 HTTP max_credits decimal rejects one unit short and accepts the exact bound',async()=>{
  const f=await fixture();const server=await http(f);const client=new UaiClient({baseUrl:'http://fixture',token:server.token,fetch:server.fetcher});const body={account_id:f.scope.account_id,profile:'text',input:{text:'Exact credit conversion'},parameters:{max_output_tokens:100}};
  await expect(client.request('POST','/v1/invocations',{...body,budget:{max_credits:'0.002999'}},{key:'short'})).rejects.toMatchObject({status:409,error:{code:'budget_conflict'}});
  expect((await pool!.query('SELECT count(*)::int n FROM execution_requests WHERE account_id=$1',[f.scope.account_id])).rows[0].n).toBe(0);
  expect((await pool!.query('SELECT count(*)::int n FROM execution_attempts WHERE request_id IN(SELECT id FROM execution_requests WHERE account_id=$1)',[f.scope.account_id])).rows[0].n).toBe(0);
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock)))).toMatchObject({reserved_units:'0',balance_units:'100000'});
  const accepted=await client.request<{accepted_max_units:string}>('POST','/v1/invocations',{...body,budget:{max_credits:'0.003000'}},{key:'exact'});expect(accepted.accepted_max_units).toBe('3000');
  await expect(client.request('POST','/v1/invocations',{...body,budget:{max_credits:'0.0030001'}},{key:'excess-precision'})).rejects.toMatchObject({status:422});
 });
 test('A77 finish-partial cancels requote pause, retains ready content and waits for active settlement',async()=>{
  const f=await fixture();const op=await operation(f,3);const ready=await request(f,op.id);await observe(f,await dispatch(f,ready.id),'success','1000');
  const activeRequest=await request(f,op.id);const active=await dispatch(f,activeRequest.id);const paused=await request(f,op.id);
  await publishNewRate(f,'0.0015');expect((await executeOne(pool!,workerDependencies(f),f.clock,'requote'))).toMatchObject({state:'paused',request_id:paused.id});
  const during=await f.run(tx=>q.finishPartial(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'finish-partial'}));expect(during.admission_status).toBe('closed');expect(during.requests.find(r=>r.id===paused.id)?.execution_status).toBe('canceled');expect(during.settlement_status).not.toBe('settled');expect(BigInt(during.reserved_units)).toBeGreaterThan(0n);
  expect((await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,ready.id)))?.status).toBe('available');
  await observe(f,active,'canceled','500');const final=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,op.id));expect(final).toMatchObject({captured_units:'1500',reserved_units:'0',settlement_status:'settled'});
  expect((await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,ready.id)))?.status).toBe('available');f.clock.advance(600001);expect((await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,ready.id)))?.status).toBe('expired');
 });
});
