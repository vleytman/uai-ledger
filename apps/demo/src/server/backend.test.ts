import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPool,transaction} from '../../../../packages/db/src/index.js';
import {isolatedTestDatabase} from '../../../../packages/db/test/isolated-database.js';
import {ManualClock,id,type Scope} from '../../../../packages/contracts/src/index.js';
import {CatalogService} from '../../../../packages/catalog/src/index.js';
import {ConnectionService} from '../../../../packages/reconciliation/src/connections.js';
import {grant,getWallet} from '../../../../packages/accounting/src/index.js';
import {publishRecipe} from '../../../../packages/quoting/src/index.js';
import {configureBudget} from '../../../../packages/execution/src/index.js';
import {executeOne} from '../../../../packages/execution/src/runtime.js';
import {defaultRuntime} from '../../../../packages/execution/src/default-runtime.js';
import {FakeAdapter} from '../../../../packages/providers/src/index.js';
import {issueToken} from '../../../../packages/auth/src/index.js';
import {createApi} from '../../../api/src/server.js';
import {handle} from './backend';
import {publishConfiguration,activateConfiguration} from '../../../../packages/configuration/src/index.js';
import {AllowanceService} from '../../../../packages/allowance/src/index.js';
import {DemoStore} from './store';
const sourceUrl=process.env.DATABASE_URL,database=isolatedTestDatabase(sourceUrl);
let pool:ReturnType<typeof createPool>|null=null;
beforeAll(async()=>{if(sourceUrl){await database.initialize();pool=database.pool}});
afterAll(()=>database.close());
describe.skipIf(!sourceUrl)('Demo through independent SDK and actual HTTP API',()=>{
 it('A86 A87 A89 A90 restricts test grants, keeps successful composite text, and resumes without another charge',async()=>{
 const s:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},clock=new ManualClock(new Date('2026-09-18T12:00:00Z')),folder=await mkdtemp(join(tmpdir(),'uai-demo-http-'));
 const previous={...process.env};process.env.UAI_BLOB_ROOT=join(folder,'blobs');process.env.UAI_DEMO_ROOT=join(folder,'history');process.env.UAI_DEMO_CONFIG=join(folder,'config.json');process.env.UAI_ENV='test';
 const app=createApi(pool!,clock);
 try{
   await transaction(pool!,async t=>{
    await t.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[s.application_id,s.organization_id,'worker fixture']);await t.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[s.account_id,s.organization_id,s.application_id,id('ext')]);
    const c=await new ConnectionService(t,clock).create(s,{provider:'fake',name:'worker fixture',account_scope:{fixture:'local'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{max_input_tokens:'2000'},risk_policy:{}},{actor_id:'test',reason:'Integration fixture'});
    await configureBudget(t,s,'provider',c.id,'1000000');await configureBudget(t,s,'period','period','1000000');
    const catalog=new CatalogService(t,clock);const models=await catalog.createDraft(s,{kind:'catalog',key:'models',version:1,payload:{models:[{id:'text-fixture',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'},{id:'image-fixture',provider:'fake',capabilities:['image.generate'],allowed_parameters:['count','size','quality','output_format'],status:'active'}]},author:'test',comment:'Synthetic fixtures'});await catalog.publish(s,models.id,models.revision);
    const rates=await catalog.createDraft(s,{kind:'rate_card',key:'prices',version:1,payload:{id:'test-rates',currency:'USD',source:'synthetic test rates',checked_at:clock.now().toISOString(),rates:[{id:'in',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'},{id:'out',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'},{id:'image',dimension:'output.image',unit:'images',unit_size:'1',amount:'0.00000001',effective_from:'2026-01-01T00:00:00Z'}]},author:'test',comment:'Synthetic fixture'});await catalog.publish(s,rates.id,rates.revision,[{usage:{state:'known',items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]},context:{at:clock.now().toISOString()}}]);
    for(const kind of ['text.generate','image.generate'] as const){const key=kind==='text.generate'?'text':'image';const route=await catalog.createDraft(s,{kind:'route',key,version:1,payload:{capability:kind,primary:{catalog_version_id:models.id,model:`${key}-fixture`,connection_id:c.id,max_cost_units:'6000'},deadline_seconds:3600,platform_risk_budget_units:'100000'},author:'test',comment:'Synthetic fixture'});await catalog.publish(s,route.id,route.revision);await publishRecipe(t,s,clock,{key,version:1,period_budget_key:'period',components:[{key:'result',capability:kind,route_version_id:route.id,rate_card_version_id:rates.id,count:{constant:1},limits:kind==='text.generate'?{input_tokens:2000,output_tokens:2000}:{image_count:1,image_sizes:['1024x1024'],image_qualities:['standard']}}]});}
    await grant(t,s,clock,{idempotency_key:'grant',source:'purchase',external_reference:id('receipt'),amount_units:'100000',expires_at:null,terms_version:'test'});
   });

 await transaction(pool!,async tx=>{const defs=(await tx.query('SELECT key,definition FROM recipe_versions WHERE application_id=$1',[s.application_id])).rows;
  for(const def of defs)await publishRecipe(tx,s,clock,{...def.definition,key:`${def.key}.standard`});
  await publishRecipe(tx,s,clock,{key:'demo.description-image',version:1,period_budget_key:'period',components:defs.map(r=>({...r.definition.components[0],key:r.key==='text'?'description':'image'}))});
  const bounded=defs.map(r=>({...r.definition.components[0],key:r.key==='text'?'description':'image',limits:r.key==='text'?{input_tokens:1000,output_tokens:128,max_assets:0}:{image_count:1,image_sizes:['1024x1024'],image_qualities:['low'],max_assets:0,parameter_values:{output_format:['png']}}}));
  for(const component of bounded)await publishRecipe(tx,s,clock,{key:`check.openai.${component.key==='description'?'text':'image'}`,version:1,period_budget_key:'period',components:[component]});
  await publishRecipe(tx,s,clock,{key:'check.openai.description-image',version:1,period_budget_key:'period',components:bounded});
 });
 const tokens=await transaction(pool!,async tx=>({app:await issueToken(tx,{...s,account_ids:[s.account_id],scopes:['ai:quote','ai:execute','ai:read','wallets:read','content:write'],max_grant_units:null,expires_at:null}),grant:await issueToken(tx,{...s,account_ids:[s.account_id],scopes:['credits:grant','credits:test-balance','wallets:read'],max_grant_units:'10000000',expires_at:null})}));
 const wallet=await transaction(pool!,tx=>getWallet(tx,s,clock)),base=await app.listen({host:'127.0.0.1',port:0});
 const config={api_url:base,account_id:s.account_id,wallet_id:wallet.id,app_token:tokens.app.token,grant_token:tokens.grant.token,session_secret:'test-session-secret-at-least-thirty-two',login_password:'test-password-sixteen-plus',max_grant_units:'10000000'};
 await writeFile(process.env.UAI_DEMO_CONFIG!,JSON.stringify(config));
 const call=async(body:unknown,cookie='')=>handle(new Request('http://demo.test/api',{method:'POST',headers:{origin:'http://demo.test','content-type':'application/json',cookie},body:JSON.stringify(body)}));
 expect((await call({action:'grant',key:'x',amount_credits:'1'})).status).toBe(401);
 const login=await call({action:'login',password:config.login_password});const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const referencePng=await (await import('sharp')).default({create:{width:32,height:16,channels:3,background:'#2277cc'}}).png().toBuffer();
 const uploadBody={action:'upload_reference',key:'reference',media_type:'image/png',base64:referencePng.toString('base64')};
 expect((await call(uploadBody)).status).toBe(401);
 expect((await call({...uploadBody,base64:'invalid!'},cookie)).status).toBe(422);
 const uploadResponse=await call(uploadBody,cookie);expect(uploadResponse.status).toBe(200);const reference=await uploadResponse.json();
 const referenceInfo=await app.inject({method:'GET',url:`/v1/assets/${reference.id}`,headers:{authorization:`Bearer ${tokens.app.token}`}});expect(referenceInfo.statusCode).toBe(200);expect(referenceInfo.json()).toMatchObject({id:reference.id,media_type:'image/png',size_bytes:String(referencePng.length)});

 const grants=await Promise.all([call({action:'grant',key:'same-grant',amount_credits:'1'},cookie),call({action:'grant',key:'same-grant',amount_credits:'1'},cookie)]);expect(grants.map(r=>r.status)).toEqual([200,200]);
 expect((await transaction(pool!,tx=>getWallet(tx,s,clock))).balance_units).toBe('1100000');
 process.env.UAI_ENV='production';expect((await call({action:'grant',key:'blocked',amount_credits:'1'},cookie)).status).toBe(403);process.env.UAI_ENV='test';
 const balance=await transaction(pool!,tx=>getWallet(tx,s,clock));
 expect((await call({action:'set_balance',key:'unauth',amount_credits:'0',expected_revision:balance.revision})).status).toBe(401);
 for(const amount of ['-1','1.0000001','11'])expect((await call({action:'set_balance',key:'invalid',amount_credits:amount,expected_revision:balance.revision},cookie)).status).toBe(422);
 process.env.UAI_ENV='production';expect((await call({action:'set_balance',key:'blocked-balance',amount_credits:'0',expected_revision:balance.revision},cookie)).status).toBe(403);process.env.UAI_ENV='test';
 const zero=await call({action:'set_balance',key:'zero',amount_credits:'0',expected_revision:balance.revision},cookie);expect(zero.status).toBe(200);const empty=(await zero.json()).wallet;expect(empty.available_units).toBe('0');
 const insufficientQuote=await (await call({action:'quote',key:'insufficient-quote',profile:'text.standard',prompt:'Insufficient balance test'},cookie)).json();
 const insufficient=await call({action:'invoke',key:'insufficient-invoke',quote_id:insufficientQuote.id,prompt:'Insufficient balance test'},cookie);expect(insufficient.status).toBe(402);expect((await insufficient.json()).error).toContain('Недостаточно доступных кредитов');
 const restored=await call({action:'set_balance',key:'restore',amount_credits:'1.1',expected_revision:empty.revision},cookie);expect(restored.status).toBe(200);expect((await restored.json()).wallet.available_units).toBe('1100000');
 const quoteResponse=await call({action:'quote',key:'quote',profile:'demo.description-image',prompt:'Create description and image'},cookie);expect(quoteResponse.status).toBe(200);const quote=await quoteResponse.json();
 const accept=await call({action:'invoke',key:'composite',quote_id:quote.id,profile:'demo.description-image',prompt:'Create description and image'},cookie);expect(accept.status).toBe(200);
 const deps=defaultRuntime(pool!,clock);deps.limits={scope:s};const original=deps.adapter;deps.adapter=async(scope,variant,context)=>variant.model==='image-fixture'?new FakeAdapter([{outcome:'success',bytes:Buffer.from('broken-image'),content_type:'image/png',usage:{state:'known',items:[{dimension:'output.image',quantity:'1',unit:'images'}]}}]):original(scope,variant,context);
 expect((await call({action:'refresh',id:'composite'},cookie)).status).toBe(200);expect((await executeOne(pool!,deps,clock)).state).toBe('succeeded');
 expect((await call({action:'refresh',id:'composite'},cookie)).status).toBe(200);
 for(let n=0;n<4;n++){await executeOne(pool!,deps,clock);const row=(await pool!.query("SELECT execution_status,not_before FROM execution_requests WHERE application_id=$1 AND component='image'",[s.application_id])).rows[0];if(row.execution_status==='failed')break;clock.advance(Math.max(0,new Date(row.not_before).getTime()-clock.now().getTime()));}
 expect((await call({action:'refresh',id:'composite'},cookie)).status).toBe(200);
 const rows=await new DemoStore(process.env.UAI_DEMO_ROOT!).read();expect(rows[0].status).toBe('partial');expect((rows[0].result as any).content.text).toContain('детерминированный');
 const counts=async()=>{const wallet=await transaction(pool!,tx=>getWallet(tx,s,clock));return {wallet,requests:(await pool!.query('SELECT count(*)::int count FROM execution_requests WHERE application_id=$1',[s.application_id])).rows[0].count,attempts:(await pool!.query('SELECT count(*)::int count FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id WHERE r.application_id=$1',[s.application_id])).rows[0].count}};
 const before=await counts();expect(before.wallet).toMatchObject({balance_units:'1099990',reserved_units:'0'});expect(before.requests).toBe(2);
 expect(rows[0].operation).toMatchObject({admission_status:'closed',settlement_status:'settled',reserved_units:'0',wallet:before.wallet});
 expect((await call({action:'refresh',id:'composite'},cookie)).status).toBe(200);expect(await counts()).toEqual(before);
 expect((await pool!.query('SELECT count(*)::int count FROM storage_manifests WHERE application_id=$1 AND content IS NOT NULL',[s.application_id])).rows[0].count).toBe(0);
 const state=await handle(new Request('http://demo.test/api',{headers:{cookie}}));const serialized=await state.text();expect(serialized).not.toContain(tokens.grant.token);expect(serialized).not.toContain(tokens.app.token);
 // Profile keys are opaque: published constraints determine input kind and parameters.
 const savedInputs=async(operationId:string)=>(await pool!.query('SELECT r.component,i.content FROM execution_requests r JOIN storage_inputs i ON i.id=r.input_ref WHERE r.application_id=$1 AND r.operation_id=$2 ORDER BY r.created_at,r.id',[s.application_id,operationId])).rows;
 for(const kind of ['text','image']){
  const profile=`check.openai.${kind}`,key=`bounded-${kind}`;
  const quoteReply=await call({action:'quote',key:`quote-${key}`,profile,prompt:'A small blue circle'},cookie);expect(quoteReply.status).toBe(200);const boundedQuote=await quoteReply.json();
  const invoked=await call({action:'invoke',key,quote_id:boundedQuote.id,profile,prompt:'A small blue circle'},cookie);expect(invoked.status).toBe(200);const ids=await invoked.json();
  const payload=(await savedInputs(ids.operation_id))[0].content;
  expect(payload.parameters).toEqual(kind==='text'?{max_output_tokens:128}:{count:1,size:'1024x1024',quality:'low',output_format:'png'});
  expect(payload.input).toEqual(kind==='text'?{messages:[{role:'user',content:'A small blue circle'}]}:{prompt:'A small blue circle'});
  expect((await call({action:'cancel',id:key},cookie)).status).toBe(200);
 }
 const profile='check.openai.description-image',key='bounded-composite';
 const quoted=await call({action:'quote',key:`quote-${key}`,profile,prompt:'Describe a small blue circle'},cookie);expect(quoted.status).toBe(200);const boundedQuote=await quoted.json();
 expect(boundedQuote.kind).toBe('recipe');
 const accepted=await call({action:'invoke',key,quote_id:boundedQuote.id,profile,prompt:'Describe a small blue circle'},cookie);expect(accepted.status).toBe(200);const compositeIds=await accepted.json();
 // A later publication must not change the parameters of the accepted operation.
 await transaction(pool!,async tx=>{const recipe=(await tx.query('SELECT definition FROM recipe_versions WHERE application_id=$1 AND key=$2 AND version=1',[s.application_id,profile])).rows[0].definition;await publishRecipe(tx,s,clock,{...recipe,version:2,components:recipe.components.map((c:any)=>({...c,limits:c.capability==='text.generate'?{...c.limits,output_tokens:64}:{...c.limits,image_qualities:['high']}}))})});
 expect((await call({action:'refresh',id:key},cookie)).status).toBe(200);
 expect((await savedInputs(compositeIds.operation_id))[0].content.parameters).toEqual({max_output_tokens:128});
 const png=await (await import('sharp')).default({create:{width:1024,height:1024,channels:4,background:'#2277cc'}}).png().toBuffer();
 deps.adapter=async(scope,variant,context)=>variant.model==='image-fixture'?new FakeAdapter([{outcome:'success',bytes:png,content_type:'image/png',usage:{state:'known',items:[{dimension:'output.image',quantity:'1',unit:'images'}]}}]):original(scope,variant,context);
 expect((await executeOne(pool!,deps,clock)).state).toBe('succeeded');
 const originalFetch=globalThis.fetch;let failedAck=false;
 const fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input).endsWith('/acknowledge')){failedAck=true;throw new Error('Simulated lost ACK request');}
  return originalFetch(input,init);
 });
 try{expect((await call({action:'refresh',id:key},cookie)).status).toBe(503);expect(failedAck).toBe(true)}finally{fetchSpy.mockRestore()}
 const savedBeforeAck=(await new DemoStore(process.env.UAI_DEMO_ROOT!).read()).find(r=>r.id===key)!;
 expect((savedBeforeAck.results as any).description.content.text).toContain('детерминированный');
 expect((await call({action:'refresh',id:key},cookie)).status).toBe(200);
 const imageInput=(await savedInputs(compositeIds.operation_id)).find(r=>r.component==='image').content;
 expect(imageInput.parameters).toEqual({count:1,size:'1024x1024',quality:'low',output_format:'png'});expect(imageInput.input.prompt).toContain('детерминированный');
 expect((await executeOne(pool!,deps,clock)).state).toBe('succeeded');
 expect((await call({action:'refresh',id:key},cookie)).status).toBe(200);
 const completed=(await new DemoStore(process.env.UAI_DEMO_ROOT!).read()).find(r=>r.id===key)!;expect(completed.status).toBe('succeeded');expect((completed.result as any).assets).toHaveLength(1);expect((completed.result as any).content.text).toContain('детерминированный');
 const completedCounts=await counts();expect(completed.operation).toMatchObject({admission_status:'closed',settlement_status:'settled',reserved_units:'0',wallet:completedCounts.wallet});
 expect((await pool!.query('SELECT count(*)::int count FROM storage_manifests WHERE operation_id=$1 AND content IS NOT NULL',[compositeIds.operation_id])).rows[0].count).toBe(0);
 expect((await call({action:'refresh',id:key},cookie)).status).toBe(200);expect(await counts()).toEqual(completedCounts);
 for(const enqueueFirst of [false,true]){
  const cancelKey=`cancel-composite-${enqueueFirst}`;
  const cancelQuote=await (await call({action:'quote',key:`quote-${cancelKey}`,profile,prompt:'Cancel before any provider dispatch'},cookie)).json();
  expect((await call({action:'invoke',key:cancelKey,quote_id:cancelQuote.id,profile,prompt:'Cancel before any provider dispatch'},cookie)).status).toBe(200);
  if(enqueueFirst)expect((await call({action:'refresh',id:cancelKey},cookie)).status).toBe(200);
  const atCancel=await counts();expect((await call({action:'cancel',id:cancelKey},cookie)).status).toBe(200);
  const immediateCancel=(await new DemoStore(process.env.UAI_DEMO_ROOT!).read()).find(r=>r.id===cancelKey)!;
  expect(immediateCancel.status).toBe('canceled');if(enqueueFirst)expect(immediateCancel.steps).toMatchObject({description:{status:'canceled'}});
  expect((await call({action:'refresh',id:cancelKey},cookie)).status).toBe(200);
  const canceled=(await new DemoStore(process.env.UAI_DEMO_ROOT!).read()).find(r=>r.id===cancelKey)!;
  expect(canceled.status).toBe('canceled');expect(canceled.operation).toMatchObject({admission_status:'closed',execution_status:'canceled',settlement_status:'settled',reserved_units:'0'});
  if(enqueueFirst)expect(canceled.steps).toMatchObject({description:{status:'canceled'}});
  const afterCancel=await counts();expect(afterCancel.requests).toBe(atCancel.requests);expect(afterCancel.attempts).toBe(atCancel.attempts);expect(afterCancel.wallet).toMatchObject({balance_units:completedCounts.wallet.balance_units,reserved_units:'0'});
  expect((await call({action:'refresh',id:cancelKey},cookie)).status).toBe(200);expect(await counts()).toEqual(afterCancel);
 }
 // A late cancellation must preserve the core terminal outcome in local history too.
 const singleKey='completed-single';
 const singleQuote=await (await call({action:'quote',key:`quote-${singleKey}`,profile:'check.openai.text',prompt:'Finish this text'},cookie)).json();
 expect((await call({action:'invoke',key:singleKey,quote_id:singleQuote.id,prompt:'Finish this text'},cookie)).status).toBe(200);
 expect((await executeOne(pool!,deps,clock)).state).toBe('succeeded');expect((await call({action:'refresh',id:singleKey},cookie)).status).toBe(200);
 const beforeLateCancel=await counts();
 for(const terminalKey of [singleKey,key,'composite']){
  const previous=(await new DemoStore(process.env.UAI_DEMO_ROOT!).read()).find(r=>r.id===terminalKey)!;
  expect((await call({action:'cancel',id:terminalKey},cookie)).status).toBe(200);
  const after=(await new DemoStore(process.env.UAI_DEMO_ROOT!).read()).find(r=>r.id===terminalKey)!;
  expect(after.status).toBe(previous.status);expect(after.result).toEqual(previous.result);expect(after.operation).toMatchObject({execution_status:(previous.operation as {execution_status:string}).execution_status,reserved_units:'0'});
  expect(await counts()).toEqual(beforeLateCancel);
 }
 const latest=await call({action:'quote',key:'quote-latest-version',profile,prompt:'A new circle'},cookie);expect(latest.status).toBe(200);expect((await latest.json()).recipe).toEqual({key:profile,version:2});


 // Paid API demo traverses the same authenticated backend, wallet and allowance.
 const paid=await transaction(pool!,async tx=>{
  const actor={actor_id:'test',reason:'Paid demo fixture'};
  const connection=await new ConnectionService(tx,clock).create(s,{provider:'fake',name:'API fixture',account_scope:{fixture:'paid-demo'},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},actor);
  const document=JSON.parse(await readFile(new URL('../../../../configurations/demo/firecrawl.json',import.meta.url),'utf8'));
  for(const resource of document.resources){
   if(resource.kind==='catalog')for(const model of resource.payload.models){model.provider='fake';model.adapter_ref='synthetic@1';model.api.provider='fake';model.api.adapter_ref='synthetic@1';}
   if(resource.kind==='tariff')resource.payload.provider='fake';
  }
  const release=await publishConfiguration(tx,s,document,{connections:{primary:connection.id},budgets:{period:'paid-demo'}},{path:'configurations/demo/firecrawl.json',git_revision:'a'.repeat(40),git_dirty:true,content_hash:'b'.repeat(64),publisher:'test'},clock);
  await activateConfiguration(tx,s,release.id,0,'test');
  const allowance=new AllowanceService(tx,clock),account=await allowance.createAccount(s,{provider:'fake',name:'Demo account',external_reference:'demo',reason:actor.reason},actor);
  const subscription=await allowance.createSubscription(s,{provider_account_id:account.id,tariff_version_id:release.resources.find((r:{kind:string})=>r.kind==='tariff')!.id,starts_at:clock.now().toISOString(),installation_share:{credits:'10'},reason:actor.reason},actor);
  await allowance.bindConnection(s,connection.id,{provider_account_id:account.id,subscription_id:subscription.id,reason:actor.reason},0,actor);
  await configureBudget(tx,s,'provider',connection.id,'100000000');await configureBudget(tx,s,'period','paid-demo','100000000');
  await grant(tx,s,clock,{idempotency_key:'paid-demo-fund',source:'internal',external_reference:'paid-demo',amount_units:'30000000',expires_at:null,terms_version:'test',reason:actor.reason});
  const reader=await issueToken(tx,{...s,account_ids:null,scopes:['operations:admin'],max_grant_units:null,expires_at:null});
  return {subscription_id:subscription.id,read_token:reader.token,profiles:[{operation:'scrape',profile:'demo.firecrawl.scrape'}]};
 });
 expect((await call({action:'api_status'})).status).toBe(401);
 expect(await (await call({action:'api_status'},cookie)).json()).toEqual({enabled:false});
 await writeFile(process.env.UAI_DEMO_CONFIG!,JSON.stringify({...config,paid_api:paid}));
 const apiState=await (await call({action:'api_status'},cookie)).json();expect(apiState.allowance.metrics[0]).toMatchObject({available:'10',consumed:'0'});expect(JSON.stringify(apiState)).not.toContain(paid.read_token);
 expect((await call({action:'api_quote',operation:'crawl',value:'https://example.com',key:'bad'},cookie)).status).toBe(422);
 expect((await call({action:'api_quote',operation:'scrape',value:'',key:'bad'},cookie)).status).toBe(422);
 const apiQuoteResponse=await call({action:'api_quote',operation:'scrape',value:'https://example.com',key:'paid-quote'},cookie);expect(apiQuoteResponse.status).toBe(200);const apiQuote=await apiQuoteResponse.json();
 const beforeApi=await counts();const invokeBody={action:'invoke',quote_id:apiQuote.id,prompt:'Read example',key:'paid-call'};
 const invocation=await call(invokeBody,cookie);expect(invocation.status).toBe(200);expect((await call(invokeBody,cookie)).status).toBe(200);
 expect((await counts()).requests).toBe(beforeApi.requests+1);
 const reserved=await (await call({action:'api_status'},cookie)).json();expect(reserved.allowance.metrics[0]).toMatchObject({available:'0',reserved:'10'});
 deps.adapter=async()=>new FakeAdapter([{outcome:'success',text:'{"ok":true}',usage:{state:'known',items:[{dimension:'credits',unit:'credits',quantity:'1'}]}}]);
 expect((await executeOne(pool!,deps,clock)).state).toBe('succeeded');
 expect((await call({action:'refresh',id:'paid-call'},cookie)).status).toBe(200);
 const paidRow=(await new DemoStore(process.env.UAI_DEMO_ROOT!).read()).find(r=>r.id==='paid-call')!;expect(paidRow.status).toBe('succeeded');expect(paidRow.operation).toMatchObject({captured_units:'2000000',reserved_units:'0'});
 const settled=await (await call({action:'api_status'},cookie)).json();expect(settled.allowance.metrics[0]).toMatchObject({available:'9',consumed:'1',reserved:'0'});
 const afterApi=await counts();expect((await call({action:'refresh',id:'paid-call'},cookie)).status).toBe(200);expect(await counts()).toEqual(afterApi);
 const tooLarge=await (await call({action:'api_quote',operation:'scrape',value:'https://example.com',key:'paid-quote-2'},cookie)).json();
 const blocked=await call({action:'invoke',quote_id:tooLarge.id,prompt:'Do not send',key:'paid-blocked'},cookie);expect(blocked.status).toBe(409);expect((await blocked.json()).code).toBe('allowance_exhausted');expect(await counts()).toEqual(afterApi);

 }finally{await app.close();for(const key of ['UAI_BLOB_ROOT','UAI_DEMO_ROOT','UAI_DEMO_CONFIG','UAI_ENV']){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]}await rm(folder,{recursive:true,force:true})}
 });
});
