import {apiSchemas} from '../../../packages/contracts/api.js';
import {NotificationService} from '../../../packages/notifications/src/index.js';
import {afterAll,describe,test,expect} from 'vitest';
import {createPool,transaction,type Tx} from '../../../packages/db/src/index.js';
import {id,ManualClock,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {CatalogService,type RouteDefinition} from '../../../packages/catalog/src/index.js';
import {ConnectionService} from '../../../packages/reconciliation/src/connections.js';
import * as a from '../../../packages/accounting/src/index.js';
import * as e from '../../../packages/execution/src/index.js';
import * as q from '../../../packages/quoting/src/index.js';
import * as storage from '../../../packages/storage/src/index.js';
import {createApi} from './server.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const integration=process.env.DATABASE_URL?describe:describe.skip;const pool=process.env.DATABASE_URL?createPool():null;const apps:ReturnType<typeof createApi>[]=[];afterAll(async()=>{await Promise.all(apps.map(app=>app.close()));await pool?.end();});
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
 const quote=(input:Partial<q.QuoteInput>={})=>run(tx=>q.createQuote(tx,scope,clock,{idempotency_key:id('key'),recipe:{key:'discussion',version:1},inputs:{participants:2},...input}));
 const invoke=(input:Partial<q.QuoteInput&{quote_id:string}>={})=>run(tx=>q.invoke(tx,scope,clock,{idempotency_key:id('invoke'),profile:'text',input:{messages:[{role:'user',content:'Hello'}]},parameters:{max_output_tokens:100},budget:{max_units:'3000'},...input}));
 return {scope,clock,run,def,quote,invoke,primary,fallback};
}
async function overviewFixture(){
 const f=await fixture();const app=createApi(pool!,f.clock);apps.push(app);const token=(await f.run(tx=>issueToken(tx,{...f.scope,account_ids:null,scopes:['operations:admin'],expires_at:null,max_grant_units:null}))).token;
 const get=(query:Record<string,string>={})=>app.inject({method:'GET',url:`/v1/admin/overview?${new URLSearchParams(query)}`,headers:{authorization:`Bearer ${token}`}});
 const detail=(operationId:string)=>app.inject({method:'GET',url:`/v1/admin/operations/${operationId}`,headers:{authorization:`Bearer ${token}`}});
 return {...f,get,detail};
}
// Historical normalized rows exercise read aggregation. All customer charges still go through real accounting claims/postings.
async function history(f:Awaited<ReturnType<typeof overviewFixture>>,scope:Scope,costs:string[],charge:string,model='fake-text',connection=f.primary){
 const invoked=await f.run(tx=>q.invoke(tx,scope,f.clock,{idempotency_key:id('invoke'),profile:'text',input:{text:'Analytics fixture'},parameters:{max_output_tokens:100},budget:{max_units:'3000'}}));const attempts:string[]=[];
 await f.run(async tx=>{
  for(let n=0;n<costs.length;n++){const attempt=id('attempt');attempts.push(attempt);await tx.query('INSERT INTO execution_attempts(id,request_id,number,fencing_token,variant,status,submission_intent_at,provider_idempotency_key,cost_units,charged_units,finished_at,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$1,$7,$8,$6,$6)',[attempt,invoked.request_id,n+1,{connection_id:connection,model},n===costs.length-1?'succeeded':'defect',f.clock.now(),costs[n],n===costs.length-1?charge:'0']);}
  await tx.query("UPDATE execution_requests SET execution_status='succeeded',settlement_status='settled',financial_closed_at=$2,attempt_count=$3 WHERE id=$1",[invoked.request_id,f.clock.now(),attempts.length]);
  await q.settleRequest(tx,scope,f.clock,{request_id:invoked.request_id,charged_units:charge,idempotency_key:id('settle'),reason:'Fixture normalized completion'});
 });
 return {...invoked,attempts};
}
async function cost(f:Awaited<ReturnType<typeof overviewFixture>>,attempt:string,amount:string|null,currency='USD',extra:{correction_of?:string;at?:Date}={}){
 const costId=id('cost');await pool!.query('INSERT INTO provider_cost_entries(id,organization_id,application_id,account_id,attempt_id,connection_id,model,state,currency,rounded_units,priced_at,entry_type,correction_of,reason,identity,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$1,$1)',[costId,f.scope.organization_id,f.scope.application_id,f.scope.account_id,extra.correction_of?null:attempt,f.primary,'fake-text',amount===null?'unknown':'calculated',currency,amount,extra.at??f.clock.now(),extra.correction_of?'adjustment':'original',extra.correction_of??null,'Normalized historical cost fixture']);return costId;
}
integration('Admin overview scoped cohort aggregations',()=>{
 test('operation details include scoped costs, corrections and delivery metadata while preserving unknown',async()=>{
  const f=await overviewFixture();const result=await history(f,f.scope,['10','100'],'100');await history(f,f.scope,['900'],'900');
  await cost(f,result.attempts[1],null);f.clock.advance(1);const current=await cost(f,result.attempts[1],'100');await cost(f,result.attempts[1],'-5','USD',{correction_of:current});
  const manifest=await f.run(tx=>storage.createManifest(tx,f.scope,f.clock,{request_id:result.request_id,operation_id:result.operation_id,content:{text:'Private result'},asset_ids:[],ttl_seconds:60}));
  const read=async()=>{const response=await f.detail(result.operation_id);expect(response.statusCode,response.body).toBe(200);return response.json();};
  expect(await read()).toMatchObject({provider_cost_units:'105',platform_funded_units:'10',requests:[{delivery:{status:'available'}}]});
  expect(JSON.stringify(await read())).not.toContain('Private result');
  await f.run(tx=>storage.acknowledge(tx,f.scope,f.clock,{request_id:result.request_id,version:manifest.version,manifest_hash:manifest.manifest_hash}));
  expect(await read()).toMatchObject({requests:[{delivery:{status:'acknowledged'}}]});
  f.clock.advance(1);await cost(f,result.attempts[0],null);expect(await read()).toMatchObject({provider_cost_units:null,platform_funded_units:null});
 });
 test.each([
  {name:'all requests canceled independently',outcomes:['canceled','canceled'],close:'complete',expected:'canceled',charge:'0'},
  {name:'finish-partial cancels all queued requests',outcomes:['queued','queued'],close:'finishPartial',expected:'canceled',charge:'0'},
  {name:'failure and cancellation without success',outcomes:['failed','canceled'],close:'complete',expected:'failed',charge:'0'},
  {name:'all requests failed',outcomes:['failed','failed'],close:'complete',expected:'failed',charge:'0'},
  {name:'success and cancellation',outcomes:['succeeded','canceled'],close:'complete',expected:'partial',charge:'100'},
  {name:'success and failure',outcomes:['succeeded','failed'],close:'complete',expected:'partial',charge:'100'},
  {name:'all requests succeeded',outcomes:['succeeded','succeeded'],close:'complete',expected:'completed',charge:'200'},
  {name:'explicit operation cancellation with a completed part',outcomes:['succeeded','queued'],close:'cancel',expected:'canceled',charge:'100'},
  {name:'closing admission keeps queued work running',outcomes:['canceled','queued'],close:'complete',expected:'running',charge:'0'},
  {name:'open admission retains accepted state after child cancellation',outcomes:['canceled','canceled'],close:null,expected:'accepted',charge:'0'},
 ] as const)('operation status agrees across public API, admin detail/list and overview: $name',async scenario=>{
  const f=await fixture(),quote=await f.quote();
  const operation=await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:quote.id,client_operation_key:'status-audit',idempotency_key:'accept'}));
  const settle:e.Settlement=(tx,scope,input)=>q.settleRequest(tx,scope,f.clock,input);
  for(const [index,outcome] of scenario.outcomes.entries()){
   const request=await f.run(tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:operation.id,component:'answer',client_request_key:`part-${index}`,idempotency_key:`part-${index}`,kind:'text.generate',input:{text:'Status fixture'},parameters:{max_output_tokens:100}}));
   if(outcome==='canceled')await f.run(tx=>e.cancelRequest(tx,f.scope,f.clock,request.id,settle));
   else if(outcome!=='queued'){
    const leased=await f.run(tx=>e.leaseNext(tx,f.clock,'status-audit',{scope:f.scope}));expect(leased.id).toBe(request.id);
    const attempt=await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,leased.id,leased.fencing_token));
    await f.run(tx=>e.observeAttempt(tx,f.scope,f.clock,{request_id:leased.id,attempt_id:attempt.id,fence:leased.fencing_token,observation_key:'observed',outcome:outcome==='succeeded'?'success':'invalid',cost_units:'100',charged_units:outcome==='succeeded'?'100':'0',result_available:outcome==='succeeded'},settle));
   }
  }
  if(scenario.close)await f.run(tx=>q[scenario.close!](tx,f.scope,f.clock,{operation_id:operation.id,idempotency_key:'close'}));
  const walletBefore=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));
  const postingsBefore=(await pool!.query('SELECT * FROM journal_postings WHERE wallet_id=$1 ORDER BY id',[walletBefore.id])).rows;
  const app=createApi(pool!,f.clock);apps.push(app);const {token}=await f.run(tx=>issueToken(tx,{...f.scope,account_ids:null,scopes:['operations:admin','ai:read'],expires_at:null,max_grant_units:null}));
  const get=(url:string)=>app.inject({method:'GET',url,headers:{authorization:`Bearer ${token}`}});
  const publicReply=await get(`/v1/operations/${operation.id}`);expect(publicReply.statusCode,publicReply.body).toBe(200);
  const publicOperation=apiSchemas.OperationResponse.parse(publicReply.json());
  const adminReply=await get(`/v1/admin/operations/${operation.id}`);expect(adminReply.statusCode,adminReply.body).toBe(200);
  const listReply=await get('/v1/admin/operations');expect(listReply.statusCode,listReply.body).toBe(200);
  const overviewReply=await get('/v1/admin/overview');expect(overviewReply.statusCode,overviewReply.body).toBe(200);
  for(const view of [publicOperation,adminReply.json(),listReply.json().data[0],overviewReply.json().recent_operations[0]])expect(view).toMatchObject({id:operation.id,execution_status:scenario.expected,captured_units:scenario.charge});
  expect(publicOperation.requests.map(request=>request.execution_status).sort()).toEqual(scenario.outcomes.map(outcome=>outcome==='queued'&&['cancel','finishPartial'].includes(scenario.close??'')?'canceled':outcome).sort());
  if(!['running','accepted'].includes(scenario.expected))expect(publicOperation).toMatchObject({settlement_status:'settled',reserved_units:'0'});
  expect(await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).toEqual(walletBefore);
  expect((await pool!.query('SELECT * FROM journal_postings WHERE wallet_id=$1 ORDER BY id',[walletBefore.id])).rows).toEqual(postingsBefore);
 });
 test('request charges do not multiply with attempts; latest costs and corrections stay currency-separated',async()=>{
  const f=await overviewFixture();const r=await history(f,f.scope,['10','100'],'100');
  await cost(f,r.attempts[0],null,'USD',{at:new Date(f.clock.now().getTime()-1)});const current=await cost(f,r.attempts[0],'10','USD',{at:new Date(f.clock.now().getTime()-1)});await cost(f,r.attempts[0],'-2','USD',{correction_of:current});await cost(f,r.attempts[1],'100');await cost(f,r.attempts[1],'999','EUR');
  const response=await f.get();expect(response.statusCode,response.body).toBe(200);const report=response.json();expect(report).toMatchObject({known_units:'108',charged_units:'100',platform_funded_units:'8',unknown_count:0,active_reserved_units:'0',counts:{total:1,succeeded:1},operations:{total:1,settled:1},currency:'USD',period_basis:'request_created_at'});
  expect(report.provider_cost_totals).toContainEqual({currency:'EUR',known_units:'999',unknown_count:0,provisional_count:0});expect(report.recent_operations[0]).toMatchObject({id:r.operation_id,captured_units:'100'});
 });
 test('account/model/provider filters match the same attempt and preserve application isolation',async()=>{
  const f=await overviewFixture();const first=await history(f,f.scope,['10','100'],'100');
  const second={...f.scope,account_id:id('account')};await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$1)',[second.account_id,second.organization_id,second.application_id]);
  await f.run(tx=>a.grant(tx,second,f.clock,{idempotency_key:'fund',amount_units:'10000',source:'purchase',external_reference:id('payment'),terms_version:'v1',expires_at:null}));
  const connection=await f.run(tx=>new ConnectionService(tx,f.clock).create(f.scope,{provider:'openai',name:'No-network reporting fixture',account_scope:{fixture:f.scope.account_id},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'test',reason:'Analytics only'}));
  await history(f,second,['700'],'700','model-b',connection.id);
  await pool!.query('UPDATE execution_attempts SET variant=$2 WHERE id=$1',[first.attempts[1],{connection_id:connection.id,model:'model-c'}]);
  expect((await f.get({model:'fake-text',provider:'openai'})).json().counts.total).toBe(0);
  await f.run(async tx=>{const notifications=new NotificationService(tx,f.clock);await notifications.saveRule(f.scope,{signal:'provider.degraded',severity:'warning',minimum_samples:1,recipients:[],cooldown_seconds:60,enabled:true},{actor_id:'test',reason:'Fixture incident'});await notifications.observe(f.scope,{signal:'provider.degraded',resource_id:first.request_id,failure_scope:first.request_id,samples:1,active:true});});
  expect((await f.get({account_id:f.scope.account_id})).json().recent_incidents).toHaveLength(1);expect((await f.get({account_id:second.account_id})).json().recent_incidents).toHaveLength(0);
  expect((await f.get({account_id:f.scope.account_id})).json()).toMatchObject({known_units:'110',charged_units:'100',counts:{total:1}});
  expect((await f.get({model:'model-b',provider:'openai'})).json()).toMatchObject({known_units:'700',charged_units:'700',counts:{total:1}});
  expect((await f.get({model:'model-b',provider:'fake'})).json()).toMatchObject({known_units:'0',charged_units:'0',counts:{total:0}});
  const other=await fixture(f.scope.organization_id);await other.invoke();expect((await f.get()).json().counts.total).toBe(2);
  expect((await f.get({application_id:other.scope.application_id})).statusCode).toBe(403);expect((await f.get({account_id:other.scope.account_id})).statusCode).toBe(404);
 });
 test('half-open request-created periods include current queue/reserve and exclude older request cost even if priced later',async()=>{
  const f=await overviewFixture();const earlier=await history(f,f.scope,['100'],'100');f.clock.advance(86400000);
  const queued=await f.invoke();await cost(f,earlier.attempts[0],'999');f.clock.advance(5000);
  const openQuote=await f.quote({inputs:{participants:2}});await f.run(tx=>q.acceptQuote(tx,f.scope,f.clock,{quote_id:openQuote.id,client_operation_key:'no-requests-yet',idempotency_key:'accept'}));
  const report=(await f.get({period_start:'2026-01-02T00:00:00Z',period_end:'2026-01-03T00:00:00Z',model:'fake-text',provider:'fake'})).json();expect(report).toMatchObject({known_units:'0',charged_units:'0',active_reserved_units:'9000',active_request_claim_units:'3000',counts:{total:1,queued:1},operations:{total:2,open:1},queue_oldest_age_seconds:5});expect(report.recent_operations.some((o:any)=>o.id===queued.operation_id)).toBe(true);
  const old=(await f.get({period_end:'2026-01-02T00:00:00Z'})).json();expect(old).toMatchObject({known_units:'999',charged_units:'100',counts:{total:1,queued:0}});
  for(const query of [{period_start:'invalid'},{period_start:'2026-01-02T00:00:00Z',period_end:'2026-01-01T00:00:00Z'},{unexpected:'filter'}] as Record<string,string>[])expect((await f.get(query)).statusCode).toBe(422);
 });
 test('pending attempts expose unknown cost and provider exposure instead of a false final zero',async()=>{
  const f=await overviewFixture();await f.invoke();const request=await f.run(tx=>e.leaseNext(tx,f.clock,'pending',{scope:f.scope}));await f.run(tx=>e.prepareDispatch(tx,f.scope,f.clock,request.id,request.fencing_token));
  const report=(await f.get()).json();expect(report).toMatchObject({known_units:'0',unknown_count:1,cost_precision:'partial',customer_charge_precision:'partial',platform_funded_precision:'partial',unsettled_request_count:1,unresolved_exposure_units:'2000',active_reserved_units:'3000',charged_units:'0'});
 });
 test('admin operation list and detail retain the persisted creation time without exposing another application or changing finance',async()=>{
  const f=await fixture();const first=await f.invoke();f.clock.advance(5123);const second=await f.invoke();const foreign=await fixture(f.scope.organization_id);const foreignOperation=await foreign.invoke();
  const app=createApi(pool!,f.clock);apps.push(app);const adminToken=async(scope:Scope)=>transaction(pool!,tx=>issueToken(tx,{...scope,account_ids:null,scopes:['operations:admin','ai:read'],expires_at:null,max_grant_units:null}));const ownToken=await adminToken(f.scope),otherToken=await adminToken(foreign.scope),headers={authorization:`Bearer ${ownToken.token}`};
  const saved=(await pool!.query('SELECT id,created_at FROM operations WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC,id',[f.scope.organization_id,f.scope.application_id])).rows;expect(saved.map(row=>row.id)).toEqual([second.operation_id,first.operation_id]);const expected=new Map(saved.map(row=>[row.id,new Date(row.created_at).toISOString()]));const walletBefore=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));const postingsBefore=(await pool!.query('SELECT * FROM journal_postings WHERE wallet_id=$1 ORDER BY id',[walletBefore.id])).rows;
  f.clock.advance(60000);const list=await app.inject({method:'GET',url:'/v1/admin/operations',headers});expect(list.statusCode,list.body).toBe(200);expect(list.json().data.map((row:any)=>({id:row.id,created_at:row.created_at}))).toEqual(saved.map(row=>({id:row.id,created_at:expected.get(row.id)})));expect(JSON.stringify(list.json())).not.toContain(foreignOperation.operation_id);
  for(const operationId of [first.operation_id,second.operation_id]){
   const detail=await app.inject({method:'GET',url:`/v1/admin/operations/${operationId}`,headers});expect(detail.statusCode,detail.body).toBe(200);expect(detail.json().created_at).toBe(expected.get(operationId));expect(detail.json().created_at).not.toBe(f.clock.now().toISOString());
   const publicSnapshot=await app.inject({method:'GET',url:`/v1/operations/${operationId}`,headers});expect(publicSnapshot.statusCode,publicSnapshot.body).toBe(200);expect(apiSchemas.OperationResponse.parse(publicSnapshot.json()).created_at).toBe(expected.get(operationId));
  }
  expect((await app.inject({method:'GET',url:`/v1/admin/operations/${foreignOperation.operation_id}`,headers})).statusCode).toBe(404);const otherHeaders={authorization:`Bearer ${otherToken.token}`};expect((await app.inject({method:'GET',url:`/v1/admin/operations/${first.operation_id}`,headers:otherHeaders})).statusCode).toBe(404);expect((await app.inject({method:'GET',url:'/v1/admin/operations',headers:otherHeaders})).json().data.map((row:any)=>row.id)).toEqual([foreignOperation.operation_id]);
  expect(await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).toEqual(walletBefore);expect((await pool!.query('SELECT * FROM journal_postings WHERE wallet_id=$1 ORDER BY id',[walletBefore.id])).rows).toEqual(postingsBefore);expect((await pool!.query('SELECT id,created_at FROM operations WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC,id',[f.scope.organization_id,f.scope.application_id])).rows).toEqual(saved);
 });

});
