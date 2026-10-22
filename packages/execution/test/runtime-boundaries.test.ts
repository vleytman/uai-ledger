import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {ExecutionTransport,deliveryId} from '../../queue/src/transport.js';
import Fastify from 'fastify';
import {registerNativeWebhooks} from '../../../apps/api/src/native-webhooks.js';
import {relayObservations} from '../../queue/src/observation-relay.js';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {wavFixture} from './fixtures/audio.js';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {providerAdmission} from '../../queue/src/provider-admission.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPool,transaction,type Tx} from '../../db/src/index.js';
import {ManualClock,id,DomainError,type Scope} from '../../contracts/src/index.js';
import {CatalogService} from '../../catalog/src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {grant,getWallet} from '../../accounting/src/index.js';
import {publishRecipe,createQuote,invoke,getOperation,settleRequest} from '../../quoting/src/index.js';
import {FakeAdapter,OpenAIAdapter,type ProviderAdapter,type AdapterContext,type ProviderInput,type ProviderResult,type FakeScenario,type NormalizedUsage} from '../../providers/src/index.js';
import {NotificationService,consumeExecutionEvents} from '../../notifications/src/index.js';
import {runOperationalMonitors} from '../../runtime-operations/src/index.js';
import {persistObservation,persistCost} from '../../pricing/src/index.js';
import {defaultRuntime} from '../src/default-runtime.js';
import {resolveExecutionPolicy} from '../../contracts/invocation.js';
import {executeOne,executeRequest,observeNativeOne,observeNativeRequest,receiveNativeWebhook,type WorkerDependencies} from '../src/runtime.js';
import {configureBudget,configureLimiter,getRequest,closeUnresolved,leaseObservation,observeAttempt,cancelRequest,recoverExpiredLeases,leaseNext,prepareDispatch,enableIncident,expireRequests,recordRemoteJob} from '../src/index.js';
import {getDelivery,expireContent,getAsset,registerAsset,acknowledge,contentHash,LocalBlobStore,leasePurge,purgeBlob,completePurge,deleteContent,finalizeDeletions,createManifest,restoreContentGuard,getInput} from '../../storage/src/index.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const database=isolatedTestDatabase(process.env.DATABASE_URL);let pool:ReturnType<typeof createPool>|null=null;
beforeAll(async()=>{if(process.env.DATABASE_URL){await database.initialize();pool=database.pool}});
const folders:string[]=[];afterAll(async()=>{await database.close();for(const f of folders)await rm(f,{recursive:true,force:true});});
const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
const known=(quantity='10'):NormalizedUsage=>({state:'known',items:[{dimension:'output.text',quantity,unit:'tokens'}]});
const pngSvg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="red"/></svg>');
interface Options{execution?:Record<string,unknown>;at?:Date;fallback?:boolean;separate_connections?:boolean;limiter_key?:string;deadline?:number;risk?:string;ttl?:number;schema?:Record<string,unknown>;expires_ms?:number;project?:string;connection_prices?:boolean}
async function fixture(options:Options={}){
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};const clock=new ManualClock(options.at??new Date('2026-09-18T12:00:00Z'));const directory=await mkdtemp(join(tmpdir(),'uai-boundary-'));folders.push(directory);let connections:any[]=[];
 await run(async t=>{
  await t.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Runtime boundary fixture']);await t.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
  const cs=new ConnectionService(t,clock);for(let i=0;i<(options.separate_connections?2:1);i++)connections.push(await cs.create(scope,{provider:'fake',name:`Credential ${i}`,account_scope:{provider_account:'shared-account'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{max_input_tokens:'1000'},risk_policy:{}},{actor_id:'fixture',reason:'Deterministic boundary test'}));
  for(const c of connections)await configureBudget(t,scope,'provider',c.id,'1000000');await configureBudget(t,scope,'period','period','1000000');if(options.limiter_key)await configureLimiter(t,scope,clock,{key:options.limiter_key,window_ms:60000,request_limit:1,token_limit:'100000',concurrency_limit:2});
  const catalog=new CatalogService(t,clock);const models=await catalog.createDraft(scope,{kind:'catalog',key:'models',version:1,payload:{models:['fixture-a','fixture-b'].map(model=>({id:model,provider:'fake',capabilities:['text.generate','image.generate','speech.synthesize'],allowed_parameters:['max_output_tokens','count','size','quality'],status:'active'}))},author:'fixture',comment:'Synthetic models'});await catalog.publish(scope,models.id,models.revision);
  const card=await catalog.createDraft(scope,{kind:'rate_card',key:'prices',version:1,payload:{id:'fixture-prices',currency:'USD',source:'synthetic tests only',checked_at:clock.now().toISOString(),rates:[...(options.connection_prices?[{id:'fallback-in',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:'0.000000002',connection_id:connections[1].id,effective_from:'2026-01-01T00:00:00Z'},{id:'fallback-out',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000002',connection_id:connections[1].id,effective_from:'2026-01-01T00:00:00Z'}]:[]),{id:'in',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'},{id:'cache',dimension:'input.cache_read',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'},{id:'out',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'},{id:'audio',dimension:'audio.characters',unit:'characters',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'},{id:'image',dimension:'output.image',unit:'images',unit_size:'1',amount:'0.00000001',effective_from:'2026-01-01T00:00:00Z'}]},author:'fixture',comment:'Synthetic rates'});await catalog.publish(scope,card.id,card.revision,[{usage:known(),context:{at:clock.now().toISOString()}}]);
  for(const key of ['text','text-other','image','primary-only','speech']){const kind=key==='image'?'image.generate':key==='speech'?'speech.synthesize':'text.generate';const target={catalog_version_id:models.id,model:key==='text-other'?'fixture-b':'fixture-a',connection_id:key==='text-other'?(connections[1]??connections[0]).id:connections[0].id,max_cost_units:'3000',...(options.limiter_key?{limiter_key:options.limiter_key}:{})};const route=await catalog.createDraft(scope,{kind:'route',key,version:1,payload:{capability:kind,primary:target,...(options.fallback&&key!=='primary-only'?{fallback:{...target,model:'fixture-b',connection_id:(connections[1]??connections[0]).id}}:{}),...(options.execution?{execution:options.execution}:{}),deadline_seconds:options.deadline??7200,platform_risk_budget_units:options.risk??'100000'},author:'fixture',comment:'Synthetic route'});await catalog.publish(scope,route.id,route.revision);await publishRecipe(t,scope,clock,{key,version:1,period_budget_key:'period',content_ttl_seconds:options.ttl??3600,components:[{key:'result',capability:kind,route_version_id:route.id,rate_card_version_id:card.id,count:{constant:1},...(options.schema?{response_schema:options.schema}:{}),limits:kind==='speech.synthesize'?{input_characters:100}:kind==='text.generate'?{input_tokens:1000,output_tokens:100,max_assets:1,image_input_tokens_per_asset:128}:{image_count:1,image_sizes:['1024x1024'],image_qualities:['standard']}}]});}
  await grant(t,scope,clock,{idempotency_key:'fund',source:'purchase',external_reference:id('purchase'),amount_units:'100000',expires_at:options.expires_ms?new Date(clock.now().getTime()+options.expires_ms).toISOString():null,terms_version:'fixture'});
 });
 const fresh=()=>{const old=process.env.UAI_BLOB_ROOT;process.env.UAI_BLOB_ROOT=directory;const deps=defaultRuntime(pool!,clock);if(old===undefined)delete process.env.UAI_BLOB_ROOT;else process.env.UAI_BLOB_ROOT=old;deps.limits={scope};deps.onDelta=undefined;return deps;};
 const deps=fresh();const create=(profile='text',input?:Record<string,unknown>,replayKey?:string)=>run(t=>invoke(t,scope,clock,{priority:'interactive',idempotency_key:replayKey??id('call'),...(options.project?{metadata:{external_project_id:options.project,project_generation:'1'}}:{}),profile,budget:{max_units:'3000'},input:input??(profile==='image'?{prompt:'fixture image'}:{text:'private fixture input',...(options.schema?{response_schema:options.schema}:{})}),parameters:profile==='speech'?{}:profile==='image'?{count:1,size:'1024x1024',quality:'standard'}:{max_output_tokens:100}}));
 const wallet=()=>run(t=>getWallet(t,scope,clock));const request=(rid:string)=>getRequest(pool!,scope,rid);const advanceRetry=async(rid:string)=>{const r=await request(rid);clock.advance(Math.max(0,new Date(r.not_before).getTime()-clock.now().getTime()));};
 const cost=async()=> (await pool!.query('SELECT state,rounded_units FROM provider_cost_entries WHERE organization_id=$1 ORDER BY priced_at,id',[scope.organization_id])).rows;
 const close=()=>run(t=>closeUnresolved(t,clock,deps.settle,scope));
 return {scope,clock,directory,connections,deps,fresh,create,wallet,request,advanceRetry,cost,close};
}
function script(f:Awaited<ReturnType<typeof fixture>>,scenarios:FakeScenario[]){const a=new FakeAdapter(scenarios);f.deps.adapter=async()=>a;return a;}
class NativeFixture extends FakeAdapter {
 override readonly capabilities={...new FakeAdapter().capabilities,native_jobs:true,lookup:true,cancel:true};
 submits=0;lookups=0;cancels=0;jobId='';ready=false;throwBeforeId=false;afterId?:()=>void;
 result:ProviderResult={outcome:'success',output:{content_type:'text/plain',text:'private native result'},usage:known('10')};
 async submitNative(_input:ProviderInput,context:AdapterContext){this.submits++;this.jobId=id('native');if(this.throwBeforeId)throw new Error('Lost submission response');await context.onRemoteJob!(this.jobId);if(this.afterId){this.afterId();throw new Error('Worker crashed after durable job id');}return {job_id:this.jobId};}
 async lookupNative(jobId:string,context:AdapterContext):Promise<ProviderResult|{outcome:'pending'}>{expect(jobId).toBe(this.jobId);this.lookups++;if(!this.ready)return {outcome:'pending'};await context.onUsage({event_id:`${jobId}:final`,kind:'final',revision:1,usage:this.result.usage,raw_usage:this.result.usage,provider_request_id:jobId});return this.result;}
 async cancelNative(jobId:string){expect(jobId).toBe(this.jobId);this.cancels++;}
 sign(body:Uint8Array){return createHmac('sha256','local-native-fixture-only').update(body).digest('hex');}
 async verifyNativeWebhook(body:Uint8Array,headers:Record<string,string>){const actual=Buffer.from(headers.signature??'','hex'),expected=Buffer.from(this.sign(body),'hex');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new DomainError('invalid_webhook_signature');return JSON.parse(Buffer.from(body).toString('utf8')) as {job_id:string;event_id:string;result:ProviderResult};}
}
describe.skipIf(!process.env.DATABASE_URL)('Runtime financial boundaries on PostgreSQL',()=>{
 it('accepts signed native HTTP events with original bytes and settles duplicate deliveries once',async()=>{
  const f=await fixture(),call=await f.create(),native=new NativeFixture();f.deps.adapter=async()=>native;await executeOne(pool!,f.deps,f.clock);
  const app=Fastify();registerNativeWebhooks(app,pool!,(scope,requestId,body,headers)=>receiveNativeWebhook(pool!,f.deps,scope,f.clock,requestId,body,headers));
  const send=(body:Buffer,signature=native.sign(body))=>app.inject({method:'POST',url:`/v1/provider-webhooks/${call.request_id}`,headers:{'content-type':'application/json',signature},payload:body});
  const body=Buffer.from(JSON.stringify({job_id:native.jobId,event_id:'http-native-final',result:native.result},null,2)+'\n');
  try{
   expect((await send(body,'bad')).statusCode).toBe(401);expect(await f.cost()).toHaveLength(0);
   const wrong=Buffer.from(JSON.stringify({job_id:'another-job',event_id:'wrong-job',result:native.result}));expect((await send(wrong)).statusCode).toBe(401);expect(await f.cost()).toHaveLength(0);
   expect((await send(body)).json()).toEqual({accepted:true});const wallet=await f.wallet();
   expect((await f.cost()).map(c=>c.rounded_units)).toEqual(['10']);
   expect((await send(body)).json()).toEqual({accepted:true});expect(await f.wallet()).toEqual(wallet);expect(await f.cost()).toHaveLength(1);expect(native.submits).toBe(1);
  }finally{await app.close()}
 });
 it('quoted final image edits dispatch exactly the prepared quote bytes and settle once from real adapter usage',async()=>{
  const f=await fixture(),sharp=(await import('sharp')).default;
  const method:import('../../model-pricing/src/index.js').ModelCalculation={version:1,source:'synthetic pipeline test',verification:'approximate',verified_at:f.clock.now().toISOString(),parameters:{size:{type:'string',values:['1024x1024'],default:'1024x1024'},quality:{type:'string',values:['medium'],default:'medium'}},preparation:{mode:'transform',auto_orient:true,max_assets:2,max_edge:512,fit:'contain',format:'png',allowed_dimensions:['512x512']},pricing:{safety_factor:'1.1',markup_percent:'50',rounding_units:'1'},components:[
   {key:'text',label:'Text',covers:['text_input'],maximum:'100',type:'tokens',direction:'input',tokenizer:'o200k_base',input_mode:'prompt',overhead:0,per_message:0,per_asset:0,result:{kind:'quantity',dimension:'input.uncached',unit:'tokens',conditions:{modality:'text'}}},
   {key:'references',label:'References',covers:['image_input'],maximum:'512',type:'formula',expression:{op:'multiply',args:[{op:'field',path:'input.asset_count'},{op:'constant',value:'256'}]},result:{kind:'quantity',dimension:'input.uncached',unit:'tokens',conditions:{modality:'image'}}},
   {key:'output',label:'Output',covers:['image_output'],maximum:'0.00000001',type:'lookup',parameters:['size','quality'],rows:[{parameters:{size:'1024x1024',quality:'medium'},value:'0.00000001'}],result:{kind:'usd'}}
  ],samples:[{name:'hello',input:{input:{prompt:'Hello'},parameters:{},assets:[]},expected:{text:'1',references:'0',output:'0.00000001'}}]};
  await run(async t=>{
   const catalog=new CatalogService(t,f.clock),versions=await catalog.list(f.scope);
   const existing=versions.find(v=>v.kind==='rate_card')!;
   const payload=existing.payload as import('../../pricing/src/index.js').RateCard;
   const card=await catalog.createDraft(f.scope,{kind:'rate_card',key:'edit-rates',version:1,author:'test',comment:'synthetic',payload:{...payload,rates:[...payload.rates,{id:'output-tokens',dimension:'output.image',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01'}]}});await catalog.publish(f.scope,card.id,1,[{usage:known(),context:{at:f.clock.now().toISOString()}}]);
   const models=await catalog.createDraft(f.scope,{kind:'catalog',key:'edit-model',version:1,author:'test',comment:'synthetic',payload:{models:[{id:'fixture-edit',provider:'fake',capabilities:['image.generate'],status:'active',allowed_parameters:['size','quality'],calculation:method,rate_card_version_id:card.id}]}});await catalog.publish(f.scope,models.id,1);
   const base=versions.find(v=>v.kind==='route'&&v.key==='image')!.payload as import('../../catalog/src/index.js').RouteDefinition;
   const route=await catalog.createDraft(f.scope,{kind:'route',key:'edit-route',version:1,author:'test',comment:'synthetic',payload:{...base,primary:{...base.primary,catalog_version_id:models.id,model:'fixture-edit'}}});await catalog.publish(f.scope,route.id,1);
   await publishRecipe(t,f.scope,f.clock,{key:'edit-final',version:1,period_budget_key:'period',components:[{key:'image',capability:'image.generate',route_version_id:route.id,rate_card_version_id:'',limits:{},count:{constant:1},pricing_mode:'quoted_final'}]});
  });
  const source=await sharp({create:{width:800,height:400,channels:3,background:'#336699'}}).jpeg().toBuffer();
  const blob=id('reference');await f.deps.blobStore.put(blob,source);
  const asset=await run(t=>registerAsset(t,f.scope,f.clock,{kind:'input',blob_key:blob,content_hash:contentHash(source),media_type:'image/jpeg',size_bytes:source.length,expires_at:new Date(f.clock.now().getTime()+3600000)}));
  const input={prompt:'Hello',asset_ids:[asset.id]},parameters={size:'1024x1024',quality:'medium'};
  const previousRoot=process.env.UAI_BLOB_ROOT;process.env.UAI_BLOB_ROOT=f.directory;
  let quote:Awaited<ReturnType<typeof createQuote>>;
  try{quote=await run(t=>createQuote(t,f.scope,f.clock,{idempotency_key:id('quote'),profile:'edit-final',input,parameters}));}finally{if(previousRoot===undefined)delete process.env.UAI_BLOB_ROOT;else process.env.UAI_BLOB_ROOT=previousRoot;}
  expect(quote!.price_units).toBe('441');
  const quoteRow=(await pool!.query('SELECT input_ref,components FROM quotes WHERE id=$1',[quote!.id])).rows[0];
  const snapshot=await getInput(pool!,f.scope,f.clock,quoteRow.input_ref);
  const prepared=(snapshot.content as any).prepared_assets[0];
  expect(JSON.stringify(quoteRow.components)).not.toContain(prepared.base64);
  const expected=Buffer.from(prepared.base64,'base64');expect(await sharp(expected).metadata()).toMatchObject({width:512,height:512,format:'png'});expect(contentHash(expected)).toBe(prepared.sha256);
  await expect(run(t=>invoke(t,f.scope,f.clock,{idempotency_key:id('changed'),profile:'edit-final',quote_id:quote!.id,input:{...input,prompt:'Changed'},parameters,budget:{max_units:'441'}}))).rejects.toMatchObject({code:'idempotency_conflict'});
  const accepted=await run(t=>invoke(t,f.scope,f.clock,{idempotency_key:'accept-edit',profile:'edit-final',quote_id:quote!.id,input,parameters,budget:{max_units:'441'}}));
  // The accepted quote owns prepared bytes. A later source overwrite cannot
  // substitute different content into the provider request.
  await writeFile(join(f.directory,blob),Buffer.from('changed after acceptance'));
  const output=await sharp({create:{width:1024,height:1024,channels:3,background:'#663399'}}).png().toBuffer();let calls=0;
  const adapter=new OpenAIAdapter({apiKey:'synthetic-test-key',models:['fixture-edit'],fetch:async(url,init)=>{
   calls++;expect(String(url)).toContain('/images/edits');const body=JSON.parse(init!.body as string);
   expect(body).toMatchObject({model:'fixture-edit',prompt:'Hello',size:'1024x1024',quality:'medium',n:1});expect(body.images).toEqual([{image_url:`data:image/png;base64,${prepared.base64}`}]);
   return Response.json({data:[{b64_json:output.toString('base64')}],usage:{input_tokens:303,input_tokens_details:{text_tokens:3,image_tokens:300},output_tokens:20}});
  }});f.deps.adapter=async()=>adapter;
  expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('succeeded');expect(calls).toBe(1);
  expect(await f.cost()).toEqual([expect.objectContaining({state:'calculated',rounded_units:'323'})]);
  expect(await f.wallet()).toMatchObject({balance_units:'99559',reserved_units:'0'});
  expect(await run(t=>getOperation(t,f.scope,f.clock,accepted.operation_id))).toMatchObject({captured_units:'441',reserved_units:'0'});
  expect(await getDelivery(pool!,f.scope,f.clock,accepted.request_id)).toMatchObject({status:'available'});
 });
 it('A50 damaged audio is never delivered or charged; only the valid retry is captured',async()=>{
  const f=await fixture();const call=await f.create('speech');
  const usage:NormalizedUsage={state:'known',items:[{dimension:'audio.characters',quantity:'10',unit:'characters'}]};
  const valid=wavFixture();const adapter=script(f,[{outcome:'success',bytes:valid.subarray(0,-2),content_type:'audio/wav',usage},{outcome:'success',bytes:valid,content_type:'audio/wav',usage}]);
  expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('waiting_retry');
  expect(await f.wallet()).toMatchObject({balance_units:'100000',reserved_units:'3000'});
  expect(await getDelivery(pool!,f.scope,f.clock,call.request_id)).toBeNull();
  expect((await pool!.query('SELECT id FROM storage_assets WHERE organization_id=$1',[f.scope.organization_id])).rows).toHaveLength(0);
  await f.advanceRetry(call.request_id);
  expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('succeeded');
  expect(adapter.calls).toHaveLength(2);expect(adapter.calls.every(c=>c.capability==='speech.synthesize')).toBe(true);
  expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});
  expect((await f.cost()).map(c=>c.rounded_units)).toEqual(['10','10']);
  expect((await pool!.query("SELECT spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'",[f.scope.organization_id])).rows[0]).toEqual({spent_units:'10',reserved_units:'0'});
  expect((await pool!.query('SELECT id FROM storage_assets WHERE organization_id=$1',[f.scope.organization_id])).rows).toHaveLength(1);
  expect(await getDelivery(pool!,f.scope,f.clock,call.request_id)).toMatchObject({status:'available'});
 });
 it('A18 A63 BlobStore failure preserves provider cost and releases the real claim after one hour',async()=>{
  const f=await fixture();const call=await f.create('image');script(f,[{outcome:'success',bytes:pngSvg,content_type:'image/svg+xml',usage:{state:'known',items:[{dimension:'output.image',quantity:'1',unit:'images'}]}}]);f.deps.blobStore={...f.deps.blobStore,put:async()=>{throw new Error('injected disk failure');},get:async()=>{throw new Error('missing');},delete:async()=>{}};
  await executeOne(pool!,f.deps,f.clock);expect(await f.cost()).toEqual([expect.objectContaining({state:'calculated',rounded_units:'10'})]);expect((await f.request(call.request_id)).settlement_status).toBe('unresolved');expect((await f.wallet()).reserved_units).toBe('3000');expect(await getDelivery(pool!,f.scope,f.clock,call.request_id)).toBeNull();f.clock.advance(3600000);expect(await f.close()).toBe(1);expect(await f.wallet()).toMatchObject({balance_units:'100000',reserved_units:'0'});expect(await f.close()).toBe(0);expect((await pool!.query(`SELECT spent_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'`,[f.scope.organization_id])).rows[0].spent_units).toBe('10');
 });
 it('A23 a real adapter 429 Retry-After releases its worker slot without a second early dispatch',async()=>{
  const f=await fixture();const call=await f.create();let sent=0;const adapter=new OpenAIAdapter({apiKey:'fixture-not-a-secret',models:['fixture-a'],fetch:async()=>{sent++;return new Response(JSON.stringify({error:{code:'rate_limit_exceeded'},usage:{input_tokens:0,output_tokens:0,input_tokens_details:{cached_tokens:0}}}),{status:429,headers:{'retry-after':'7'}});}});f.deps.adapter=async()=>adapter;
  expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('waiting_retry');const r=await f.request(call.request_id);expect(r.lease_owner).toBeNull();expect(new Date(r.not_before).getTime()-f.clock.now().getTime()).toBe(7000);expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);expect(sent).toBe(1);f.clock.advance(7000);await executeOne(pool!,f.deps,f.clock);expect(sent).toBe(2);
 });
 it('A24 429 billing quota locks the connection and prevents new provider dispatch',async()=>{
  const f=await fixture();const call=await f.create();let sent=0;const adapter=new OpenAIAdapter({apiKey:'fixture-not-a-secret',models:['fixture-a'],fetch:async()=>{sent++;return new Response(JSON.stringify({error:{code:'insufficient_quota'},usage:{input_tokens:0,output_tokens:0,input_tokens_details:{cached_tokens:0}}}),{status:429});}});f.deps.adapter=async()=>adapter;expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('failed');expect((await new ConnectionService(pool!,f.clock).get(f.scope,f.connections[0].id)).status).toBe('locked');expect((await f.request(call.request_id)).attempt_count).toBe(1);expect(await f.wallet()).toMatchObject({balance_units:'100000',reserved_units:'0'});await expect(f.create()).rejects.toMatchObject({code:'provider_unavailable_before_acceptance'});expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);expect(sent).toBe(1);
 });
 for(const separate of [false,true])it(`${separate?'A26':'A25'} published quota group is shared across ${separate?'two provider credentials':'two models'}`,async()=>{
  const f=await fixture({limiter_key:'provider-account:shared',separate_connections:separate});await f.create();const second=await f.create('text-other');let calls=0;const actual=f.deps.adapter;f.deps.adapter=async(...args)=>{const a=await actual(...args);const execute=a.execute.bind(a);a.execute=async(...p)=>{calls++;return execute(...p);};return a;};await executeOne(pool!,f.deps,f.clock);const waiting=await executeOne(pool!,f.deps,f.clock);expect(waiting.state).toBe('waiting');expect((await f.request(waiting.request_id!))).toMatchObject({attempt_count:0,reason:'waiting_rate_limit'});expect(calls).toBe(1);expect((await pool!.query('SELECT requests_used FROM execution_limiters WHERE organization_id=$1',[f.scope.organization_id])).rows[0].requests_used).toBe(1);f.clock.advance(60000);expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('succeeded');expect(calls).toBe(2);
 });
 it('A50 malformed JSON then valid output charges only the valid attempt and retains both provider costs',async()=>{
  const f=await fixture({schema:{type:'object',required:['count'],properties:{count:{type:'integer',minimum:1}},additionalProperties:false}});const call=await f.create();const adapter=script(f,[{outcome:'success',text:'{"count":0}',usage:known('7')},{outcome:'success',text:'{"count":1}',usage:known('10')}]);expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('waiting_retry');expect((await f.wallet()).balance_units).toBe('100000');await f.advanceRetry(call.request_id);expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('succeeded');expect(adapter.calls).toHaveLength(2);expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});expect((await f.cost()).map(c=>c.rounded_units).sort()).toEqual(['10','7']);expect((await pool!.query(`SELECT spent_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'`,[f.scope.organization_id])).rows[0].spent_units).toBe('7');
 });
 it('A28 a fallback that rejects the required schema never receives a provider execution',async()=>{
  const f=await fixture({fallback:true,schema:{type:'object',properties:{text:{type:'string'}},required:['text']}});const call=await f.create();const primary=new FakeAdapter([{outcome:'transient',usage:known('0')}]);let fallbackExecutes=0;f.deps.adapter=async(_s,v)=>{if(v.model==='fixture-a')return primary;const a=new FakeAdapter();a.validate=()=>{throw new DomainError('unsupported_schema');};a.execute=async()=>{fallbackExecutes++;throw new Error('must not execute');};return a;};for(let n=0;n<2;n++){await executeOne(pool!,f.deps,f.clock);await f.advanceRetry(call.request_id);}expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('failed');expect(fallbackExecutes).toBe(0);expect((await f.request(call.request_id)).attempt_count).toBe(2);expect((await f.wallet()).reserved_units).toBe('0');
 });
 it('A67 content expiry after a valid real capture does not refund or regenerate',async()=>{
  const f=await fixture({ttl:10});const call=await f.create();const adapter=script(f,[{outcome:'success',text:'charged and delivered'}]);await executeOne(pool!,f.deps,f.clock);expect((await f.wallet()).balance_units).toBe('99990');f.clock.advance(10000);expect((await getDelivery(pool!,f.scope,f.clock,call.request_id))?.status).toBe('expired');await run(t=>expireContent(t,f.clock,f.scope));expect((await getDelivery(pool!,f.scope,f.clock,call.request_id))?.result).toBeNull();expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);expect(adapter.calls).toHaveLength(1);
 });
 it('A82 successful output with unknown usage keeps risk and reserve until confirmed usage settles',async()=>{
  const f=await fixture();const call=await f.create();script(f,[{outcome:'success',text:'result before usage',usage:{state:'unknown',reason:'late_usage'}}]);await executeOne(pool!,f.deps,f.clock);expect((await f.request(call.request_id))).toMatchObject({execution_status:'succeeded',settlement_status:'unresolved'});expect((await f.wallet()).reserved_units).toBe('3000');const attempt=(await pool!.query('SELECT * FROM execution_attempts WHERE request_id=$1',[call.request_id])).rows[0];expect((await pool!.query(`SELECT state FROM execution_exposures WHERE attempt_id=$1`,[attempt.id])).rows.every(r=>r.state==='open')).toBe(true);f.clock.advance(1000);const lease=await run(t=>leaseObservation(t,f.scope,f.clock,call.request_id,'usage-lookup'));await run(t=>observeAttempt(t,f.scope,f.clock,{request_id:call.request_id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'confirmed-usage',outcome:'success',result_available:true,cost_units:'10',charged_units:'10'},f.deps.settle));expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});expect((await pool!.query(`SELECT reserved_units,spent_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'`,[f.scope.organization_id])).rows[0]).toMatchObject({reserved_units:'0',spent_units:'0'});
 });
 it('A56 an expired retry lease fences the old worker without duplicating uncertain work',async()=>{
  const f=await fixture({fallback:true}),call=await f.create();const adapter=script(f,[{outcome:'transient',usage:known('0')}]);
  await executeOne(pool!,f.deps,f.clock);await f.advanceRetry(call.request_id);
  const lease=await run(t=>leaseNext(t,f.clock,'crashed-retry',{scope:f.scope},f.deps.settle));
  const attempt=await run(t=>prepareDispatch(t,f.scope,f.clock,call.request_id,lease.fencing_token));
  f.clock.advance(30001);expect(await run(t=>recoverExpiredLeases(t,f.clock,f.scope))).toBe(1);
  expect(await f.request(call.request_id)).toMatchObject({execution_status:'outcome_unknown',attempt_count:2});
  expect((await executeOne(pool!,f.fresh(),f.clock)).worked).toBe(false);expect(adapter.calls).toHaveLength(1);
  await expect(run(t=>observeAttempt(t,f.scope,f.clock,{request_id:call.request_id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'stale-retry',outcome:'success',result_available:true,cost_units:'10',charged_units:'10'},f.deps.settle))).rejects.toMatchObject({code:'stale_lease'});
  expect((await f.wallet()).reserved_units).toBe('3000');
 });
 it('A56 cancellation during a retry retains unknown work until confirmed usage arrives',async()=>{
  const f=await fixture({fallback:true}),call=await f.create();script(f,[{outcome:'transient',usage:known('0')}]);
  await executeOne(pool!,f.deps,f.clock);await f.advanceRetry(call.request_id);
  let started!:()=>void,resolve!:(value:ProviderResult)=>void;
  const start=new Promise<void>(r=>started=r),finish=new Promise<ProviderResult>(r=>resolve=r);
  const adapter=new FakeAdapter();adapter.execute=async()=>{started();return finish;};f.deps.adapter=async()=>adapter;
  const running=executeOne(pool!,f.deps,f.clock);await start;
  await run(t=>cancelRequest(t,f.scope,f.clock,call.request_id,f.deps.settle));
  expect((await f.wallet()).reserved_units).toBe('3000');
  resolve({outcome:'unknown',failure:{kind:'unknown',code:'cancel_confirmation_lost',sent:true},usage:{state:'unknown',reason:'cancel_confirmation_lost'}});await running;
  expect((await f.request(call.request_id)).execution_status).toBe('outcome_unknown');
  expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);
  const lease=await run(t=>leaseObservation(t,f.scope,f.clock,call.request_id,'cancel-lookup'));
  const attempt=(await pool!.query('SELECT * FROM execution_attempts WHERE request_id=$1 ORDER BY number DESC LIMIT 1',[call.request_id])).rows[0];
  await run(t=>observeAttempt(t,f.scope,f.clock,{request_id:call.request_id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'cancellation-confirmed',outcome:'canceled',cost_units:'7',charged_units:'7'},f.deps.settle));
  expect(await f.wallet()).toMatchObject({balance_units:'99993',reserved_units:'0'});
  expect((await f.request(call.request_id)).attempt_count).toBe(2);
 });
 it('A57 A58 failed request retries do not lock unrelated work; health cannot enable an operator-locked connection',async()=>{
  const f=await fixture({fallback:true,separate_connections:true}),call=await f.create();const adapter=script(f,[{outcome:'transient',usage:known('0')}]);
  for(let n=0;n<4;n++){await executeOne(pool!,f.deps,f.clock);if(n<3)await f.advanceRetry(call.request_id);}
  expect(adapter.calls).toHaveLength(4);expect(await f.wallet()).toMatchObject({balance_units:'100000',reserved_units:'0'});
  const service=new ConnectionService(pool!,f.clock),connection=await service.get(f.scope,f.connections[0].id);
  const locked=await run(t=>new ConnectionService(t,f.clock).setStatus(f.scope,connection.id,connection.revision,'locked',{actor_id:'fixture',reason:'Operator lock'}));
  await run(t=>new ConnectionService(t,f.clock).recordHealth(f.scope,connection.id,locked.revision,'healthy',{actor_id:'fixture',reason:'Unpaid health fixture'}));
  await expect(f.create('primary-only')).rejects.toMatchObject({code:'provider_unavailable_before_acceptance'});
  const independent=await f.create('text-other');expect((await executeOne(pool!,f.fresh(),f.clock)).state).toBe('succeeded');expect((await f.request(independent.request_id)).attempt_count).toBe(1);
 });
 it('A60 fresh workers never reset the total request dispatch cap',async()=>{
  const f=await fixture({fallback:true}),call=await f.create(),adapter=new FakeAdapter([{outcome:'transient',usage:known('0')}]);
  for(let n=0;n<4;n++){const deps=f.fresh();deps.adapter=async()=>adapter;await executeOne(pool!,deps,f.clock);expect((await f.request(call.request_id)).attempt_count).toBe(n+1);if(n<3){expect((await f.wallet()).reserved_units).toBe('3000');await f.advanceRetry(call.request_id);}}
  expect(adapter.calls).toHaveLength(4);expect(await f.request(call.request_id)).toMatchObject({attempt_count:4,execution_status:'failed'});
  expect((await executeOne(pool!,f.fresh(),f.clock)).worked).toBe(false);expect((await f.wallet()).reserved_units).toBe('0');
 });
 it('settles a rejected credential at zero cost at once, unless the adapter leaves the charge open',async()=>{
  // LogoPanel real_projects, 2026-10-21: a 401 left the request unresolved for an hour and blocked key rotation.
  const f=await fixture(),call=await f.create();let sent=0;
  f.deps.adapter=async()=>new OpenAIAdapter({apiKey:'fixture-revoked',models:['fixture-a'],fetch:async()=>{sent++;return Response.json({error:{code:'invalid_api_key',message:'Incorrect API key provided'}},{status:401})}});
  await executeOne(pool!,f.deps,f.clock);
  const request=await f.request(call.request_id);
  expect(request).toMatchObject({execution_status:'failed',reason:'auth',attempt_count:1,settlement_status:'settled',unresolved_at:null});
  expect(request.financial_closed_at).not.toBeNull();
  expect((await pool!.query('SELECT status,cost_units,charged_units FROM execution_attempts WHERE request_id=$1',[call.request_id])).rows).toEqual([{status:'auth',cost_units:'0',charged_units:'0'}]);
  expect(await run(t=>getOperation(t,f.scope,f.clock,call.operation_id))).toMatchObject({captured_units:'0',reserved_units:'0'});
  expect((await f.wallet()).reserved_units).toBe('0');expect(sent).toBe(1);
  // An adapter that does not vouch for its refusal keeps the hourly financial closure.
  const g=await fixture(),other=await g.create();script(g,[{outcome:'auth',usage:{state:'unknown',reason:'fixture_refusal'}}]);
  await executeOne(pool!,g.deps,g.clock);
  expect(await g.request(other.request_id)).toMatchObject({execution_status:'failed',reason:'auth',settlement_status:'unresolved'});
 });
 describe('attempt timeout below the request deadline',()=>{
  // LogoPanel eval turn.v7, 2026-10-21: gpt-6-luna returned a request id and then nothing; UAI waited the whole 5-minute deadline.
  const answer={id:'resp_fixture',status:'completed',usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}},output:[{type:'message',content:[{type:'output_text',text:'Moderator reply'}]}]};
  const stalled=(signal?:AbortSignal|null)=>new Response(new ReadableStream({start(c){signal?.addEventListener('abort',()=>c.error(new DOMException('aborted','AbortError')))}}),{headers:{'content-type':'application/json','x-request-id':'req_hung'}});
  const openai=(f:Awaited<ReturnType<typeof fixture>>,plan:('hang'|'answer')[])=>{const sent:string[]=[];f.deps.adapter=async()=>new OpenAIAdapter({apiKey:'fixture-not-a-secret',models:['fixture-a'],fetch:async(_url,init)=>{const step=plan[sent.length]??'answer';sent.push(step);return step==='hang'?stalled(init?.signal):Response.json(answer)}});return sent;};
  const attempts=async(requestId:string)=>(await pool!.query('SELECT status,cost_units,timed_out_at IS NOT NULL AS timed_out,provider_idempotency_key FROM execution_attempts WHERE request_id=$1 ORDER BY number',[requestId])).rows;
  const timed=async(work:Promise<unknown>)=>{const started=Date.now();await work;return Date.now()-started;};

  it('cuts a silent call at the attempt timeout and retries it when the profile accepts a duplicate provider charge',async()=>{
   const f=await fixture({execution:{attempt_timeout_seconds:1,timeout_retry:'accept_duplicate_cost'}}),call=await f.create(),sent=openai(f,['hang','answer']);
   expect(await timed(executeOne(pool!,f.deps,f.clock))).toBeLessThan(5000);
   expect(await f.request(call.request_id)).toMatchObject({execution_status:'waiting_retry',reason:'transient',attempt_count:1});
   expect(await attempts(call.request_id)).toMatchObject([{status:'transient',cost_units:null,timed_out:true}]);
   await f.advanceRetry(call.request_id);await executeOne(pool!,f.deps,f.clock);
   expect(await f.request(call.request_id)).toMatchObject({execution_status:'succeeded',settlement_status:'settled',attempt_count:2});
   expect(sent).toEqual(['hang','answer']);
   const operation=await run(t=>getOperation(t,f.scope,f.clock,call.operation_id));
   expect(operation.reserved_units).toBe('0');expect(BigInt(operation.captured_units)).toBeGreaterThan(0n);
   const [first,second]=await attempts(call.request_id);expect(second.provider_idempotency_key).not.toBe(first.provider_idempotency_key);
  });
  it('leaves a non-idempotent timeout unknown at the attempt timeout instead of the deadline',async()=>{
   expect(()=>resolveExecutionPolicy({attempt_timeout_seconds:0})).toThrow();expect(()=>resolveExecutionPolicy({timeout_retry:'always'})).toThrow();
   const f=await fixture({execution:{attempt_timeout_seconds:1}}),call=await f.create(),sent=openai(f,['hang','answer']);
   expect(await timed(executeOne(pool!,f.deps,f.clock))).toBeLessThan(5000);
   expect(await f.request(call.request_id)).toMatchObject({execution_status:'outcome_unknown',settlement_status:'unresolved',attempt_count:1});
   expect(await attempts(call.request_id)).toMatchObject([{status:'outcome_unknown',cost_units:null,timed_out:true}]);
   expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);expect(sent).toEqual(['hang']);
  });
  it('retries an idempotent provider with the same idempotency key',async()=>{
   const f=await fixture({execution:{attempt_timeout_seconds:1}}),call=await f.create(),keys:(string|undefined)[]=[];
   class Idempotent extends FakeAdapter{
    override readonly capabilities={...new FakeAdapter().capabilities,idempotency:true};
    override async execute(input:ProviderInput,context:AdapterContext):Promise<ProviderResult>{
     keys.push(context.idempotency_key);
     if(keys.length===1)return new Promise(resolve=>context.signal!.addEventListener('abort',()=>resolve({outcome:'unknown',failure:{kind:'unknown',code:'transport_outcome_unknown',sent:true},usage:{state:'unknown',reason:'aborted'}})));
     return super.execute(input,context);
    }
   }
   const adapter=new Idempotent([{outcome:'success',text:'kept'}]);f.deps.adapter=async()=>adapter;
   await executeOne(pool!,f.deps,f.clock);await f.advanceRetry(call.request_id);await executeOne(pool!,f.deps,f.clock);
   expect(await f.request(call.request_id)).toMatchObject({execution_status:'succeeded',attempt_count:2});
   const [first,second]=await attempts(call.request_id);
   expect(first).toMatchObject({status:'transient',timed_out:true});
   expect(keys).toEqual([first.provider_idempotency_key,first.provider_idempotency_key]);
   expect(second.provider_idempotency_key).toBe(first.provider_idempotency_key);
  });
 });
 it('A61 a short deadline expires waiting work and releases the single reserve',async()=>{
  const f=await fixture({fallback:true,deadline:20}),call=await f.create(),adapter=script(f,[{outcome:'transient',usage:known('0')}]);
  await executeOne(pool!,f.deps,f.clock);expect((await f.wallet()).reserved_units).toBe('3000');
  f.clock.advance(20000);expect(await run(t=>expireRequests(t,f.clock,f.deps.settle,f.scope))).toBe(1);
  expect(await f.request(call.request_id)).toMatchObject({reason:'deadline_exceeded',attempt_count:1});
  expect((await f.wallet()).reserved_units).toBe('0');expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);expect(adapter.calls).toHaveLength(1);
 });
 it('A61 an exhausted platform loss budget terminates retries atomically without multiplying customer reserve',async()=>{
  const f=await fixture({fallback:true,risk:'3000'});const call=await f.create();const adapter=script(f,[{outcome:'transient',usage:known('1')}]);expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('waiting_retry');expect((await f.wallet()).reserved_units).toBe('3000');await f.advanceRetry(call.request_id);expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('failed');expect((await f.request(call.request_id))).toMatchObject({reason:'platform_risk_budget_exhausted',attempt_count:1});expect(adapter.calls).toHaveLength(1);expect(await f.wallet()).toMatchObject({balance_units:'100000',reserved_units:'0'});expect((await pool!.query(`SELECT reserved_units,spent_units FROM execution_budgets WHERE organization_id=$1 AND kind='request'`,[f.scope.organization_id])).rows[0]).toEqual({reserved_units:'0',spent_units:'1'});
 });
 it.skipIf(!process.env.REDIS_URL)('DIST-08 late cost after financial closure stays on the platform through BullMQ redelivery',async()=>{
  const f=await fixture({at:new Date()}),call=await f.create(),installation=id('late_cost');
  const transport=new ExecutionTransport(installation,process.env.REDIS_URL!),broker=providerAdmission(pool!,process.env.REDIS_URL!,installation);
  const results:Awaited<ReturnType<typeof executeRequest>>[]=[],errors:string[]=[];let calls=0;
  try{
   await run(async tx=>{
    await tx.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=$1",[call.request_id]);
    await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','test','synthetic')",[installation,f.scope.organization_id]);
    await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'rpm','requests',100,60000)",[installation]);
    await tx.query("INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,'fixture-a',$2)",[f.connections[0].id,installation]);
   });
   const adapter=script(f,[{outcome:'success',text:'Result before usage',usage:{state:'unknown',reason:'late_usage'}}]),execute=adapter.execute.bind(adapter);
   adapter.execute=async(...args)=>{calls++;return execute(...args)};
   Object.assign(f.deps,{admit:broker.admit,onRateLimits:broker.onRateLimits,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission});
   const worker=transport.consume('text',1,async delivery=>{const result=await executeRequest(pool!,{...f.deps,limits:{scope:f.scope,backend:'bullmq',generation:delivery.generation}},delivery.request_id,f.clock);results.push(result);return result},error=>errors.push(error.message));
   worker.on('failed',(_job,error)=>errors.push(error.message));
   const delivery={request_id:call.request_id,generation:0,purpose:'execute' as const};await transport.publish('text',delivery);
   await vi.waitFor(()=>expect(results).toHaveLength(1),{timeout:10000});
   expect(results[0].state).toBe('succeeded');expect((await f.request(call.request_id)).settlement_status).toBe('unresolved');
   const attempt=(await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[call.request_id])).rows[0];
   f.clock.advance(3600000);expect(await f.close()).toBe(1);
   const closedWallet=await f.wallet();expect(closedWallet).toMatchObject({balance_units:'100000',reserved_units:'0'});
   const late=await run(tx=>leaseObservation(tx,f.scope,f.clock,call.request_id,'late-observer'));
   await run(tx=>observeAttempt(tx,f.scope,f.clock,{request_id:call.request_id,attempt_id:attempt.id,fence:late.fencing_token,observation_key:'late-cost',outcome:'success',result_available:true,cost_units:'10',charged_units:'10'},f.deps.settle));
   expect((await f.request(call.request_id)).settlement_status).toBe('platform_absorbed');
   expect(await f.wallet()).toEqual(closedWallet);
   expect((await pool!.query('SELECT cost_units,charged_units FROM execution_attempts WHERE id=$1',[attempt.id])).rows[0]).toEqual({cost_units:'10',charged_units:'0'});
   await transport.queue('text').add('duplicate',delivery,{jobId:id('late-duplicate')});
   await vi.waitFor(()=>expect(results).toHaveLength(2),{timeout:10000});
   expect(results[1].worked).toBe(false);expect(calls).toBe(1);expect(errors).toEqual([]);
   expect(await f.wallet()).toEqual(closedWallet);
   expect((await pool!.query("SELECT spent_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'",[f.scope.organization_id])).rows[0].spent_units).toBe('10');
  }finally{await transport.close();await broker.close();const cleanup=new ExecutionTransport(installation,process.env.REDIS_URL!);try{await cleanup.queue('text').obliterate({force:true})}finally{await cleanup.close()}}
 });
 it('A64 lookup and worker restart do not move the one-hour timer or permit a late customer debit',async()=>{
  const f=await fixture({expires_ms:30000});const call=await f.create();script(f,[{outcome:'success',text:'result',usage:{state:'unknown',reason:'late_usage'}}]);await executeOne(pool!,f.deps,f.clock);const original=await f.request(call.request_id);const attempt=(await pool!.query('SELECT * FROM execution_attempts WHERE request_id=$1',[call.request_id])).rows[0];f.clock.advance(3599000);const lookup=await run(t=>leaseObservation(t,f.scope,f.clock,call.request_id,'restarted-worker'));await run(t=>observeAttempt(t,f.scope,f.clock,{request_id:call.request_id,attempt_id:attempt.id,fence:lookup.fencing_token,observation_key:'still-unknown',outcome:'success',result_available:true},f.deps.settle));expect(new Date((await f.request(call.request_id)).unresolved_at).getTime()).toBe(new Date(original.unresolved_at).getTime());expect(await f.close()).toBe(0);f.clock.advance(1000);expect(await run(t=>closeUnresolved(t,f.clock,f.fresh().settle,f.scope))).toBe(1);expect(await f.close()).toBe(0);expect(await f.wallet()).toMatchObject({balance_units:'0',reserved_units:'0'});
  const late=await run(t=>leaseObservation(t,f.scope,f.clock,call.request_id,'late-usage'));await run(t=>observeAttempt(t,f.scope,f.clock,{request_id:call.request_id,attempt_id:attempt.id,fence:late.fencing_token,observation_key:'late-confirmed',outcome:'success',result_available:true,cost_units:'10',charged_units:'10'},f.deps.settle));expect((await f.request(call.request_id)).settlement_status).toBe('platform_absorbed');expect(await f.wallet()).toMatchObject({balance_units:'0',reserved_units:'0'});expect((await pool!.query('SELECT charged_units FROM execution_attempts WHERE id=$1',[attempt.id])).rows[0].charged_units).toBe('0');expect((await pool!.query(`SELECT spent_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'`,[f.scope.organization_id])).rows[0].spent_units).toBe('10');
 });
 it('A83 downloaded output must be uploaded as a distinct input which survives old-result acknowledgement and purge',async()=>{
  const f=await fixture();const original=await f.create('image');await executeOne(pool!,f.deps,f.clock);const manifest=(await getDelivery(pool!,f.scope,f.clock,original.request_id))!;const output=await getAsset(pool!,f.scope,f.clock,manifest.result!.assets[0].id);await expect(f.create('text',{text:'reuse output',asset_ids:[output.id]})).rejects.toMatchObject({code:'invalid_input'});expect((await f.wallet()).reserved_units).toBe('0');const downloaded=await f.deps.blobStore.get(output.blob_key);const key=id('upload');await f.deps.blobStore.put(key,downloaded);const uploaded=await run(t=>registerAsset(t,f.scope,f.clock,{kind:'input',blob_key:key,content_hash:contentHash(downloaded),media_type:output.media_type,size_bytes:downloaded.length,expires_at:new Date(f.clock.now().getTime()+3600000)}));expect(uploaded.id).not.toBe(output.id);await run(t=>acknowledge(t,f.scope,f.clock,{request_id:original.request_id,version:manifest.version,manifest_hash:manifest.manifest_hash}));const purge=await run(t=>leasePurge(t,f.clock,'purge-worker',f.scope));expect(purge.asset_id).toBe(output.id);await purgeBlob(f.deps.blobStore,purge);await run(t=>completePurge(t,f.clock,purge.id,'purge-worker'));await expect(f.deps.blobStore.get(output.blob_key)).rejects.toMatchObject({code:'ENOENT'});expect(await f.deps.blobStore.get(key)).toEqual(downloaded);expect((await getAsset(pool!,f.scope,f.clock,uploaded.id,true)).status).toBe('available');const next=await f.create('text',{text:'new input',asset_ids:[uploaded.id]});expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('succeeded');expect((await f.request(next.request_id)).attempt_count).toBe(1);
 });

 for(const format of ['SVG','PNG'])it(`A50 malformed ${format} then a valid image charges only the valid attempt`,async()=>{
  const f=await fixture();const call=await f.create('image');const bad=format==='SVG'?Buffer.from('<svg><broken></svg>'):Buffer.from([137,80,78,71,13,10,26,10]);const usage:NormalizedUsage={state:'known',items:[{dimension:'output.image',quantity:'1',unit:'images'}]};const adapter=script(f,[{outcome:'success',bytes:bad,content_type:format==='SVG'?'image/svg+xml':'image/png',usage},{outcome:'success',bytes:pngSvg,content_type:'image/svg+xml',usage}]);expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('waiting_retry');expect((await f.wallet()).balance_units).toBe('100000');await f.advanceRetry(call.request_id);expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('succeeded');expect(adapter.calls).toHaveLength(2);expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});expect((await f.cost()).map(c=>c.rounded_units)).toEqual(['10','10']);expect((await pool!.query(`SELECT spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'`,[f.scope.organization_id])).rows[0]).toEqual({spent_units:'10',reserved_units:'0'});
 });
 it('A82 an explicitly authorized subsidy remains platform spend after the customer settlement',async()=>{
  const f=await fixture();const call=await f.create();script(f,[{outcome:'success',text:'subsidized result',usage:known('10')}]);const context=f.deps.context;f.deps.context=async(...args)=>{const c=await context(...args);return {...c,price_increase_allowed:true,current_rate_card:{...c.current_rate_card,rates:c.current_rate_card.rates.map(rate=>({...rate,amount:'0.000000002'}))}};};await executeOne(pool!,f.deps,f.clock);expect((await f.request(call.request_id)).settlement_status).toBe('settled');expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});expect((await f.cost()).map(c=>c.rounded_units)).toEqual(['20']);expect((await pool!.query(`SELECT spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'`,[f.scope.organization_id])).rows[0]).toEqual({spent_units:'10',reserved_units:'0'});
 });

 it('A33 confirmed cancellation with unknown usage can later settle its active cost exactly once',async()=>{
  const f=await fixture();const call=await f.create();const adapter=new FakeAdapter();adapter.execute=async()=>({outcome:'failure',failure:{kind:'canceled',code:'provider_canceled',sent:true},usage:{state:'unknown',reason:'cancel_usage_pending'}});f.deps.adapter=async()=>adapter;await executeOne(pool!,f.deps,f.clock);expect((await f.request(call.request_id))).toMatchObject({execution_status:'canceled',settlement_status:'unresolved'});const attempt=(await pool!.query('SELECT * FROM execution_attempts WHERE request_id=$1',[call.request_id])).rows[0];const lease=await run(t=>leaseObservation(t,f.scope,f.clock,call.request_id,'cancellation-usage'));await run(t=>observeAttempt(t,f.scope,f.clock,{request_id:call.request_id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'cancel-usage',outcome:'canceled',cost_units:'7',charged_units:'7'},f.deps.settle));expect(await f.wallet()).toMatchObject({balance_units:'99993',reserved_units:'0'});const late=await run(t=>leaseObservation(t,f.scope,f.clock,call.request_id,'duplicate-provider-usage'));await run(t=>observeAttempt(t,f.scope,f.clock,{request_id:call.request_id,attempt_id:attempt.id,fence:late.fencing_token,observation_key:'cancel-usage-again',outcome:'canceled',cost_units:'7',charged_units:'7'},f.deps.settle));expect(await f.wallet()).toMatchObject({balance_units:'99993',reserved_units:'0'});expect((await pool!.query('SELECT charged_units FROM execution_attempts WHERE id=$1',[attempt.id])).rows[0].charged_units).toBe('7');
 });

 it('A22 bounded SVG repair runs two primary plus two fallback attempts and captures only the valid fourth result',async()=>{
  const f=await fixture({fallback:true});const call=await f.create('image');const usage:NormalizedUsage={state:'known',items:[{dimension:'output.image',quantity:'1',unit:'images'}]};const bad:FakeScenario={outcome:'success',bytes:Buffer.from('<svg><broken></svg>'),content_type:'image/svg+xml',usage};const adapter=script(f,[bad,bad,bad,{outcome:'success',bytes:pngSvg,content_type:'image/svg+xml',usage}]);for(let n=0;n<4;n++){const result=await executeOne(pool!,f.deps,f.clock);expect(result.state).toBe(n===3?'succeeded':'waiting_retry');if(n<3){expect(await f.wallet()).toMatchObject({balance_units:'100000',reserved_units:'3000'});await f.advanceRetry(call.request_id);}}
  expect(adapter.calls).toHaveLength(4);expect((await pool!.query(`SELECT variant->>'model' model FROM execution_attempts WHERE request_id=$1 ORDER BY number`,[call.request_id])).rows.map(r=>r.model)).toEqual(['fixture-a','fixture-a','fixture-b','fixture-b']);expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});expect((await f.cost()).map(c=>c.rounded_units)).toEqual(['10','10','10','10']);expect((await pool!.query(`SELECT spent_units FROM execution_budgets WHERE organization_id=$1 AND kind='period'`,[f.scope.organization_id])).rows[0].spent_units).toBe('30');expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);
 });
 it('A27 failover loses cache but preserves image/schema constraints and uses the fallback connection tariff within one claim',async()=>{
  const schema={type:'object',required:['count'],properties:{count:{type:'integer'}},additionalProperties:false};const f=await fixture({fallback:true,separate_connections:true,connection_prices:true,schema});const blob=id('input');await f.deps.blobStore.put(blob,pngSvg);const input=await run(t=>registerAsset(t,f.scope,f.clock,{kind:'input',blob_key:blob,content_hash:contentHash(pngSvg),media_type:'image/svg+xml',size_bytes:pngSvg.length,expires_at:new Date(f.clock.now().getTime()+3600000)}));const call=await f.create('text',{text:'image constrained request',asset_ids:[input.id],response_schema:schema});const primary=new FakeAdapter([{outcome:'transient',usage:{state:'known',items:[{dimension:'input.cache_read',quantity:'100',unit:'tokens'}]}}]),fallback=new FakeAdapter([{outcome:'success',text:'{"count":1}',usage:{state:'known',items:[{dimension:'input.uncached',quantity:'100',unit:'tokens'},{dimension:'output.text',quantity:'10',unit:'tokens'}]}}]);f.deps.adapter=async(_s,v,c)=>{expect(c.input.assets?.[0].bytes).toEqual(pngSvg);expect(c.input.response_schema?.schema).toEqual(schema);expect(c.input.max_output_tokens).toBe(100);return v.model==='fixture-a'?primary:fallback;};for(let n=0;n<2;n++){await executeOne(pool!,f.deps,f.clock);expect((await f.wallet()).reserved_units).toBe('3000');await f.advanceRetry(call.request_id);}expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('succeeded');expect(primary.calls).toHaveLength(2);expect(fallback.calls).toHaveLength(1);expect(await f.wallet()).toMatchObject({balance_units:'99780',reserved_units:'0'});expect((await f.cost()).map(c=>c.rounded_units).sort()).toEqual(['100','100','220']);const target=(await pool!.query('SELECT variant FROM execution_attempts WHERE request_id=$1 ORDER BY number DESC LIMIT 1',[call.request_id])).rows[0].variant;expect(target).toMatchObject({connection_id:f.connections[1].id,model:'fixture-b',max_cost_units:'3000'});
 });
 it('A30 a crash after durable native job ID resumes bounded lookup of that job without a second submission',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();native.afterId=()=>f.clock.advance(30001);f.deps.adapter=async()=>native;await expect(executeOne(pool!,f.deps,f.clock)).rejects.toMatchObject({code:'stale_lease'});expect(native.submits).toBe(1);expect(await run(t=>recoverExpiredLeases(t,f.clock,f.scope))).toBe(1);expect((await f.request(call.request_id))).toMatchObject({execution_status:'running',attempt_count:1});const restarted=f.fresh();restarted.adapter=async()=>native;expect((await executeOne(pool!,restarted,f.clock)).worked).toBe(false);expect((await observeNativeOne(pool!,restarted,f.clock)).state).toBe('running');expect((await observeNativeOne(pool!,restarted,f.clock)).worked).toBe(false);expect(native.lookups).toBe(1);f.clock.advance(2000);native.ready=true;expect((await observeNativeOne(pool!,restarted,f.clock)).state).toBe('succeeded');expect(native.submits).toBe(1);expect(native.lookups).toBe(2);expect((await f.request(call.request_id)).attempt_count).toBe(1);expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});expect((await observeNativeOne(pool!,restarted,f.clock)).worked).toBe(false);
 });
 it('A30 lost native submission response without job ID stays unknown and never submits or looks up a guessed job',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();native.throwBeforeId=true;f.deps.adapter=async()=>native;expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('outcome_unknown');f.clock.advance(60000);expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);expect((await observeNativeOne(pool!,f.deps,f.clock)).worked).toBe(false);expect(native.submits).toBe(1);expect(native.lookups).toBe(0);expect((await f.request(call.request_id)).attempt_count).toBe(1);expect((await f.wallet()).reserved_units).toBe('3000');
 });
 it('A40 successful fallback ends one request without replacing the configured primary for later requests',async()=>{
  const f=await fixture({fallback:true}),call=await f.create();const adapter=script(f,[{outcome:'transient',usage:known('0')},{outcome:'transient',usage:known('0')},{outcome:'success',text:'fallback result'}]);
  for(let n=0;n<3;n++){await executeOne(pool!,f.deps,f.clock);if(n<2)await f.advanceRetry(call.request_id);}
  expect(adapter.calls.map(c=>c.model)).toEqual(['fixture-a','fixture-a','fixture-b']);
  expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});
  const later=await f.create();const fresh=f.fresh(),primary=new FakeAdapter();fresh.adapter=async()=>primary;
  expect((await executeOne(pool!,fresh,f.clock)).state).toBe('succeeded');expect(primary.calls[0].model).toBe('fixture-a');
  expect((await f.request(later.request_id)).attempt_count).toBe(1);
 });
 it('drains synchronous heartbeat before releasing quota and settling a successful response',async()=>{
  const f=await fixture();const call=await f.create();const adapter=script(f,[{outcome:'success',text:'completed',usage:known('10')}]);
  let started!:()=>void,released=false,renewalFinished=false;
  const renewing=new Promise<void>(resolve=>{started=resolve});
  f.deps.renewAdmission=async()=>{
   started();await new Promise(resolve=>setTimeout(resolve,100));
   if(released)throw new DomainError('quota_slot_lost');
   renewalFinished=true;
  };
  const execute=adapter.execute.bind(adapter);
  adapter.execute=async(...args)=>{await renewing;return execute(...args)};
  f.deps.onProviderResult=async()=>{released=true;await new Promise(resolve=>setTimeout(resolve,150))};
  expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('succeeded');
  expect(renewalFinished).toBe(true);
  expect((await f.request(call.request_id)).settlement_status).toBe('settled');
  expect(adapter.calls).toHaveLength(1);
  expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});
 },10000);
 it('renews the lease during slow native submission and drains heartbeat before releasing observation',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;
  let continued!:()=>void;const renewed=new Promise<void>(resolve=>{continued=resolve});
  f.deps.renewAdmission=async()=>{f.clock.advance(25000);continued()};
  const submit=native.submitNative.bind(native);
  native.submitNative=async(input,context)=>{await renewed;return submit(input,context)};
  f.deps.onNativePending=async()=>{
   const request=await f.request(call.request_id);
   expect(new Date(request.lease_expires_at).getTime()-f.clock.now().getTime()).toBe(30000);
  };
  expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('running');
  expect((await f.request(call.request_id)).lease_expires_at).toBeNull();expect(native.submits).toBe(1);
 },10000);
 it('aborts slow native submission when quota heartbeat fails and preserves the unknown outcome',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;
  f.deps.renewAdmission=async()=>{throw new DomainError('quota_slot_lost')};
  native.submitNative=async(_input,context)=>{
   native.submits++;
   await new Promise<void>(resolve=>context.signal!.addEventListener('abort',()=>resolve(),{once:true}));
   throw new Error('submission interrupted');
  };
  const results:string[]=[];f.deps.onProviderResult=async(_scope,_request,_attempt,result)=>{results.push(result.outcome)};
  expect((await executeOne(pool!,f.deps,f.clock)).state).toBe('lease_lost');
  expect(results).toEqual(['unknown']);expect(native.submits).toBe(1);
  f.clock.advance(30001);await run(tx=>recoverExpiredLeases(tx,f.clock,f.scope));
  expect((await f.request(call.request_id)).execution_status).toBe('outcome_unknown');
  expect((await executeOne(pool!,f.deps,f.clock)).worked).toBe(false);
 },10000);
 it('observes only the exact BullMQ request generation and poll revision, including competing delivery',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;
  await executeOne(pool!,f.deps,f.clock);
  const request=await f.request(call.request_id);
  const delivery={request_id:call.request_id,generation:Number(request.dispatch_generation),poll_count:0};
  // The delivery path cannot consume a request still owned by the legacy backend.
  expect((await observeNativeRequest(pool!,f.deps,delivery,f.clock)).worked).toBe(false);
  await pool!.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=$1",[call.request_id]);
  for(const stale of [{...delivery,request_id:id('missing')},{...delivery,generation:delivery.generation+1},{...delivery,poll_count:1}]){
   expect((await observeNativeRequest(pool!,f.deps,stale,f.clock)).worked).toBe(false);
  }
  expect(native.lookups).toBe(0);
  const results=await Promise.all([observeNativeRequest(pool!,f.deps,delivery,f.clock),observeNativeRequest(pool!,f.deps,delivery,f.clock)]);
  expect(results.filter(result=>result.worked)).toHaveLength(1);expect(native.lookups).toBe(1);
  f.clock.advance(2000);native.ready=true;
  expect((await observeNativeRequest(pool!,f.deps,delivery,f.clock)).worked).toBe(false);
  expect((await observeNativeRequest(pool!,f.deps,{...delivery,poll_count:1},f.clock)).state).toBe('succeeded');
  expect(native.lookups).toBe(2);expect(native.submits).toBe(1);
  expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});
 });
 it.skipIf(!process.env.REDIS_URL)('rebuilds lost native observation deliveries and observes through a BullMQ consumer',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;
  await executeOne(pool!,f.deps,f.clock);
  await pool!.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=$1",[call.request_id]);
  const transport=new ExecutionTransport(id('native-relay'),process.env.REDIS_URL!);
  const options={scope:f.scope,clock:f.clock};const errors:Error[]=[];
  try{
   expect((await observeNativeOne(pool!,{...f.deps,limits:{...f.deps.limits,backend:'legacy'}},f.clock)).worked).toBe(false);
   const concurrent=await Promise.all([relayObservations(pool!,transport,options),relayObservations(pool!,transport,options)]);
   expect(concurrent.reduce((n,result)=>n+result.published,0)).toBe(1);
   const delivery={request_id:call.request_id,generation:0,purpose:'observe' as const,poll_count:0};
   await (await transport.queue('observe').getJob(deliveryId(transport.installation,delivery)))!.remove();
   f.clock.advance(5000);
   const publish=transport.publish.bind(transport);
   transport.publish=async(...args)=>{await publish(...args);throw new Error('lost publication acknowledgement')};
   await expect(relayObservations(pool!,transport,options)).rejects.toThrow('lost publication acknowledgement');
   transport.publish=publish;f.clock.advance(5000);
   expect(await relayObservations(pool!,transport,options)).toEqual({checked:1,published:0});
   expect(await transport.queue('observe').getWaitingCount()).toBe(1);
   native.ready=true;
   transport.consume('observe',2,async job=>observeNativeRequest(pool!,f.deps,{request_id:job.request_id,generation:job.generation,poll_count:job.poll_count!},f.clock),error=>errors.push(error));
   await expect.poll(async()=>(await f.request(call.request_id)).execution_status).toBe('succeeded');
   await expect.poll(async()=>transport.queue('observe').getCompletedCount()).toBe(1);
   f.clock.advance(5000);expect((await relayObservations(pool!,transport,options)).checked).toBe(0);
   expect(native.submits).toBe(1);expect(native.lookups).toBe(1);expect(errors).toEqual([]);
   expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});
  }finally{await transport.close();const cleanup=new ExecutionTransport(transport.installation,process.env.REDIS_URL!);await cleanup.queue('observe').obliterate({force:true});await cleanup.close();}
 });
 it('enforces independent observation capacity and releases it after pending lookup',async()=>{
  const f=await fixture(),native=new NativeFixture();f.deps.adapter=async()=>native;
  const calls:Array<{request_id:string}>=[];for(let n=0;n<3;n++){calls.push(await f.create());await executeOne(pool!,f.deps,f.clock);}
  await pool!.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=ANY($1::text[])",[calls.map(call=>call.request_id)]);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  native.lookupNative=async()=>{native.lookups++;await gate;return {outcome:'pending'}};
  const deps={...f.deps,limits:{...f.deps.limits,global:0}};
  const delivery=(index:number)=>({request_id:calls[index]!.request_id,generation:0,poll_count:0});
  const running=[observeNativeRequest(pool!,deps,delivery(0),f.clock),observeNativeRequest(pool!,deps,delivery(1),f.clock)];
  try{
   await expect.poll(()=>native.lookups).toBe(2);
   expect((await observeNativeRequest(pool!,deps,delivery(2),f.clock)).worked).toBe(false);
   expect(native.lookups).toBe(2);
   const generation=await f.create();
   await pool!.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=$1",[generation.request_id]);
   const leased=await run(tx=>leaseNext(tx,f.clock,'generation-capacity',{scope:f.scope,backend:'bullmq',global:1,application:1,account:1},f.deps.settle,generation.request_id,true));
   expect(leased?.id).toBe(generation.request_id);
   const blocked=await f.create();await pool!.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=$1",[blocked.request_id]);
   expect(await run(tx=>leaseNext(tx,f.clock,'generation-full',{scope:f.scope,backend:'bullmq',global:1,application:1,account:1},f.deps.settle,blocked.request_id,true))).toBeNull();
  }finally{release();await Promise.all(running);}
  expect((await observeNativeRequest(pool!,deps,delivery(2),f.clock)).state).toBe('running');
  expect(native.lookups).toBe(3);expect(native.submits).toBe(3);
 });
 it('reports native submission, pending lookup and terminal lookup to the quota lifecycle',async()=>{
  const f=await fixture();await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;
  const events:string[]=[];
  f.deps.onNativePending=async()=>{events.push('pending')};
  f.deps.onProviderResult=async(_scope,_request,_attempt,result)=>{events.push(result.outcome)};
  await executeOne(pool!,f.deps,f.clock);
  await observeNativeOne(pool!,f.deps,f.clock);
  f.clock.advance(2000);native.ready=true;
  await observeNativeOne(pool!,f.deps,f.clock);
  expect(events).toEqual(['pending','pending','success']);expect(native.submits).toBe(1);
 });
 it('forwards native cancellation and lookup rate headers with the observing request and attempt',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;
  await executeOne(pool!,f.deps,f.clock);
  const seen:Array<{status:number;requestId:string;attemptId:string;remaining:string}>=[];
  f.deps.onRateLimits=async(scope,request,attempt,observation)=>{
   expect(scope).toEqual(f.scope);expect(request.fencing_token).toBeTruthy();
   seen.push({status:observation.status,requestId:request.id,attemptId:attempt.id,remaining:observation.headers['x-ratelimit-remaining-requests']!});
  };
  const report=async(context:AdapterContext,status:number,remaining:string)=>{
   await context.onRateLimits!({sent_at:f.clock.now().toISOString(),received_at:f.clock.now().toISOString(),status,headers:{'x-ratelimit-remaining-requests':remaining}});
  };
  const cancel=native.cancelNative.bind(native),lookup=native.lookupNative.bind(native);
  // Override the interface method here because the fixture's default cancel does not use context.
  (native as ProviderAdapter).cancelNative=async(job,context)=>{await report(context,202,'2');await cancel(job)};
  native.lookupNative=async(job,context)=>{await report(context,200,'1');return lookup(job,context)};
  await run(t=>cancelRequest(t,f.scope,f.clock,call.request_id,f.deps.settle));
  expect((await observeNativeOne(pool!,f.deps,f.clock)).state).toBe('running');
  expect(seen.map(row=>row.status)).toEqual([202,200]);
  expect(seen.map(row=>row.remaining)).toEqual(['2','1']);
  expect(seen.every(row=>row.requestId===call.request_id)).toBe(true);
  expect(new Set(seen.map(row=>row.attemptId)).size).toBe(1);
  expect(native.submits).toBe(1);expect(native.cancels).toBe(1);
 });
 it('A43 A70 project deletion preserves real captures and replay returns only IDs and deleted delivery metadata',async()=>{
  const project=id('project'),f=await fixture({project});const call=await f.create('text',undefined,'replay-key');script(f,[{outcome:'success',text:'private result before project deletion'}]);await executeOne(pool!,f.deps,f.clock);const pending=await f.create();const captured=(await pool!.query(`SELECT * FROM journal_postings WHERE wallet_id=$1 AND bucket='consumed' ORDER BY id`,[(await f.wallet()).id])).rows;expect(captured).toHaveLength(1);const deleted=await run(async t=>{await t.query('SELECT pg_advisory_xact_lock(41827430)');const d=await deleteContent(t,f.scope,f.clock,{external_project_id:project,project_generation:'1',reason:'Delete project fixture'});for(const r of d.requests)await cancelRequest(t,f.scope,f.clock,r.id,f.deps.settle);return d;});await run(t=>finalizeDeletions(t));expect((await f.request(pending.request_id)).execution_status).toBe('canceled');expect(await f.wallet()).toMatchObject({balance_units:'99990',reserved_units:'0'});expect((await pool!.query(`SELECT * FROM journal_postings WHERE wallet_id=$1 AND bucket='consumed' ORDER BY id`,[(await f.wallet()).id])).rows).toEqual(captured);const replay=await f.create('text',undefined,'replay-key');expect(replay.request_id).toBe(call.request_id);expect(JSON.stringify(replay)).not.toContain('private');expect((await getDelivery(pool!,f.scope,f.clock,call.request_id))).toMatchObject({status:'deleted',result:null});const events=(await pool!.query('SELECT * FROM outbox_events WHERE organization_id=$1 ORDER BY sequence',[f.scope.organization_id])).rows;expect(JSON.stringify(events)).not.toContain('private fixture input');expect(JSON.stringify(events)).not.toContain('private result before project deletion');const count=events.length;await consumeExecutionEvents(pool!,f.clock,1000);await consumeExecutionEvents(pool!,f.clock,1000);expect((await pool!.query('SELECT content FROM storage_inputs WHERE organization_id=$1',[f.scope.organization_id])).rows.every(r=>r.content===null)).toBe(true);expect((await pool!.query('SELECT status FROM storage_tombstones WHERE id=$1',[deleted.id])).rows[0].status).toBe('completed');
 });
 it('A62 finite retries emit failover without inventing a recovery cycle below the outage threshold',async()=>{
  const f=await fixture({fallback:true});await run(async t=>{const n=new NotificationService(t,f.clock);await n.saveRule(f.scope,{signal:'provider.degraded',severity:'critical',threshold:'0.5',minimum_samples:100,recipients:[],cooldown_seconds:300,enabled:true},{actor_id:'test',reason:'Mass failure requires100 observations'});await n.saveRule(f.scope,{signal:'provider.recovery_started',severity:'warning',minimum_samples:100,recipients:[],cooldown_seconds:300,enabled:true},{actor_id:'test',reason:'Lifecycle events are immediate'});});const call=await f.create();script(f,[{outcome:'transient',usage:known('0')}]);for(let n=0;n<4;n++){await executeOne(pool!,f.deps,f.clock);if(n<3)await f.advanceRetry(call.request_id);}await runOperationalMonitors(pool!,f.clock);await consumeExecutionEvents(pool!,f.clock,1000);const rows=await new NotificationService(pool!,f.clock).listIncidents(f.scope);expect(rows.filter(r=>r.signal==='provider.degraded')).toHaveLength(0);expect(rows.filter(r=>r.signal==='provider.recovery_started')).toHaveLength(0);expect((await pool!.query(`SELECT type FROM outbox_events WHERE organization_id=$1 AND type IN ('provider.failover_started','provider.recovery_started') ORDER BY sequence`,[f.scope.organization_id])).rows.map(r=>r.type)).toEqual(['provider.failover_started']);
 });
 it('A69 deletion during a native job blocks a signed late webhook and restored content while financial closure continues',async()=>{
  const project=id('project'),f=await fixture({project});const call=await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;await executeOne(pool!,f.deps,f.clock);const before=await f.request(call.request_id);await run(async t=>{await t.query('SELECT pg_advisory_xact_lock(41827430)');await deleteContent(t,f.scope,f.clock,{external_project_id:project,project_generation:'1',reason:'Delete active native project'});await cancelRequest(t,f.scope,f.clock,call.request_id,f.deps.settle);});const body=Buffer.from(JSON.stringify({job_id:native.jobId,event_id:'native-final',result:native.result}));await expect(receiveNativeWebhook(pool!,f.deps,f.scope,f.clock,call.request_id,body,{signature:'bad'})).rejects.toMatchObject({code:'invalid_webhook_signature'});expect((await f.cost())).toHaveLength(0);await receiveNativeWebhook(pool!,f.deps,f.scope,f.clock,call.request_id,body,{signature:native.sign(body)});expect((await f.cost()).map(c=>c.rounded_units)).toEqual(['10']);expect(await getDelivery(pool!,f.scope,f.clock,call.request_id)).toBeNull();expect((await receiveNativeWebhook(pool!,f.deps,f.scope,f.clock,call.request_id,body,{signature:native.sign(body)})).worked).toBe(false);expect(native.submits).toBe(1);expect((await f.wallet()).reserved_units).toBe('3000');f.clock.advance(3600000);await f.close();expect(await f.wallet()).toMatchObject({balance_units:'100000',reserved_units:'0'});
  await pool!.query(`UPDATE storage_inputs SET content=$2,status='available' WHERE id=$1`,[before.input_ref,{text:'restored private input'}]);await expect(getInput(pool!,f.scope,f.clock,before.input_ref)).rejects.toMatchObject({code:'content_deleted'});expect((await run(t=>restoreContentGuard(t,f.clock,f.scope))).tombstones).toBe(1);expect((await pool!.query('SELECT content,status FROM storage_inputs WHERE id=$1',[before.input_ref])).rows[0]).toEqual({content:null,status:'deleted'});expect((await observeNativeOne(pool!,f.deps,f.clock)).worked).toBe(false);expect(native.submits).toBe(1);expect(JSON.stringify((await pool!.query('SELECT * FROM outbox_events WHERE organization_id=$1',[f.scope.organization_id])).rows)).not.toContain('private native result');
 });

 it('A30 A33 native cancellation sends one cancel request and settles the later confirmed cost without resubmission',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;await executeOne(pool!,f.deps,f.clock);await run(t=>cancelRequest(t,f.scope,f.clock,call.request_id,f.deps.settle));await observeNativeOne(pool!,f.deps,f.clock);expect(native.cancels).toBe(1);expect((await f.wallet()).reserved_units).toBe('3000');f.clock.advance(2000);native.ready=true;native.result={outcome:'failure',failure:{kind:'canceled',code:'cancel_confirmed',sent:true},usage:known('7')};expect((await observeNativeOne(pool!,f.deps,f.clock)).state).toBe('canceled');expect(native.cancels).toBe(1);expect(native.submits).toBe(1);expect(await f.wallet()).toMatchObject({balance_units:'99993',reserved_units:'0'});
 });
 it('A34 a pending native cancellation starts a fixed one-hour financial timer even without a terminal provider result',async()=>{
  const f=await fixture();const call=await f.create();const native=new NativeFixture();f.deps.adapter=async()=>native;await executeOne(pool!,f.deps,f.clock);await run(t=>cancelRequest(t,f.scope,f.clock,call.request_id,f.deps.settle));const at=(await f.request(call.request_id)).unresolved_at;f.clock.advance(3599000);await observeNativeOne(pool!,f.deps,f.clock);expect((await f.request(call.request_id)).unresolved_at).toEqual(at);expect(await f.close()).toBe(0);f.clock.advance(1000);expect(await f.close()).toBe(1);expect(await f.wallet()).toMatchObject({balance_units:'100000',reserved_units:'0'});expect(native.submits).toBe(1);expect(native.cancels).toBe(1);
 });

});
