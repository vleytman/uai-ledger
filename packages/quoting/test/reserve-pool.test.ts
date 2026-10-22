import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {ManualClock,id,type Scope} from '../../contracts/src/index.js';
import {CatalogService} from '../../catalog/src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {grant,getWallet} from '../../accounting/src/index.js';
import * as q from '../src/index.js';
import {demoModels} from '../../model-pricing/src/demo-models.js';
import {OpenAIAdapter} from '../../providers/src/index.js';
import {configureBudget} from '../../execution/src/index.js';
import {executeRequest} from '../../execution/src/runtime.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end()});
// Synthetic nano rates (demo-models): 100 units per input token, 400 per output token, markup x2.
const charge=(output:number)=>(10*100+output*400)*2;

async function fixture(funds:string){
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};const clock=new ManualClock(new Date());
 await transaction(pool!,async tx=>{
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'reserve pool fixture']);await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('ext')]);
  const connection=await new ConnectionService(tx,clock).create(scope,{provider:'openai',name:'Mock transport only',account_scope:{fixture:'test'},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'test',reason:'Mock only'});
  await tx.query("UPDATE provider_connections SET credential_status='configured' WHERE id=$1",[connection.id]);
  await configureBudget(tx,scope,'provider',connection.id,'1000000000');await configureBudget(tx,scope,'period','period','1000000000');
  const spec=demoModels().find(m=>m.key==='nano')!,catalog=new CatalogService(tx,clock);
  const card=await catalog.createDraft(scope,{kind:'rate_card',key:'rates',version:1,payload:spec.card,author:'test',comment:'test'});await catalog.publish(scope,card.id,1,[{usage:{state:'known',items:[{dimension:'output.text',unit:'tokens',quantity:'1'}]},context:{at:clock.now().toISOString()}}]);
  const models=await catalog.createDraft(scope,{kind:'catalog',key:'models',version:1,author:'test',comment:'test',payload:{models:[{id:spec.id,provider:'openai',status:'active',capabilities:['text.generate'],allowed_parameters:Object.keys(spec.method.parameters),calculation:spec.method,rate_card_version_id:card.id}]}});await catalog.publish(scope,models.id,1);
  const route=await catalog.createDraft(scope,{kind:'route',key:'route',version:1,author:'test',comment:'test',payload:{capability:'text.generate',primary:{catalog_version_id:models.id,model:spec.id,connection_id:connection.id,max_cost_units:'100000000'},deadline_seconds:3600,platform_risk_budget_units:'400000000'}});await catalog.publish(scope,route.id,1);
  // Two roles of a discussion on one model: replicas and the moderator's summary.
  for(const key of ['replica','summary','outsider'])await q.publishRecipe(tx,scope,clock,{key,version:1,period_budget_key:'period',components:[{key:'text',capability:'text.generate',count:{constant:1},route_version_id:route.id,rate_card_version_id:'',limits:{},pricing_mode:'estimated_actual'}]});
  await grant(tx,scope,clock,{amount_units:funds,source:'internal',reason:'test',terms_version:'v1',expires_at:null,external_reference:'test',idempotency_key:'g'});
 });
 const deps=defaultRuntime(pool!,clock);deps.limits={scope};deps.onDelta=undefined;let output=100;
 deps.adapter=async()=>new OpenAIAdapter({apiKey:'mock',models:['gpt-4.1-nano-2025-04-14'],maxInputTokens:1000,fetch:async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'A replica.'}]}],usage:{input_tokens:10,output_tokens:output,total_tokens:output+10,input_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}})});
 const call=(operation_id:string,profile:string,key:string)=>transaction(pool!,tx=>q.invoke(tx,scope,clock,{idempotency_key:key,operation_id,profile,input:{text:'Speak'},parameters:{expected_output_tokens:512}}));
 const execute=async(requestId:string,tokens:number)=>{output=tokens;expect((await executeRequest(pool!,deps,requestId,clock)).state).toBe('succeeded')};
 const wallet=()=>transaction(pool!,tx=>getWallet(tx,scope,clock));
 const operation=(opId:string)=>transaction(pool!,tx=>q.getOperation(tx,scope,clock,opId));
 const forecast=async()=>BigInt((await transaction(pool!,tx=>q.createQuote(tx,scope,clock,{idempotency_key:id('f'),profile:'replica',input:{text:'Speak'},parameters:{expected_output_tokens:512}}))).estimated_units);
 const open=(reserve:string,key='chain')=>transaction(pool!,async tx=>{
  const quote=await q.createQuote(tx,scope,clock,{idempotency_key:`${key}:quote`,kind:'pool',pool:{profiles:[{profile:'replica',max_calls:2},{profile:'summary',max_calls:2}],max_calls:3,deadline_seconds:3600},budget:{max_units:reserve}});
  return {quote,operation:await q.acceptQuote(tx,scope,clock,{quote_id:String(quote.id),client_operation_key:key,idempotency_key:`${key}:accept`})};
 });
 return {scope,clock,call,execute,wallet,operation,forecast,open};
}

describe.skipIf(!pool)('reserve pool for a composite job with dynamic calls',()=>{
 it('holds the whole chain, admits calls without free credits, absorbs overruns from the pool and releases the rest',async()=>{
  const funds=40_000_000n,f=await fixture(funds.toString()),perCall=await f.forecast();
  const {quote,operation}=await f.open(funds.toString());
  expect(quote).toMatchObject({kind:'pool',max_units:funds.toString(),pool:{max_calls:3}});
  expect(await f.wallet()).toMatchObject({available_units:'0',reserved_units:funds.toString()});
  // Nothing is free outside the pool: an ordinary call is refused, the chain still runs.
  await expect(transaction(pool!,tx=>q.invoke(tx,f.scope,f.clock,{idempotency_key:'outside',profile:'replica',input:{text:'Speak'},parameters:{expected_output_tokens:512}}))).rejects.toMatchObject({code:'insufficient_credits'});
  const first=await f.call(operation.id,'replica','r1');
  expect(first).toMatchObject({operation_id:operation.id,accepted_max_units:perCall.toString()});
  expect(await f.call(operation.id,'replica','r1')).toEqual(first);
  // Far above the forecast: the pool covers it, no debt is created.
  const long=Math.ceil(Number(perCall)/400);await f.execute(first.request_id,long);
  expect(charge(long)).toBeGreaterThan(Number(perCall));
  const second=await f.call(operation.id,'replica','r2');await f.execute(second.request_id,100);
  await expect(f.call(operation.id,'replica','r3')).rejects.toMatchObject({code:'request_exceeds_recipe'});
  await expect(f.call(operation.id,'outsider','o1')).rejects.toMatchObject({code:'request_exceeds_recipe'});
  const summary=await f.call(operation.id,'summary','s1');
  await expect(f.call(operation.id,'summary','s2')).rejects.toMatchObject({code:'request_exceeds_recipe'});
  await f.execute(summary.request_id,200);
  const spent=BigInt(charge(long)+charge(100)+charge(200));
  expect(await f.operation(operation.id)).toMatchObject({admission_status:'open',captured_units:spent.toString(),reserved_units:(funds-spent).toString()});
  expect((await pool!.query('SELECT count(*)::integer n FROM capture_debts WHERE wallet_id=$1',[(await f.wallet()).id])).rows[0].n).toBe(0);
  await expect(transaction(pool!,tx=>q.createRequest(tx,f.scope,f.clock,{operation_id:operation.id,component:'replica',client_request_key:'direct',idempotency_key:'direct',kind:'text.generate',input:{text:'Speak'}}))).rejects.toMatchObject({code:'request_exceeds_recipe'});
  const closed=await transaction(pool!,tx=>q.complete(tx,f.scope,f.clock,{operation_id:operation.id,idempotency_key:'close'}));
  expect(closed).toMatchObject({settlement_status:'settled',captured_units:spent.toString(),reserved_units:'0'});
  expect(await f.wallet()).toMatchObject({available_units:(funds-spent).toString(),reserved_units:'0'});
  await expect(f.call(operation.id,'summary','late')).rejects.toMatchObject({code:'operation_admission_closed'});
 });

 it('tops a short pool up from free credits and refuses without changing anything when there are none',async()=>{
  const probe=await fixture('100000000'),perCall=await probe.forecast();
  // Enough for the pool and one top-up of a call that does not fit it.
  const f=await fixture((perCall+1n).toString());
  const {operation}=await f.open('1','short');
  const first=await f.call(operation.id,'replica','r1');
  expect(await f.operation(operation.id)).toMatchObject({accepted_max_units:perCall.toString(),reserved_units:perCall.toString()});
  expect((await f.wallet()).available_units).toBe('1');
  const before=[await f.wallet(),await f.operation(operation.id)];
  await expect(f.call(operation.id,'replica','r2')).rejects.toMatchObject({code:'insufficient_credits'});
  expect([await f.wallet(),await f.operation(operation.id)]).toEqual(before);
  await f.execute(first.request_id,100);
  const canceled=await transaction(pool!,tx=>q.cancel(tx,f.scope,f.clock,{operation_id:operation.id,idempotency_key:'cancel'}));
  expect(canceled).toMatchObject({settlement_status:'settled',captured_units:String(charge(100)),reserved_units:'0'});
  expect((await f.wallet()).available_units).toBe((perCall+1n-BigInt(charge(100))).toString());
 });
});
