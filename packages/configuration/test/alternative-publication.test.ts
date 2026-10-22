import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {id,ManualClock,type Scope} from '../../contracts/src/index.js';
import {ConnectionService,CredentialVault} from '../../reconciliation/src/connections.js';
import {alternativeModels,alternativeBundle} from '../../model-pricing/src/alternative-examples.js';
import {publishConfiguration,activateConfiguration,parseConfiguration} from '../src/index.js';
import * as q from '../../quoting/src/index.js';
import * as a from '../../accounting/src/index.js';
import * as e from '../../execution/src/index.js';
import {executeOne} from '../../execution/src/runtime.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {createRegisteredAdapter} from '../../providers/src/registry.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>pool?.end());
const integration=pool?describe:describe.skip;
integration('AMI-A09/A12 full publication and financial execution',()=>{
 for(const m of alternativeModels)it(`${m.provider}/${m.id} publishes, quotes, dispatches once and captures actual usage`,async()=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},clock=new ManualClock(new Date('2026-09-25T12:00:00Z'));
  await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'AMI fixture']);await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
  const run=<T>(f:(tx:any)=>Promise<T>)=>transaction(pool!,f);
  const c=await run(async tx=>{const svc=new ConnectionService(tx,clock,new CredentialVault(Buffer.alloc(32,1)));const c=await svc.create(scope,{provider:m.provider,name:'AMI fixture',account_scope:m.provider==='google_cloud'?{project:'fixture-project',location:'global'}:{account:'fixture'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'Offline tests'});await svc.rotateCredential(scope,c.id,c.revision,'fixture-only',{actor_id:'fixture',reason:'Offline tests'});await e.configureBudget(tx,scope,'provider',c.id,'10000000000');await e.configureBudget(tx,scope,'period','ami-budget','10000000000');await a.grant(tx,scope,clock,{idempotency_key:'fund',source:'internal',reason:'Fixture',external_reference:'fixture',amount_units:'10000000000',terms_version:'fixture',expires_at:null});return c;});
  const bundle=alternativeBundle(m.provider,m.id);const release=await run(tx=>publishConfiguration(tx,scope,parseConfiguration(bundle),{connections:{[m.provider]:c.id},budgets:{'alternative-models':'ami-budget'}},{path:'configurations/ai/alternatives/fixture.json',git_revision:'a'.repeat(40),git_dirty:true,content_hash:'b'.repeat(64),publisher:'fixture'},clock));await run(tx=>activateConfiguration(tx,scope,release.id,0,'fixture'));
  const call={idempotency_key:'same-invoke',profile:bundle.bundle_key,input:{text:'hello'},parameters:{expected_output_tokens:32,max_output_tokens:256}};
  const accepted=await run(tx=>q.invoke(tx,scope,clock,call));const replay=await run(tx=>q.invoke(tx,scope,clock,call));expect(replay.request_id).toBe(accepted.request_id);
  const deps=defaultRuntime(pool!,clock);let sends=0;deps.adapter=async()=>createRegisteredAdapter(m.provider,{apiKey:'fixture',models:[m.id],googleProject:'fixture-project',googleLocation:'global',googleToken:{get:async()=> 'fixture'},fetch:async()=>{sends++;return new Response(JSON.stringify(m.provider==='google_cloud'?{candidates:[{finishReason:'STOP',content:{parts:[{text:'hello'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:5}}:{choices:[{finish_reason:'stop',message:{content:'hello'}}],usage:{prompt_tokens:100,completion_tokens:25}}));}});
  deps.limits={scope};await executeOne(pool!,deps,clock);const request=await e.getRequest(pool!,scope,accepted.request_id);expect(sends).toBe(1);expect(request.execution_status).toBe('succeeded');expect(request.attempt_count).toBe(1);if(m.provider==='google_cloud')expect(request.route.primary.service_mode).toBe('standard');
  const cost=(await pool!.query('SELECT cost_units::text,charged_units::text FROM execution_attempts WHERE request_id=$1',[request.id])).rows[0];
  expect(BigInt(cost.cost_units)).toBeGreaterThan(0n);expect(cost.charged_units).toBe(cost.cost_units);
  expect((await run(tx=>a.getWallet(tx,scope,clock))).reserved_units).toBe('0');
  if(m.provider==='google_cloud'){
   clock.advance(Date.parse('2026-12-31T23:59:58Z')-clock.now().getTime());
   const pending=await run(tx=>q.invoke(tx,scope,clock,{...call,idempotency_key:'expires-before-send'}));clock.advance(3000);
   await expect(defaultRuntime(pool!,clock).context(scope,await e.getRequest(pool!,scope,pending.request_id),request.route.primary)).rejects.toThrow('Current model rates are missing or expired');
   expect(sends).toBe(1);
   await executeOne(pool!,deps,clock);const expired=await e.getRequest(pool!,scope,pending.request_id);expect(expired.execution_status).toBe('failed');expect(expired.attempt_count).toBe(0);expect(sends).toBe(1);expect((await run(tx=>a.getWallet(tx,scope,clock))).reserved_units).toBe('0');
  }
 });
});
