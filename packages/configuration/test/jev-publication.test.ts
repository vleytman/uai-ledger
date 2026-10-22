import {afterAll,describe,it,expect} from 'vitest';
import bundle from '../../../configurations/api/typesafe/jev.json';
import {createPool,transaction} from '../../db/src/index.js';
import {id,ManualClock,type Scope} from '../../contracts/src/index.js';
import {ConnectionService,CredentialVault} from '../../reconciliation/src/connections.js';
import {publishConfiguration,previewConfiguration,activateConfiguration} from '../src/index.js';
import * as q from '../../quoting/src/index.js';
import * as a from '../../accounting/src/index.js';
import * as e from '../../execution/src/index.js';
import * as storage from '../../storage/src/index.js';
import {executeOne} from '../../execution/src/runtime.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {TypeSafeAdapter} from '../../providers/src/typesafe.js';
import {JEV_OPERATION,JEV_MODEL} from '../../contracts/jev.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>pool?.end());
const integration=pool?describe:describe.skip;
integration('Jev offline publication and financial acceptance',()=>{
 for(const scenario of ['disabled','success','excess','defect','missing','unknown','cancel_before','cancel_after','retry_429','retry_529'] as const)it(scenario,async()=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},clock=new ManualClock(new Date('2026-09-26T12:00:00Z'));
  await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Jev fixture']);await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
  const run=<T>(f:(tx:any)=>Promise<T>)=>transaction(pool!,f);
  const c=await run(async tx=>{const svc=new ConnectionService(tx,clock,new CredentialVault(Buffer.alloc(32,1)));const c=await svc.create(scope,{provider:'typesafe',name:'Jev fixture',account_scope:{account:scope.account_id},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'Offline test'});await svc.rotateCredential(scope,c.id,c.revision,'fixture-only',{actor_id:'fixture',reason:'Offline test'});await e.configureBudget(tx,scope,'provider',c.id,'10000000000');await e.configureBudget(tx,scope,'period','jev-budget','10000000000');await a.grant(tx,scope,clock,{idempotency_key:'fund',source:'internal',reason:'Fixture',external_reference:'fixture',amount_units:'10000000000',terms_version:'fixture',expires_at:null});return c;});
  // No real provider is called; only the dedicated disabled-profile scenario changes status.
  const document=structuredClone(bundle) as any;if(scenario==='disabled')document.resources[1].payload.models[0].status='disabled';document.resources[3].payload.execution={max_attempts:scenario.startsWith('retry_')?2:1};
  const bindings={connections:{primary:c.id},budgets:{period:'jev-budget'}},provenance={path:'configurations/api/typesafe/jev.json',git_revision:'a'.repeat(40),git_dirty:true,content_hash:'b'.repeat(64),publisher:'fixture'};
  if(scenario==='disabled'){await expect(run(tx=>previewConfiguration(tx,scope,document,bindings,provenance,clock))).rejects.toMatchObject({code:'incompatible_route'});expect((await run(tx=>a.getWallet(tx,scope,clock))).reserved_units).toBe('0');return;}
  await run(tx=>previewConfiguration(tx,scope,document,bindings,provenance,clock));
  const release=await run(tx=>publishConfiguration(tx,scope,document,bindings,provenance,clock));await run(tx=>activateConfiguration(tx,scope,release.id,0,'fixture'));

  const input=document.resources[1].payload.models[0].api.samples[0].input;
  const call={idempotency_key:'same-invoke',profile:bundle.bundle_key,input,budget:{max_units:'1376256'}};
  const accepted=await run(tx=>q.invoke(tx,scope,clock,call));expect((await run(tx=>q.invoke(tx,scope,clock,call))).request_id).toBe(accepted.request_id);
  expect((await run(tx=>a.getWallet(tx,scope,clock))).reserved_units).toBe('1376256');
  const deps=defaultRuntime(pool!,clock);let sends=0;const tokens=scenario==='excess'?100000:1000;
  deps.adapter=async()=>new TypeSafeAdapter({apiKey:'fixture',models:[JEV_OPERATION],fetch:async()=>{sends++;if(scenario.startsWith('retry_')&&sends===1)return new Response('{}',{status:scenario==='retry_429'?429:529,headers:{'retry-after':'3'}});if(scenario==='cancel_after')await run(tx=>q.cancel(tx,scope,clock,{operation_id:accepted.operation_id,idempotency_key:'cancel-after-send'}));if(scenario==='unknown')throw Error('connection lost');return new Response(JSON.stringify({model:JEV_MODEL,answers:scenario==='defect'?{}:{urgent:{type:'noul',noul:0.5},team:{type:'choice',choice:'billing',probabilities:{billing:0.51,technical:0.49},confidence:0.001},severity:{type:'score',score:0.25,probabilities:{'0':0.75,'1':0.25},legend:{'0':'Low','1':'High'},confidence:0.1}},...(scenario==='missing'?{}:{usage:{input_tokens:tokens,output_tokens:30}})}));}});
  deps.limits={scope};
  const pending=await e.getRequest(pool!,scope,accepted.request_id);const context=await deps.context(scope,pending,pending.route.primary);expect(context.limit_usage_estimate).toEqual({requests:1,input_tokens:32768,tokens:32768});
  if(scenario==='cancel_before')await run(tx=>q.cancel(tx,scope,clock,{operation_id:accepted.operation_id,idempotency_key:'cancel'}));
  await executeOne(pool!,deps,clock);await executeOne(pool!,deps,clock);
  if(scenario.startsWith('retry_')){const waiting=await e.getRequest(pool!,scope,accepted.request_id);expect(waiting.execution_status).toBe('waiting_retry');expect(sends).toBe(1);expect(new Date(waiting.not_before).getTime()).toBeGreaterThanOrEqual(clock.now().getTime()+3000);clock.advance(new Date(waiting.not_before).getTime()-clock.now().getTime()+1);await executeOne(pool!,deps,clock);await executeOne(pool!,deps,clock);}
  const request=await e.getRequest(pool!,scope,accepted.request_id);
  expect(sends).toBe(scenario==='cancel_before'?0:scenario.startsWith('retry_')?2:1);
  if(scenario==='cancel_before'){expect(request.execution_status).toBe('canceled');return;}
  if(scenario.startsWith('retry_')){expect(request.execution_status).toBe('succeeded');expect(request.attempt_count).toBe(2);expect((await pool!.query('SELECT charged_units::text FROM execution_attempts WHERE request_id=$1 ORDER BY number',[request.id])).rows).toEqual([{charged_units:'0'},{charged_units:'42000'}]);return;}
  const usageRow=(await pool!.query('SELECT usage FROM provider_usage_observations WHERE attempt_id IN (SELECT id FROM execution_attempts WHERE request_id=$1)',[request.id])).rows[0];if(scenario!=='unknown')expect(usageRow.usage.model_identity).toEqual({requested:JEV_MODEL,actual:JEV_MODEL});
  const cost=(await pool!.query('SELECT cost_units::text,charged_units::text FROM execution_attempts WHERE request_id=$1',[request.id])).rows[0];
  if(scenario==='success'||scenario==='excess'){
   expect(request.execution_status).toBe('succeeded');expect(cost.cost_units).toBe(String(tokens*42));expect(BigInt(cost.charged_units)).toBeLessThanOrEqual(1376256n);
   expect((await run(tx=>a.getWallet(tx,scope,clock))).reserved_units).toBe('0');
   const delivery=await storage.getDelivery(pool!,scope,clock,request.id);expect(delivery?.result?.content).toMatchObject({type:'structured',value:{model:JEV_MODEL}});
   const ack={request_id:request.id,version:delivery!.version,manifest_hash:delivery!.manifest_hash};const receipt=await run(tx=>storage.acknowledge(tx,scope,clock,ack));expect(await run(tx=>storage.acknowledge(tx,scope,clock,ack))).toEqual(receipt);expect((await storage.getDelivery(pool!,scope,clock,request.id))?.result).toBeNull();
   const capture=(await pool!.query('SELECT capture_id FROM request_budget_claims WHERE request_id=$1',[request.id])).rows[0];const refund={capture_id:capture.capture_id,amount_units:cost.charged_units,external_reference:id('refund'),reason:'Fixture refund',idempotency_key:'refund'};const refunded=await run(tx=>a.refund(tx,scope,clock,refund));expect(await run(tx=>a.refund(tx,scope,clock,refund))).toEqual(refunded);expect((await run(tx=>a.getWallet(tx,scope,clock))).available_units).toBe('10000000000');
  }else if(scenario==='cancel_after'){expect(request.execution_status).toBe('canceled');expect(cost.cost_units).toBe('42000');expect(cost.charged_units).toBe('42000');expect((await run(tx=>a.getWallet(tx,scope,clock))).reserved_units).toBe('0');}
  else if(scenario==='defect'){expect(cost.cost_units).toBe('42000');expect(cost.charged_units).toBe('0');}
  else {expect(cost.cost_units).toBeNull();if(scenario==='missing')expect(cost.charged_units).toBeNull();else {expect(request.execution_status).toBe('outcome_unknown');expect(cost.charged_units).toBe('0');clock.advance(3600001);await run(tx=>e.closeUnresolved(tx,clock,deps.settle,scope));expect((await run(tx=>a.getWallet(tx,scope,clock))).reserved_units).toBe('0');const attempt=(await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[request.id])).rows[0];const observation=await run(tx=>e.leaseObservation(tx,scope,clock,request.id,'late-offline-observation'));await run(tx=>e.observeAttempt(tx,scope,clock,{request_id:request.id,attempt_id:attempt.id,fence:observation.fencing_token,observation_key:'late-offline-cost',outcome:'success',cost_units:'42000',charged_units:'42000'},async()=>{throw Error('Late customer debit forbidden');}));expect((await e.getRequest(pool!,scope,request.id)).settlement_status).toBe('platform_absorbed');expect((await run(tx=>a.getWallet(tx,scope,clock))).available_units).toBe('10000000000');}}
 });
});
