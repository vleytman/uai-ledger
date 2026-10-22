import {afterAll,describe,test,expect,vi} from 'vitest';
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
async function fixture(){
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};const clock=new ManualClock(new Date('2026-01-01T00:00:00Z'));const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
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
 const quote=(input:Partial<q.QuoteInput>={})=>run(tx=>q.createQuote(tx,scope,clock,{idempotency_key:id('key'),recipe:{key:'discussion',version:1},inputs:{participants:2},...input}));
 const invoke=(input:Partial<q.QuoteInput&{quote_id:string}>={})=>run(tx=>q.invoke(tx,scope,clock,{idempotency_key:id('invoke'),profile:'text',input:{messages:[{role:'user',content:'Hello'}]},parameters:{max_output_tokens:100},budget:{max_units:'3000'},...input}));
 return {scope,clock,run,def,quote,invoke,primary,fallback};
}
async function publishCalculated(f:Awaited<ReturnType<typeof fixture>>,options:{version?:number;rateCardId?:string;pricing?:import('../../model-pricing/src/index.js').ModelCalculation['pricing']}={}){
  const calc:import('../../model-pricing/src/index.js').ModelCalculation={version:1,source:'synthetic test',verification:'approximate',verified_at:'2026-01-01',parameters:{max_output_tokens:{type:'number',minimum:1,maximum:100,default:100}},preparation:{max_assets:0,max_edge:512,format:'png'},pricing:options.pricing??{safety_factor:'1.1',markup_percent:'50',rounding_units:'1'},components:[
   {key:'input',label:'Input',covers:['text_input'],maximum:'1000',result:{kind:'quantity',dimension:'input.uncached',unit:'tokens'},type:'tokens',direction:'input',tokenizer:'o200k_base',input_mode:'prompt',overhead:6,per_asset:0,per_message:0},
   {key:'output',label:'Output',covers:['text_output'],maximum:'100',result:{kind:'quantity',dimension:'output.text',unit:'tokens'},type:'tokens',direction:'output',policy:'configured_expected',expected:20,limit_parameter:'max_output_tokens'}
  ],samples:[{name:'hello',input:{input:{text:'Hello'},parameters:{max_output_tokens:100},assets:[]},expected:{input:'7',output:'20'}}]};
  await f.run(async tx=>{const catalog=new CatalogService(tx,f.clock);const old=(await catalog.get(f.scope,f.def.components[0].route_version_id)).payload as RouteDefinition;const models=await catalog.createDraft(f.scope,{kind:'catalog',key:'calculated',version:options.version??1,author:'test',comment:'test',payload:{models:[{id:'fake-text',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active',rate_card_version_id:options.rateCardId??f.def.components[0].rate_card_version_id,calculation:calc}]}});await catalog.publish(f.scope,models.id,1);
   const route=await catalog.createDraft(f.scope,{kind:'route',key:'calculated',version:options.version??1,author:'test',comment:'test',payload:{...old,primary:{...old.primary,catalog_version_id:models.id},fallback:{...old.fallback!,catalog_version_id:models.id}}});await catalog.publish(f.scope,route.id,1);await q.publishRecipe(tx,f.scope,f.clock,{...f.def,version:(options.version??1)+1,components:[{...f.def.components[0],route_version_id:route.id,rate_card_version_id:'',limits:{},pricing_mode:'quoted_final'}]});
  });
  return calc;
}
integration('Quoting atomic admission on PostgreSQL',()=>{
 test('UI-A01 invalid execution override never reserves and accepted override survives replay',async()=>{
  const f=await fixture();const before=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));
  await expect(f.invoke({execution:{max_attempts:0}})).rejects.toMatchObject({code:'invalid_execution_policy'});
  expect(await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).toEqual(before);
  const first=await f.invoke({idempotency_key:'policy',execution:{max_attempts:1}});
  const again=await f.invoke({idempotency_key:'policy',execution:{max_attempts:1}});expect(again.request_id).toBe(first.request_id);
  const request=await e.getRequest(pool!,f.scope,first.request_id);expect(request.route.execution.max_attempts).toBe(1);expect(request.route.billing.refused).toBe('platform');
 });
 test('distributed admission initializes the approved limits for a new application',async()=>{
  const f=await fixture();vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');
  try{
   const result=await f.invoke();
   expect((await pool!.query('SELECT account_limit,application_limit,max_queue_age_ms FROM execution_admission_policies WHERE organization_id=$1 AND application_id=$2',[f.scope.organization_id,f.scope.application_id])).rows[0]).toEqual({account_limit:20,application_limit:200,max_queue_age_ms:900000});
   expect((await pool!.query('SELECT execution_backend FROM execution_requests WHERE id=$1',[result.request_id])).rows[0].execution_backend).toBe('bullmq');
  }finally{vi.unstubAllEnvs()}
 });
 test('backpressure counts authorized recipe steps before reserving and preserves idempotent replay',async()=>{
  const f=await fixture();
  await pool!.query('INSERT INTO execution_admission_policies VALUES($1,$2,2,4,900000,1)',[f.scope.organization_id,f.scope.application_id]);
  const quote=await f.quote(),input={quote_id:quote.id,client_operation_key:'admitted',idempotency_key:'admitted'};
  const accepted=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,input));
  const before=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));
  const extra=await f.quote({inputs:{participants:1}});
  await expect(f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:extra.id,client_operation_key:'overflow',idempotency_key:'overflow'}))).rejects.toMatchObject({code:'queue_backpressure',status:429,details:{reason:'account_backlog'}});
  const increase=await f.quote({operation_id:accepted.id,inputs:{participants:3}});
  await expect(f.run(tx=>q.amend(tx,f.scope,f.clock,{operation_id:accepted.id,quote_id:increase.id,idempotency_key:'increase'}))).rejects.toMatchObject({code:'queue_backpressure'});
  expect(await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).toEqual(before);
  expect((await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,input))).id).toBe(accepted.id);
  expect((await pool!.query('SELECT id FROM operations WHERE organization_id=$1',[f.scope.organization_id])).rows).toHaveLength(1);
 });
 test('concurrent admissions cannot both consume the last backlog slot',async()=>{
  const f=await fixture();
  await pool!.query('INSERT INTO execution_admission_policies VALUES($1,$2,1,2,900000,1)',[f.scope.organization_id,f.scope.application_id]);
  const quotes=await Promise.all([f.quote({inputs:{participants:1}}),f.quote({inputs:{participants:1}})]);
  const results=await Promise.allSettled(quotes.map((quote,n)=>f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:`race-${n}`,idempotency_key:`race-${n}`}))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'queue_backpressure'}});
  expect((await pool!.query('SELECT id FROM operations WHERE organization_id=$1',[f.scope.organization_id])).rows).toHaveLength(1);
 });
 test('application backlog and queue age reject new reserves without changing the wallet',async()=>{
  const f=await fixture();
  await pool!.query('INSERT INTO execution_admission_policies VALUES($1,$2,1,1,900000,1)',[f.scope.organization_id,f.scope.application_id]);
  await f.run(tx=>e.enqueue(tx,{...f.scope,account_id:id('another-account')},f.clock,{operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'test',input_ref:'test',route:{primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(f.clock.now().getTime()+3600000)}));
  const before=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));
  await expect(f.invoke()).rejects.toMatchObject({code:'queue_backpressure',details:{reason:'application_backlog'}});
  await pool!.query('UPDATE execution_admission_policies SET account_limit=20,application_limit=200 WHERE organization_id=$1',[f.scope.organization_id]);
  f.clock.advance(900001);
  await expect(f.invoke()).rejects.toMatchObject({code:'queue_backpressure',details:{reason:'queue_age'}});
  expect(await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).toEqual(before);
  expect((await pool!.query('SELECT id FROM operations WHERE organization_id=$1',[f.scope.organization_id])).rows).toHaveLength(0);
 });

 test('central per-character speech pricing admits text and enforces the model quantity bound',async()=>{
  const f=await fixture();
  await f.run(async tx=>{
   const catalog=new CatalogService(tx,f.clock);
   const rates=await catalog.createDraft(f.scope,{kind:'rate_card',key:'speech-cost',version:1,author:'test',comment:'synthetic',payload:{id:'speech',currency:'USD',source:'synthetic',checked_at:'2026-01-01',rates:[{id:'chars',dimension:'audio.characters',unit:'characters',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01'}]}});
   await catalog.publish(f.scope,rates.id,1,[{usage:{state:'known',items:[{dimension:'audio.characters',unit:'characters',quantity:'2'}]},context:{at:f.clock.now().toISOString()}}]);
   const calculation:import('../../model-pricing/src/index.js').ModelCalculation={version:1,source:'synthetic',verification:'approximate',verified_at:'2026-01-01',parameters:{},preparation:{max_assets:0,max_edge:512,format:'png'},pricing:{safety_factor:'2',markup_percent:'50',rounding_units:'1'},components:[{key:'speech',label:'Speech',covers:['audio_output'],maximum:'5',type:'per_unit',source:'characters',character_mode:'unicode',step:'1',rounding:'ceil',result:{kind:'quantity',dimension:'audio.characters',unit:'characters'}}],samples:[{name:'emoji',input:{input:{text:'a😀'},parameters:{},assets:[]},expected:{speech:'2'}}]};
   const models=await catalog.createDraft(f.scope,{kind:'catalog',key:'speech-model',version:1,author:'test',comment:'synthetic',payload:{models:[{id:'fake-speech',provider:'fake',status:'active',capabilities:['speech.synthesize'],allowed_parameters:[],rate_card_version_id:rates.id,calculation}]}});await catalog.publish(f.scope,models.id,1);
   const original=(await catalog.get(f.scope,f.def.components[0].route_version_id)).payload as RouteDefinition;
   const route=await catalog.createDraft(f.scope,{kind:'route',key:'speech-route',version:1,author:'test',comment:'synthetic',payload:{...original,capability:'speech.synthesize',primary:{...original.primary,catalog_version_id:models.id,model:'fake-speech'},fallback:undefined}});await catalog.publish(f.scope,route.id,1);
   await q.publishRecipe(tx,f.scope,f.clock,{key:'speech-final',version:1,period_budget_key:'test-period',components:[{key:'speech',capability:'speech.synthesize',route_version_id:route.id,rate_card_version_id:'',count:{constant:1},limits:{},pricing_mode:'quoted_final'}]});
  });
  const quote=await f.quote({profile:'speech-final',recipe:{key:'speech-final',version:1},kind:'single_call',inputs:{},input:{text:'a😀'},parameters:{}});
  expect(quote.price_units).toBe('6');
  const accepted=await f.invoke({profile:'speech-final',quote_id:quote.id,input:{text:'a😀'},parameters:{},budget:{max_units:'6'}});
  expect(accepted.request_id).toBeTruthy();
  await expect(f.quote({profile:'speech-final',recipe:{key:'speech-final',version:1},kind:'single_call',inputs:{},input:{text:'abcdef'},parameters:{}})).rejects.toThrow(/exceeds speech bounds/);
 });
 test('published model pricing and rates change new quotes without changing an accepted final quote',async()=>{
  const f=await fixture();const method=await publishCalculated(f);
  const input={input:{text:'Hello'},parameters:{max_output_tokens:100}};
  const quote=await f.quote({profile:'text',kind:'single_call',recipe:{key:'text',version:2},inputs:{},...input});
  const accepted=await f.invoke({quote_id:quote.id,...input,budget:{max_units:'45'}});
  await publishNewRate(f,'0.002');
  const rates=await f.run(async tx=>(await new CatalogService(tx,f.clock).list(f.scope)).find(v=>v.kind==='rate_card'&&v.key==='text-rates'&&v.version===2)!);
  await publishCalculated(f,{version:2,rateCardId:rates.id,pricing:{safety_factor:'2',markup_percent:'100',rounding_units:'1'}});
  const next=await f.quote({profile:'text',kind:'single_call',recipe:{key:'text',version:3},inputs:{},...input});
  expect(next.price_units).toBe('216');expect((await f.run(tx=>q.getQuote(tx,f.scope,quote.id))).price_units).toBe('45');
  const context=await f.run(tx=>q.getExecutionContext(tx,f.scope,f.clock,accepted.request_id));
  expect(context.component.calculation_snapshot.method.pricing).toEqual(method.pricing);
  expect(context.accepted_rate_card_version_id).toBe(f.def.components[0].rate_card_version_id);
  expect(context.current_rate_card_version_id).toBe(rates.id);
  const request=await f.run(tx=>e.leaseNext(tx,f.clock,'old-final',{scope:f.scope}));
  const attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'done',outcome:'success',cost_units:'70',result_available:true},(t,sc,i)=>q.settleRequest(t,sc,f.clock,i)));
  expect(await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id))).toMatchObject({captured_units:'45',reserved_units:'0'});
 });
 test('parallel final-price admissions cannot spend the same available credits and retries are idempotent',async()=>{
  const f=await fixture();await publishCalculated(f);
  const wallet=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));
  await f.run(tx=>a.setTestAvailableBalance(tx,f.scope,f.clock,{idempotency_key:'set-45',available_units:'45',expected_revision:wallet.revision}));
  const input={input:{text:'Hello'},parameters:{max_output_tokens:100},budget:{max_units:'45'}};
  const quotes=await Promise.all([1,2].map(()=>f.quote({profile:'text',kind:'single_call',recipe:{key:'text',version:2},inputs:{},...input})));
  const commands=quotes.map((quote,i)=>({...input,quote_id:quote.id,idempotency_key:`parallel-${i}`}));
  const results=await Promise.allSettled(commands.map(command=>f.invoke(command)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;expect(rejected.reason).toMatchObject({code:'insufficient_credits'});
  const index=results.findIndex(r=>r.status==='fulfilled'),accepted=(results[index] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.invoke>>>).value;
  const replays=await Promise.all([1,2].map(()=>f.invoke(commands[index])));expect(replays.every(r=>r.request_id===accepted.request_id)).toBe(true);
  expect(await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).toMatchObject({available_units:'0',reserved_units:'45',balance_units:'45'});
  expect((await pool!.query('SELECT id FROM execution_requests WHERE organization_id=$1',[f.scope.organization_id])).rows).toHaveLength(1);
  const request=await f.run(tx=>e.leaseNext(tx,f.clock,'parallel-final',{scope:f.scope}));
  await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  // Provider exposure still follows the route cap, not the 45-unit retail price.
  const exposures=(await pool!.query("SELECT reserved_units FROM execution_exposures WHERE attempt_id IN (SELECT id FROM execution_attempts WHERE request_id=$1) AND kind='provider'",[request.id])).rows;
  expect(exposures).toEqual([{reserved_units:'2000'}]);
 });
 test('racing final-price success and cancellation settles once in the winning transaction order',async()=>{
  const f=await fixture();await publishCalculated(f);
  const accepted=await f.invoke({input:{text:'Hello'},parameters:{max_output_tokens:100},budget:{max_units:'45'}});
  const request=await f.run(tx=>e.leaseNext(tx,f.clock,'race-final',{scope:f.scope})),attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  await Promise.all([
   f.run(tx=>q.cancel(tx,f.scope,f.clock,{operation_id:accepted.operation_id,idempotency_key:'racing-cancel'})),
   f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'racing-success',outcome:'success',cost_units:'1500',result_available:true},(t,sc,i)=>q.settleRequest(t,sc,f.clock,i)))
  ]);
  const operation=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id));
  expect(['0','45']).toContain(operation.captured_units);expect(operation.reserved_units).toBe('0');
  const state=await e.getRequest(pool!,f.scope,request.id);expect(operation.captured_units).toBe(state.execution_status==='succeeded'?'45':'0');
  const finalWallet=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));expect(finalWallet.balance_units).toBe((100000n-BigInt(operation.captured_units)).toString());
 });
 test('prepares scoped references from verified source bytes, normalizes orientation and rejects changed content',async()=>{
  const f=await fixture(),sharp=(await import('sharp')).default;
  const {registerAsset,contentHash}=await import('../../storage/src/index.js');
  const {prepareModelAssets}=await import('../src/prepare-model-assets.js');
  const source=await sharp({create:{width:800,height:400,channels:3,background:'#336699'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  let stored=source;const blobs={get:async()=>stored,put:async()=>{},delete:async()=>{}};
  const asset=await f.run(tx=>registerAsset(tx,f.scope,f.clock,{kind:'input',blob_key:id('blob'),content_hash:contentHash(source),media_type:'image/jpeg',size_bytes:source.length,expires_at:new Date(f.clock.now().getTime()+10000)}));
  const method={preparation:{mode:'transform',auto_orient:true,max_assets:2,max_edge:512,format:'png',allowed_dimensions:['256x512']}} as import('../../model-pricing/src/index.js').ModelCalculation;
  const prepared=await f.run(tx=>prepareModelAssets(tx,f.scope,f.clock,method,[asset.id],blobs));
  const bytes=Buffer.from(prepared[0].base64,'base64');expect(await sharp(bytes).metadata()).toMatchObject({width:256,height:512,format:'png'});
  expect(prepared[0]).toMatchObject({id:asset.id,width:256,height:512,source_hash:contentHash(source),sha256:contentHash(bytes),content_type:'image/png'});
  await expect(f.run(tx=>prepareModelAssets(tx,{...f.scope,account_id:id('foreign')},f.clock,method,[asset.id],blobs))).rejects.toMatchObject({code:'not_found'});
  stored=Buffer.from('changed');await expect(f.run(tx=>prepareModelAssets(tx,f.scope,f.clock,method,[asset.id],blobs))).rejects.toMatchObject({code:'invalid_asset'});
  stored=source;f.clock.advance(10001);await expect(f.run(tx=>prepareModelAssets(tx,f.scope,f.clock,method,[asset.id],blobs))).rejects.toMatchObject({code:'content_unavailable'});
 });

 test.each(['success','lower-cost','cancel','invalid','unknown-cost','late','retry','fallback'] as const)('model final quote preserves the agreed price and accounting for %s',async(scenario)=>{
  const f=await fixture();
  const calc=await publishCalculated(f);
  const quote=await f.quote({profile:'text',recipe:{key:'text',version:2},kind:'single_call',inputs:{},input:{text:'Hello'},parameters:{max_output_tokens:100}});
  expect(quote).toMatchObject({settlement:'quoted_final',price_units:'45',estimated_units:'45',max_units:'45'});
  const accepted=await f.invoke({quote_id:quote.id,input:{text:'Hello'},parameters:{max_output_tokens:100},budget:{max_units:'45'}});
  const request=await f.run(tx=>e.leaseNext(tx,f.clock,'calculated',{scope:f.scope}));expect(request.route.customer_price_units).toBe('45');expect(request.route.primary.max_cost_units).toBe('2000');
  let attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  const settle=(t:Tx,sc:Scope,i:any)=>q.settleRequest(t,sc,f.clock,i);
  const failures=scenario==='fallback'?2:scenario==='retry'?1:0;
  for(let n=0;n<failures;n++){
   await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:`defect-${n}`,outcome:'defect',cost_units:'1500',charged_units:'1500',result_available:false},settle));
   expect(await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id))).toMatchObject({captured_units:'0',reserved_units:'45'});
   f.clock.advance(31000);Object.assign(request,await f.run(tx=>e.leaseNext(tx,f.clock,`calculated-retry-${n}`,{scope:f.scope})));
   attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  }
  if(scenario==='fallback')expect(attempt.variant.connection_id).toBe(f.fallback);
  if(scenario==='cancel')await f.run(tx=>q.cancel(tx,f.scope,f.clock,{operation_id:accepted.operation_id,idempotency_key:'cancel-final'}));
  if(scenario==='late'){
   await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'unknown',outcome:'unknown'},settle));
   f.clock.advance(3600001);await f.run(tx=>e.closeUnresolved(tx,f.clock,settle,f.scope));
   const lease=await f.run(tx=>e.leaseObservation(tx,f.scope,f.clock,request.id,'late-calculated'));request.fencing_token=lease.fencing_token;
  }
  const observation={request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'done',outcome:scenario==='invalid'?'invalid' as const:'success' as const,cost_units:scenario==='unknown-cost'?undefined:scenario==='lower-cost'?'1':'1500',charged_units:'1500',result_available:true};
  await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,observation,settle));
  await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,observation,settle));
  expect(await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id))).toMatchObject({captured_units:['success','lower-cost','unknown-cost','retry','fallback'].includes(scenario)?'45':'0',reserved_units:'0'});
  if(failures){
   const attempts=(await pool!.query('SELECT cost_units,charged_units FROM execution_attempts WHERE request_id=$1 ORDER BY number',[request.id])).rows;
   expect(attempts).toEqual([...Array.from({length:failures},()=>({cost_units:'1500',charged_units:'0'})),{cost_units:'1500',charged_units:'45'}]);
  }
  const auth=(await pool!.query('SELECT component FROM request_authorizations WHERE request_id=$1',[request.id])).rows[0].component;
  expect(auth.limits).toMatchObject({input_tokens:1000,output_tokens:100,max_assets:0});expect(auth.rate_card_version_id).toBe(f.def.components[0].rate_card_version_id);expect(auth.calculation_snapshot.method.pricing).toEqual(calc.pricing);expect(auth.calculation_snapshot.breakdown.provider_estimate_units).toBe('27');
 });

 test('fixed customer price is independent of provider cost; cancellation, unknown cost and late results preserve accounting',async()=>{
  for(const scenario of ['success','cancel','invalid','unknown-cost','late'] as const){
   const f=await fixture();await f.run(tx=>q.publishRecipe(tx,f.scope,f.clock,{...f.def,version:2,components:[{...f.def.components[0],billing:{mode:'fixed',source:'fixture',price_parameters:[],prices:[{parameters:{},units:'5000'}]}}]}));
   const accepted=await f.invoke({budget:{max_units:'5000'}});const request=await f.run(tx=>e.leaseNext(tx,f.clock,'fixed',{scope:f.scope}));expect(request.max_units).toBe('5000');expect(request.route.primary.max_cost_units).toBe('2000');
   const attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));const settle=(t:Tx,sc:Scope,i:any)=>q.settleRequest(t,sc,f.clock,i);
   if(scenario==='cancel')await f.run(tx=>q.cancel(tx,f.scope,f.clock,{operation_id:accepted.operation_id,idempotency_key:'cancel'}));
   if(scenario==='late'){await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'unknown',outcome:'unknown'},settle));f.clock.advance(3600001);await f.run(tx=>e.closeUnresolved(tx,f.clock,settle,f.scope));const lease=await f.run(tx=>e.leaseObservation(tx,f.scope,f.clock,request.id,'late-fixed'));request.fencing_token=lease.fencing_token;}
   await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'final',outcome:scenario==='invalid'?'invalid':'success',cost_units:scenario==='unknown-cost'?undefined:'1500',charged_units:'1500',result_available:true},settle));
   const result=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id));expect(result.captured_units).toBe(['success','unknown-cost'].includes(scenario)?'5000':'0');expect(result.reserved_units).toBe('0');
   // Replaying the same provider observation never captures twice.
   await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'final',outcome:scenario==='invalid'?'invalid':'success',cost_units:scenario==='unknown-cost'?undefined:'1500',charged_units:'1500',result_available:true},settle));
  }
 });

 test('fixed technical retry charges once while keeping both provider expenses',async()=>{
  const f=await fixture();await f.run(tx=>q.publishRecipe(tx,f.scope,f.clock,{...f.def,version:2,components:[{...f.def.components[0],billing:{mode:'fixed',source:'fixture',price_parameters:[],prices:[{parameters:{},units:'5000'}]}}]}));
  const accepted=await f.invoke({budget:{max_units:'5000'}}),settle=(t:Tx,sc:Scope,input:any)=>q.settleRequest(t,sc,f.clock,input);
  for(const [i,outcome] of ['defect','success'].entries()){
   const request=await f.run(tx=>e.leaseNext(tx,f.clock,`fixed-retry-${i}`,{scope:f.scope}));const attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
   await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:`try-${i}`,outcome:outcome as 'defect'|'success',cost_units:'1500',charged_units:'1500',result_available:outcome==='success'},settle));f.clock.advance(31000);
  }
  const result=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id));expect(result.captured_units).toBe('5000');expect(result.reserved_units).toBe('0');const attempts=(await pool!.query('SELECT cost_units,charged_units FROM execution_attempts WHERE request_id=$1 ORDER BY number',[accepted.request_id])).rows;expect(attempts).toEqual([{cost_units:'1500',charged_units:'0'},{cost_units:'1500',charged_units:'5000'}]);
 });

 test('versioned request estimates reduce reserves without changing accepted quotes or input binding',async()=>{
  const f=await fixture();const estimation={version:1 as const,tokenizer:'o200k_base' as const,source:'fixture',rules:[{source:'input_tokens' as const,dimension:'input.uncached',unit:'tokens' as const,maximum:1000},{source:'output_tokens' as const,dimension:'output.text',unit:'tokens' as const,maximum:100,expected:20}]};
  await f.run(tx=>q.publishRecipe(tx,f.scope,f.clock,{...f.def,version:2,components:[{...f.def.components[0],estimation}]}));
  const input={kind:'single_call' as const,recipe:{key:'text',version:2},inputs:{},input:{text:'Hello'},parameters:{max_output_tokens:100}};
  const quote=await f.quote(input);expect(BigInt(quote.max_units)).toBeLessThan(3000n);expect(BigInt(quote.estimated_units)).toBeLessThan(BigInt(quote.max_units));
  const legacy=await f.quote({...input,recipe:{key:'text',version:1}});expect(legacy.max_units).toBe('3000');
  await expect(f.invoke({quote_id:quote.id,input:{text:'Different'}})).rejects.toMatchObject({code:'idempotency_conflict'});
  expect((await f.run(tx=>q.getQuote(tx,f.scope,quote.id))).max_units).toBe(quote.max_units);
  const composite=await f.quote({kind:'recipe',recipe:{key:'text',version:2},inputs:{}});expect(BigInt(composite.max_units)).toBeGreaterThan(BigInt(quote.max_units));
  const tooLarge={...estimation,rules:[{...estimation.rules[0],maximum:5000}]};await f.run(tx=>q.publishRecipe(tx,f.scope,f.clock,{...f.def,key:'too-large',components:[{...f.def.components[0],estimation:tooLarge}]}));
  await expect(f.quote({recipe:{key:'too-large',version:1},inputs:{}})).rejects.toMatchObject({code:'route_cost_limit'});
 });

 test('structured authorized parameters survive storage and key reordering without allowing substitutions',async()=>{
  const f=await fixture();
  const outputFormat={container:'wav',encoding:'pcm_s16le',sample_rate:44100};
  await f.run(tx=>q.publishRecipe(tx,f.scope,f.clock,{...f.def,key:'structured',components:[{...f.def.components[0],limits:{...f.def.components[0].limits,parameter_values:{output_format:[outputFormat]}}}]}));
  const input={profile:'structured',input:{text:'Hello'},parameters:{max_output_tokens:100,output_format:{sample_rate:44100,container:'wav',encoding:'pcm_s16le'}}};
  const quoted=await f.quote({...input,kind:'single_call',recipe:undefined,inputs:{}});
  const before=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));
  for(const format of [{...outputFormat,sample_rate:48000},{...outputFormat,extra:true},{container:'wav'},'wav',null]){
   await expect(f.invoke({...input,parameters:{max_output_tokens:100,output_format:format}})).rejects.toMatchObject({code:'request_exceeds_recipe'});
  }
  expect(await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).toEqual(before);
  const accepted=await f.invoke({...input,quote_id:quoted.id});
  const context=await f.run(tx=>q.getExecutionContext(tx,f.scope,f.clock,accepted.request_id));
  expect(context.payload.parameters?.output_format).toEqual(outputFormat);
 });
 test('reserves one successful expensive fallback per component, not all retries',async()=>{
  const f=await fixture();const quote=await f.quote();expect(quote).toMatchObject({max_units:'6000',estimated_units:'6000',confidence:'conservative'});
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).reserved_units).toBe('0');
  const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'workflow',idempotency_key:'accept'}));expect(op).toMatchObject({accepted_max_units:'6000',reserved_units:'6000'});
 });
 test('quote binding and concurrent accept prevent duplicate reservations',async()=>{
  const f=await fixture();const quote=await f.quote();
  const values=await Promise.all([1,2].map(i=>f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'same',idempotency_key:`accept-${i}`}))));expect(values[0].id).toBe(values[1].id);
  await expect(f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'different',idempotency_key:'other'}))).rejects.toMatchObject({code:'quote_already_bound'});
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).reserved_units).toBe('6000');
 });
 test('expired quotes and unfunded providers produce no reservation',async()=>{
  const f=await fixture();const quote=await f.quote();f.clock.advance(900001);
  await expect(f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'expired',idempotency_key:'expired'}))).rejects.toMatchObject({code:'quote_expired'});
  const current=await f.quote();await f.run(async tx=>{await e.configureBudget(tx,f.scope,'provider',f.primary,'0');await e.configureBudget(tx,f.scope,'provider',f.fallback,'0');});
  await expect(f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:current.id,client_operation_key:'unfunded',idempotency_key:'unfunded'}))).rejects.toMatchObject({code:'provider_unavailable_before_acceptance'});
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).reserved_units).toBe('0');
 });
 test('atomic invocation observes caller budget, closes admission and survives content deletion replay',async()=>{
  const f=await fixture();await expect(f.invoke({idempotency_key:'too-small',budget:{max_units:'2999'}})).rejects.toMatchObject({code:'budget_conflict'});
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).reserved_units).toBe('0');
  const result=await f.invoke({idempotency_key:'single'});expect(result.accepted_max_units).toBe('3000');
  const op=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,result.operation_id));expect(op.admission_status).toBe('closed');expect(op.requests).toHaveLength(1);
  await f.run(tx=>s.deleteContent(tx,f.scope,f.clock,{operation_id:op.id,reason:'test deletion'}));
  const replay=await f.invoke({idempotency_key:'single'});expect(replay.operation_id).toBe(result.operation_id);expect(replay.request_id).toBe(result.request_id);
  expect((await pool!.query('SELECT count(*)::integer n FROM execution_requests WHERE operation_id=$1',[op.id])).rows[0].n).toBe(1);
 });
 test('single-call quote binds prompt and accepted input outlives preview TTL',async()=>{
  const f=await fixture();const quote=await f.quote({kind:'single_call',recipe:undefined,inputs:{},profile:'text',input:{text:'Original'},parameters:{max_output_tokens:100},execution:{deadline_seconds:1800}});
  await expect(f.invoke({quote_id:quote.id,input:{text:'Changed'}})).rejects.toMatchObject({code:'idempotency_conflict'});
  const result=await f.run(tx=>q.invoke(tx,f.scope,f.clock,{idempotency_key:'accepted-preview',quote_id:quote.id}));
  f.clock.advance(901000);await f.run(tx=>s.expireContent(tx,f.clock,f.scope));
  const context=await f.run(tx=>q.getExecutionContext(tx,f.scope,f.clock,result.request_id));expect(context.payload.input.text).toBe('Original');
 });
 test('component count, actual context, parameters and cross-scope IDs are checked',async()=>{
  const f=await fixture();const quote=await f.quote({inputs:{participants:1}});const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'bounded',idempotency_key:'accept'}));
  const body={operation_id:op.id,component:'answer',client_request_key:'one',idempotency_key:'one',kind:'text.generate' as const,input:{text:'Hello'},parameters:{max_output_tokens:100}};
  await expect(f.run(tx=>q.createRequest(tx,f.scope,f.clock,{...body,input:{text:'x'.repeat(2000)}}))).rejects.toMatchObject({code:'request_exceeds_recipe'});
  await expect(f.run(tx=>q.createRequest(tx,f.scope,f.clock,{...body,parameters:{max_output_tokens:101}}))).rejects.toMatchObject({code:'invalid_input'});
  await expect(f.run(tx=>q.createRequest(tx,f.scope,f.clock,{...body,parameters:{max_output_tokens:100,tools:[]}}))).rejects.toMatchObject({code:'request_exceeds_recipe'});
  const request=await f.run(tx=>q.createRequest(tx,f.scope,f.clock,body));expect((await f.run(tx=>q.createRequest(tx,f.scope,f.clock,{...body,idempotency_key:'other'}))).id).toBe(request.id);
  await expect(f.run(tx=>q.createRequest(tx,f.scope,f.clock,{...body,idempotency_key:'second',client_request_key:'two'}))).rejects.toMatchObject({code:'request_exceeds_recipe'});
  await expect(f.run(tx=>q.getQuote(tx,{...f.scope,account_id:'other'},quote.id))).rejects.toMatchObject({code:'not_found'});
 });
 test('complete racing with enqueue closes admission while preserving accepted claims',async()=>{
  const f=await fixture();const quote=await f.quote();const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'race',idempotency_key:'accept'}));
  const results=await Promise.allSettled([f.run(tx=>q.complete(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'close'})),f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:op.id,component:'answer',client_request_key:'race',idempotency_key:'race',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100}}))]);
  expect(results[0].status).toBe('fulfilled');const final=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,op.id));expect(final.admission_status).toBe('closed');
  if(results[1].status==='rejected'){expect(results[1].reason.code).toBe('operation_admission_closed');expect(final.reserved_units).toBe('0');}else expect(final.reserved_units).toBe('6000');
 });
 test('finish-partial cancels unsent requests and releases the reservation',async()=>{
  const f=await fixture();const quote=await f.quote();const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'partial',idempotency_key:'accept'}));
  await f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:op.id,component:'answer',client_request_key:'one',idempotency_key:'one',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100}}));
  const final=await f.run(tx=>q.finishPartial(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'finish'}));expect(final).toMatchObject({settlement_status:'settled',reserved_units:'0',captured_units:'0'});expect(final.requests[0].execution_status).toBe('canceled');
 });
 test('worker settlement captures successful work and closes completed operation',async()=>{
  const f=await fixture();const result=await f.invoke();const request=await f.run(tx=>e.leaseNext(tx,f.clock,'fixture-worker',{scope:f.scope}));const attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'success',outcome:'success',cost_units:'1500',charged_units:'1500',result_available:true},(t,sc,i)=>q.settleRequest(t,sc,f.clock,i)));
  const op=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,result.operation_id));expect(op).toMatchObject({settlement_status:'settled',captured_units:'1500',reserved_units:'0',wallet:{available_units:'98500'}});
 });
 test('late closing commands preserve terminal success and produce no repeated financial or completion events',async()=>{
  const f=await fixture(),accepted=await f.invoke();await executeOne(pool!,workerDependencies(f),f.clock,'terminal-success');
  const before=await closureSnapshot(f,accepted.operation_id);expect(before.operation.execution_status).toBe('completed');f.clock.advance(5000);
  const input={operation_id:accepted.operation_id,idempotency_key:'late'};
  for(const command of [q.cancel,q.finishPartial,q.complete]){
   await f.run(tx=>command(tx,f.scope,f.clock,input));await f.run(tx=>command(tx,f.scope,f.clock,input));
   expect(await closureSnapshot(f,accepted.operation_id)).toEqual(before);
  }
  await Promise.all([q.complete,q.cancel,q.finishPartial].map((command,i)=>f.run(tx=>command(tx,f.scope,f.clock,{...input,idempotency_key:`concurrent-${i}`}))));
  expect(await closureSnapshot(f,accepted.operation_id)).toEqual(before);
 });
 test('late completion and finish-partial cannot rewrite a canceled queued operation',async()=>{
  const f=await fixture(),accepted=await f.invoke();await f.run(tx=>q.cancel(tx,f.scope,f.clock,{operation_id:accepted.operation_id,idempotency_key:'cancel'}));
  const before=await closureSnapshot(f,accepted.operation_id);expect(before.operation).toMatchObject({execution_status:'canceled',captured_units:'0',reserved_units:'0'});f.clock.advance(5000);
  for(const command of [q.complete,q.finishPartial,q.cancel])await f.run(tx=>command(tx,f.scope,f.clock,{operation_id:accepted.operation_id,idempotency_key:id('late')}));
  expect(await closureSnapshot(f,accepted.operation_id)).toEqual(before);
 });
 test('cancel after complete stops active work and cannot be downgraded while settlement is pending',async()=>{
  const f=await fixture(),accepted=await f.invoke();const request=await f.run(tx=>e.leaseNext(tx,f.clock,'active',{scope:f.scope}));const attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  await f.run(tx=>q.cancel(tx,f.scope,f.clock,{operation_id:accepted.operation_id,idempotency_key:'cancel-active'}));
  const before=await closureSnapshot(f,accepted.operation_id);expect(before.operation).toMatchObject({execution_status:'running',settlement_status:'open'});expect(before.closure.closed_reason).toBe('cancel');f.clock.advance(5000);
  for(const command of [q.complete,q.finishPartial,q.cancel])await f.run(tx=>command(tx,f.scope,f.clock,{operation_id:accepted.operation_id,idempotency_key:id('late')}));
  expect(await closureSnapshot(f,accepted.operation_id)).toEqual(before);
  await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'cancel-observed',outcome:'success',cost_units:'1500',charged_units:'1500',result_available:true},(tx,scope,input)=>q.settleRequest(tx,scope,f.clock,input)));
  const settled=await closureSnapshot(f,accepted.operation_id);expect(settled.operation).toMatchObject({execution_status:'canceled',settlement_status:'settled',captured_units:'1500',reserved_units:'0',wallet:{available_units:'98500'}});
  await f.run(tx=>q.complete(tx,f.scope,f.clock,{operation_id:accepted.operation_id,idempotency_key:'after-settlement'}));expect(await closureSnapshot(f,accepted.operation_id)).toEqual(settled);
 });
 test('finish-partial after complete cancels unsent siblings and can still escalate to active cancellation',async()=>{
  const f=await fixture(),quote=await f.quote();const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'partial-escalation',idempotency_key:'accept'}));
  for(const key of ['active','queued'])await f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:op.id,component:'answer',client_request_key:key,idempotency_key:key,kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100}}));
  const request=await f.run(tx=>e.leaseNext(tx,f.clock,'active',{scope:f.scope}));const attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  await f.run(tx=>q.complete(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'complete'}));
  await f.run(tx=>q.finishPartial(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'partial'}));
  const partial=await closureSnapshot(f,op.id);expect(partial.closure.closed_reason).toBe('finish_partial');expect(partial.operation.requests.filter(r=>r.execution_status==='canceled')).toHaveLength(1);
  expect((await f.run(tx=>e.getRequest(tx,f.scope,request.id))).cancel_requested_at).toBeNull();
  await f.run(tx=>q.complete(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'late-complete'}));expect(await closureSnapshot(f,op.id)).toEqual(partial);
  await f.run(tx=>q.cancel(tx,f.scope,f.clock,{operation_id:op.id,idempotency_key:'cancel-active'}));expect((await f.run(tx=>e.getRequest(tx,f.scope,request.id))).cancel_requested_at).not.toBeNull();
  await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:'canceled',outcome:'canceled',cost_units:'1500',charged_units:'1500'},(tx,scope,input)=>q.settleRequest(tx,scope,f.clock,input)));
  expect((await closureSnapshot(f,op.id)).operation).toMatchObject({execution_status:'canceled',captured_units:'1500',reserved_units:'0'});
 });
 test('amend accepts increased totals and permits safe reduction without changing existing request terms',async()=>{
  const f=await fixture();const quote=await f.quote({inputs:{participants:2}});const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'amend',idempotency_key:'accept'}));
  const request=await f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:op.id,component:'answer',client_request_key:'one',idempotency_key:'one',kind:'text.generate',input:{text:'Hello'},parameters:{max_output_tokens:100}}));
  const increase=await f.quote({operation_id:op.id,inputs:{participants:3}});expect((await f.run(tx=>q.amend(tx,f.scope,f.clock,{operation_id:op.id,quote_id:increase.id,idempotency_key:'increase'}))).accepted_max_units).toBe('9000');
  const decrease=await f.quote({operation_id:op.id,inputs:{participants:1}});expect((await f.run(tx=>q.amend(tx,f.scope,f.clock,{operation_id:op.id,quote_id:decrease.id,idempotency_key:'decrease'}))).accepted_max_units).toBe('3000');
  expect((await f.run(tx=>q.getExecutionContext(tx,f.scope,f.clock,request.id))).component.max_units).toBe('3000');
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('97000');
 });
 test('deleted project generation cannot accept a quote or enqueue new work',async()=>{
  const f=await fixture();const quote=await f.quote({metadata:{external_project_id:'project',project_generation:'v1'}});await f.run(tx=>s.deleteContent(tx,f.scope,f.clock,{external_project_id:'project',project_generation:'v1',reason:'deleted'}));
  await expect(f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'deleted',idempotency_key:'accept'}))).rejects.toMatchObject({code:'content_deleted'});
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).reserved_units).toBe('0');
 });
 test('A49 lower published rate is applied to actual customer capture',async()=>{
  const f=await fixture();const accepted=await f.invoke();
  await publishNewRate(f,'0.0005');
  await executeOne(pool!,workerDependencies(f),f.clock,'rate-test');
  const final=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id));
  expect(final).toMatchObject({captured_units:'60',settlement_status:'settled',reserved_units:'0'});
 });
 test('A19 known price rise pauses even when conservative reserve could cover it',async()=>{
  const f=await fixture();const accepted=await f.invoke();
  await publishNewRate(f,'0.0015');
  const result=await executeOne(pool!,workerDependencies(f),f.clock,'rate-test');
  expect(result.state).toBe('paused');
  const request=await f.run(tx=>e.getRequest(tx,f.scope,accepted.request_id));expect(request).toMatchObject({reason:'requote_required',attempt_count:0});
  const final=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,accepted.operation_id));expect(final.captured_units).toBe('0');
 });
 test('invalid result schema and conflicting budget representations fail before reserve',async()=>{
  const f=await fixture();
  await expect(f.invoke({input:{text:'Hello',response_schema:{type:'number',minimum:'invalid'}}})).rejects.toMatchObject({code:'invalid_input'});
  await expect(f.invoke({budget:{max_units:'3000',max_credits:'0.001'}})).rejects.toMatchObject({code:'invalid_input'});
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).reserved_units).toBe('0');
 });
 test('acknowledgement removes both request content and the original quote prompt',async()=>{
  const f=await fixture();const accepted=await f.invoke();await executeOne(pool!,workerDependencies(f),f.clock,'retention-test');
  const delivery=await f.run(tx=>s.getDelivery(tx,f.scope,f.clock,accepted.request_id));
  await f.run(tx=>s.acknowledge(tx,f.scope,f.clock,{request_id:accepted.request_id,version:delivery!.version,manifest_hash:delivery!.manifest_hash}));
  const remaining=(await pool!.query('SELECT count(*)::integer n FROM storage_inputs WHERE operation_id=$1 AND content IS NOT NULL',[accepted.operation_id])).rows[0].n;expect(remaining).toBe(0);
 });
 test('disabled connections cannot admit new paid operations',async()=>{
  const f=await fixture();const quote=await f.quote();
  await f.run(async tx=>{const service=new ConnectionService(tx,f.clock);await service.setStatus(f.scope,f.primary,1,'disabled',{actor_id:'test',reason:'disabled'});await service.setStatus(f.scope,f.fallback,1,'disabled',{actor_id:'test',reason:'disabled'});});
  await expect(f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'disabled',idempotency_key:'disabled'}))).rejects.toMatchObject({code:'provider_unavailable_before_acceptance'});
 });
 test('single-call binding cannot be bypassed through separate operation admission',async()=>{
  const f=await fixture();const quote=await f.quote({kind:'single_call',recipe:undefined,inputs:{},profile:'text',input:{text:'Original'},parameters:{max_output_tokens:100},execution:{deadline_seconds:1800}});
  const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'manual',idempotency_key:'accept'}));
  await expect(f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:op.id,component:'answer',client_request_key:'changed',idempotency_key:'changed',kind:'text.generate',input:{text:'Substitution'},parameters:{max_output_tokens:100}}))).rejects.toMatchObject({code:'idempotency_conflict'});
 });
 test('abandoned operation closes at deadline without extending it on amendment',async()=>{
  const f=await fixture();const quote=await f.quote();const op=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'abandoned',idempotency_key:'accept'}));
  f.clock.advance(1800001);await f.run(tx=>q.closeExpiredOperations(tx,f.clock,f.scope));
  const final=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,op.id));expect(final).toMatchObject({admission_status:'closed',settlement_status:'settled',reserved_units:'0'});
 });
 test('published recipes and quotes are immutable even through SQL',async()=>{
  const f=await fixture();const quote=await f.quote();await expect(pool!.query('UPDATE quotes SET max_units=1 WHERE id=$1',[quote.id])).rejects.toThrow('immutable');
  const recipe=(await f.run(tx=>q.listRecipes(tx,f.scope)))[0];await expect(pool!.query('DELETE FROM recipe_versions WHERE id=$1',[recipe.id])).rejects.toThrow('immutable');
 });
});
async function closureSnapshot(f:Awaited<ReturnType<typeof fixture>>,operationId:string){
 const operation=await f.run(tx=>q.getOperation(tx,f.scope,f.clock,operationId));
 const closure=(await pool!.query('SELECT closed_reason,closed_at,settled_at FROM operations WHERE id=$1',[operationId])).rows[0];
 const postings=(await pool!.query('SELECT id,transaction_id,amount_units,bucket FROM journal_postings WHERE wallet_id=$1 ORDER BY id',[operation.wallet.id])).rows;
 const events=(await pool!.query('SELECT id,type,resource,data FROM outbox_events WHERE application_id=$1 ORDER BY sequence',[f.scope.application_id])).rows;
 const requests=(await pool!.query('SELECT id,execution_status,settlement_status,cancel_requested_at,unresolved_at,financial_closed_at,attempt_count FROM execution_requests WHERE operation_id=$1 ORDER BY id',[operationId])).rows;
 return {operation,closure,postings,events,requests};
}
test('bounded count language rejects overflow, unknown input and recursive abuse',()=>{
 expect(q.evaluateCount({product:[{input:'participants'},{constant:2}]},{participants:4})).toBe(8);
 expect(()=>q.evaluateCount({input:'missing'},{})).toThrow();expect(()=>q.evaluateCount({product:[{constant:256},{constant:256}]},{})).toThrow();
});

async function publishNewRate(f:Awaited<ReturnType<typeof fixture>>,amount:string){await f.run(async tx=>{const service=new CatalogService(tx,f.clock);const version=await service.createDraft(f.scope,{kind:'rate_card',key:'text-rates',version:2,payload:{id:'updated-fixture',currency:'USD',source:'synthetic test',checked_at:f.clock.now().toISOString(),rates:[{id:'in2',dimension:'input.uncached',unit:'tokens',unit_size:'1000000',amount,effective_from:'2025-01-01'},{id:'out2',dimension:'output.text',unit:'tokens',unit_size:'1000000',amount,effective_from:'2025-01-01'}]},author:'test',comment:'rate change'});await service.publish(f.scope,version.id,1,[{usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'1'}]},context:{at:f.clock.now().toISOString()}}]);});}
function workerDependencies(f:Awaited<ReturnType<typeof fixture>>):WorkerDependencies{return {
 blobStore:{async put(){},async get(){throw new Error('No binary fixture');},async delete(){}},limits:{scope:f.scope},
 context:async(scope,request,variant)=>{const c=await q.getExecutionContext(pool!,scope,f.clock,request.id);return {input:{capability:'text.generate',model:variant.model,input:'Hello',max_output_tokens:100},accepted_rate_card:c.accepted_rate_card,current_rate_card:c.current_rate_card,accepted_at:new Date(c.accepted_at).toISOString(),maximum_items:c.component.maximum_items};},
 adapter:async()=>new FakeAdapter([{outcome:'success',text:'Valid fixture',usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'100'},{dimension:'output.text',unit:'tokens',quantity:'20'}]}}]),
 settle:(tx,scope,input)=>q.settleRequest(tx,scope,f.clock,input),
};}
