import {UaiClient} from '../../sdk/src/index.js';
import {recoverExpiredLeases} from '../../execution/src/index.js';
import type {AdapterContext,ProviderInput,ProviderResult} from '../../providers/src/contracts.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {id,ManualClock,type Scope} from '../../contracts/src/index.js';
import {AllowanceService} from '../../allowance/src/index.js';
import {publishConfiguration,activateConfiguration} from '../../configuration/src/index.js';
import {validateServiceOperation,priceApi,type ServiceOperation} from '../src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import * as accounting from '../../accounting/src/index.js';
import * as quoting from '../../quoting/src/index.js';
import * as execution from '../../execution/src/index.js';
import * as storage from '../../storage/src/index.js';
import {executeOne,observeNativeOne} from '../../execution/src/runtime.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {FakeAdapter} from '../../providers/src/index.js';
import {createApi} from '../../../apps/api/src/server.js';
import {issueToken} from '../../auth/src/index.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const pool=process.env.DATABASE_URL?createPool():null,integration=pool?describe:describe.skip;
let directory:string;beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'uai-api-services-'));vi.stubEnv('UAI_BLOB_ROOT',directory);vi.stubEnv('UAI_BLOB_BACKEND','local');});
afterAll(async()=>{await pool?.end();await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();});
const actor={actor_id:'fixture',reason:'Local API fixture only'};
export function operation():ServiceOperation{return {key:'synthetic.files',kind:'api',capability:'api.call',provider:'fake',adapter_ref:'synthetic@1',input_schema:{type:'object',additionalProperties:false,properties:{query:{type:'string',maxLength:100}},required:['query']},output_schema:{type:'object',required:['ok'],properties:{ok:{type:'boolean'}},additionalProperties:false},files:{media_types:['text/plain'],max_count:4,max_file_bytes:'1000',max_total_bytes:'4000'},billing_mode:'actual_capped',allowance_mode:'subscription',measurements:[{key:'requests',unit:'requests',source:'request',maximum:'1',expression:{op:'constant',value:'1'}},{key:'files',unit:'files',source:'verified_assets',maximum:'4',expression:{op:'field',path:'assets.count'}},{key:'bytes',unit:'bytes',source:'verified_assets',maximum:'4000',expression:{op:'field',path:'assets.bytes'}},{key:'pages',unit:'pages',source:'provider_usage',maximum:'10'}],pricing:{mode:'independent',max_units:'20000',rounding_units:'100',expression:{op:'add',args:[{op:'constant',value:'1000'},{op:'multiply',args:[{op:'field',path:'measurements.files'},{op:'constant',value:'200'}]},{op:'multiply',args:[{op:'field',path:'measurements.bytes'},{op:'constant',value:'3'}]},{op:'multiply',args:[{op:'field',path:'measurements.pages'},{op:'constant',value:'100'}]}]}},samples:[{name:'No files, maximum pages',input:{query:'Test'},assets:{count:0,bytes:'0'},measurements:{requests:'1',files:'0',bytes:'0',pages:'10'},expected_price_units:'2000'}]};}
async function fixture(modify?:(op:ServiceOperation)=>void){
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},clock=new ManualClock(new Date('2026-09-23T12:00:00Z')),op=operation();modify?.(op);
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Synthetic paid API']);
 await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
 const run=<T>(fn:(tx:import('../../db/src/index.js').Tx)=>Promise<T>)=>transaction(pool!,fn);
 const connection=await run(tx=>new ConnectionService(tx,clock).create(scope,{provider:'fake',name:'Synthetic API',account_scope:{fixture:scope.account_id},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:['request'],reporting_lag_seconds:0},limits:{},risk_policy:{}},actor));
 const rate={id:'synthetic-api-rates',currency:'USD',source:'Synthetic test prices; not provider prices',checked_at:clock.now().toISOString(),rates:op.measurements.map(m=>({id:m.key,dimension:m.key,unit:m.unit,unit_size:'1',amount:['requests','pages'].includes(m.key)?'0.001':'0',effective_from:'2026-01-01T00:00:00Z'}))};
 const document={schema_version:1,bundle_key:'synthetic-api',resources:[
  {kind:'tariff',key:'synthetic-plan',payload:{key:'synthetic-plan',provider:'fake',calendar:{kind:'calendar_month',timezone:'UTC',anchor:'2026-09-01T00:00:00Z'},counters:[{key:'requests',unit:'requests',included:'2',rollover:{enabled:false,cap:'0',expires_after_periods:1}},{key:'pages',unit:'pages',included:'20',rollover:{enabled:false,cap:'0',expires_after_periods:1}}],overage:{enabled:false,max_units:'0'},cost_allocation:{mode:'incremental'}}},
  {kind:'rate_card',key:'synthetic-api-rates',payload:rate,samples:[{usage:{state:'known',items:op.measurements.map(m=>({dimension:m.key,unit:m.unit,quantity:m.maximum}))},context:{at:clock.now().toISOString()}}]},
  {kind:'catalog',key:'synthetic-api-model',payload:{models:[{id:op.key,provider:'fake',adapter_ref:'synthetic@1',api:op,capabilities:['api.call'],allowed_parameters:[],status:'active',rate_card_version_id:'@rate_card:synthetic-api-rates'}]}},
  {kind:'route',key:'synthetic-api-route',payload:{capability:'api.call',primary:{catalog_version_id:'@catalog:synthetic-api-model',model:op.key,connection_id:'@connection:primary',max_cost_units:'100000000'},deadline_seconds:1800,platform_risk_budget_units:'1600000000'}},
  {kind:'recipe',key:'synthetic-api',payload:{period_budget_key:'@budget:period',components:[{key:'call',capability:'api.call',route_version_id:'@route:synthetic-api-route',rate_card_version_id:'@rate_card:synthetic-api-rates',count:{constant:1},limits:{}}]}},
 ]};
 const published=await run(tx=>publishConfiguration(tx,scope,document,{connections:{primary:connection.id},budgets:{period:id('period')}},{path:'configurations/fixtures/synthetic-api.json',git_revision:'a'.repeat(40),git_dirty:true,content_hash:'b'.repeat(64),publisher:actor.actor_id},clock));
 await run(tx=>activateConfiguration(tx,scope,published.id,0,actor.actor_id));
 const account=await run(tx=>new AllowanceService(tx,clock).createAccount(scope,{provider:'fake',name:'Synthetic shared account',external_reference:id('ext'),reason:actor.reason},actor));
 const subscription=await run(tx=>new AllowanceService(tx,clock).createSubscription(scope,{provider_account_id:account.id,tariff_version_id:published.resources.find((r:{kind:string;id:string})=>r.kind==='tariff')!.id,starts_at:'2026-09-01T00:00:00Z',installation_share:{requests:'2',pages:'20'},reason:actor.reason},actor));
 await run(tx=>new AllowanceService(tx,clock).bindConnection(scope,connection.id,{provider_account_id:account.id,subscription_id:subscription.id,reason:actor.reason},0,actor));
 const recipe=(await run(tx=>quoting.listRecipes(tx,scope)))[0];
 await run(async tx=>{await execution.configureBudget(tx,scope,'provider',connection.id,'100000000000');await execution.configureBudget(tx,scope,'period',recipe.definition.period_budget_key,'100000000000');await accounting.grant(tx,scope,clock,{idempotency_key:'fund',source:'internal',reason:actor.reason,external_reference:'fixture',amount_units:'1000000000',terms_version:'fixture',expires_at:null});});
 const quote=(input:Record<string,unknown>={query:'Test'})=>run(tx=>quoting.createQuote(tx,scope,clock,{idempotency_key:id('quote'),profile:'synthetic-api',input}));
 const invoke=async(input:Record<string,unknown>={query:'Test'})=>{const q=await quote(input);return run(tx=>quoting.invoke(tx,scope,clock,{quote_id:q.id,idempotency_key:id('invoke')}));};
 const state=()=>run(tx=>new AllowanceService(tx,clock).state(scope,subscription.id));
 const execute=async(pages:string,unknown=false)=>{const deps=defaultRuntime(pool!,clock);deps.limits={scope};deps.adapter=async()=>new FakeAdapter([{outcome:'success',content_type:'application/json',text:'{"ok":true}',usage:unknown?{state:'unknown',reason:'missing_usage'}:{state:'known',items:[{dimension:'pages',unit:'pages',quantity:pages}]}}]);return executeOne(pool!,deps,clock,'api-fixture');};
 return {scope,clock,run,quote,invoke,state,execute,connection,subscription,account,document,published};
}
it('rejects unsupported schema keywords and undefined formula measurements',()=>{
 const op=operation();(op.input_schema as any).$ref='https://example.com/schema';expect(()=>validateServiceOperation(op)).toThrow('Unsupported JSON Schema keyword');
 const invalid=operation();invalid.measurements[0].expression={op:'field',path:'input.forged_cost'};expect(()=>validateServiceOperation(invalid)).toThrow();
});
it('calculates cost-plus independently from native credit quantities',()=>{
 const op=operation();op.pricing={mode:'cost_plus',markup_percent:'100',safety_factor:'1',max_units:'100000000',rounding_units:'100'};
 const card={id:'synthetic',currency:'USD' as const,source:'Synthetic test',checked_at:'2026-09-23T00:00:00Z',rates:op.measurements.map(m=>({id:m.key,dimension:m.key,unit:m.unit,unit_size:'1',amount:'0.001',effective_from:'2026-01-01T00:00:00Z'}))};
 expect(priceApi(op,{requests:'1',files:'0',bytes:'0',pages:'3'},card,{at:'2026-09-23T00:00:00Z'},'1234')).toBe('2500');
 expect(priceApi(op,{requests:'1',files:'0',bytes:'0',pages:'3'},card,{at:'2026-09-23T00:00:00Z'},'0')).toBe('0');
});
integration('Paid API pipeline',()=>{
 it('honors a fixed quote while settling lower actual native usage',async()=>{
  const f=await fixture(op=>{op.billing_mode='quoted_final'}),call=await f.invoke();await f.execute('3');
  expect(await f.run(tx=>quoting.getOperation(tx,f.scope,f.clock,call.operation_id))).toMatchObject({captured_units:'2000',settlement_status:'settled'});
  expect((await f.state()).metrics[1]).toMatchObject({consumed:'3',reserved:'0'});
 });
 it('prices verified files and actual pages through the existing wallet and execution lifecycle',async()=>{
  const f=await fixture(),blobs=new storage.LocalBlobStore(directory),assetIds=[];
  for(const text of ['abc','xyz']){const key=id('blob'),bytes=Buffer.from(text);await blobs.put(key,bytes);const asset=await f.run(tx=>storage.registerAsset(tx,f.scope,f.clock,{kind:'input',blob_key:key,content_hash:storage.contentHash(bytes),media_type:'text/plain',size_bytes:bytes.length,expires_at:new Date(f.clock.now().getTime()+3600000)}));assetIds.push(asset.id);}
  const result=await f.invoke({query:'Files',asset_ids:assetIds});expect((await f.state()).metrics).toMatchObject([{reserved:'1'},{reserved:'10'}]);
  expect(await f.execute('3')).toMatchObject({state:'succeeded'});
  expect(await f.run(tx=>quoting.getOperation(tx,f.scope,f.clock,result.operation_id))).toMatchObject({captured_units:'1800',settlement_status:'settled'});
  expect((await f.state()).metrics).toMatchObject([{consumed:'1',reserved:'0'},{consumed:'3',reserved:'0'}]);
  const cost=(await pool!.query('SELECT rounded_units FROM provider_cost_entries WHERE organization_id=$1',[f.scope.organization_id])).rows;expect(cost).toEqual([{rounded_units:'0'}]);
  await expect(f.quote({query:'Forged',files:100})).rejects.toMatchObject({code:'invalid_api_operation'});
  await expect(f.quote({query:'Duplicate',asset_ids:[assetIds[0],assetIds[0]]})).rejects.toThrow();
 });
 it('rejects exhausted allowance before financial reserve and retains idempotent accepted commands',async()=>{
  const f=await fixture();await f.invoke();await f.invoke();const before=await f.run(tx=>accounting.getWallet(tx,f.scope,f.clock));
  const q=await f.quote();await expect(f.run(tx=>quoting.invoke(tx,f.scope,f.clock,{quote_id:q.id,idempotency_key:'blocked'}))).rejects.toMatchObject({code:'allowance_exhausted'});
  expect(await f.run(tx=>accounting.getWallet(tx,f.scope,f.clock))).toEqual(before);
  expect((await pool!.query('SELECT id FROM operations WHERE organization_id=$1',[f.scope.organization_id])).rowCount).toBe(2);
 });
 it('caps actual customer price while recording full provider excess',async()=>{
  const f=await fixture(op=>{op.pricing.max_units='5000';}),result=await f.invoke();await f.execute('100');
  expect(await f.run(tx=>quoting.getOperation(tx,f.scope,f.clock,result.operation_id))).toMatchObject({captured_units:'5000'});
  expect((await f.state()).metrics[1]).toMatchObject({consumed:'100',overdrawn:'80'});
 });
 it('keeps unknown usage reserved instead of billing zero, and cancellation frees unsent allowance',async()=>{
  const f=await fixture(),result=await f.invoke();await f.execute('0',true);
  expect((await f.state()).metrics[1]).toMatchObject({reserved:'10',consumed:'0'});
  expect(await f.run(tx=>quoting.getOperation(tx,f.scope,f.clock,result.operation_id))).toMatchObject({captured_units:'0',settlement_status:'open'});
  const next=await f.invoke();await f.run(tx=>quoting.cancel(tx,f.scope,f.clock,{operation_id:next.operation_id,idempotency_key:'cancel'}));
  expect((await f.state()).metrics[0]).toMatchObject({reserved:'1'});
 });
 it('recovers an asynchronous API job without resubmitting or releasing uncertain allowance',async()=>{
  const f=await fixture(),call=await f.invoke();let submits=0;
  const api=createApi(pool!,f.clock),address=await api.listen({host:'127.0.0.1',port:0});
  const token=(await f.run(tx=>issueToken(tx,{...f.scope,account_ids:[f.scope.account_id],scopes:['ai:read'],max_grant_units:'1',expires_at:null}))).token;
  const client=new UaiClient({baseUrl:address,token}),abort=new AbortController(),stream=client.events({operation_id:call.operation_id,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])});
  let first:any;try{first=(await stream.next()).value;}finally{abort.abort();await stream.return(undefined);}
  try{

  class NativeApi extends FakeAdapter {
   override readonly capabilities={...new FakeAdapter().capabilities,native_jobs:true,lookup:true};
   async submitNative(_input:ProviderInput,context:AdapterContext){submits++;await context.onRemoteJob!('synthetic-job');f.clock.advance(30001);throw new Error('Synthetic crash after durable job id');return {job_id:'synthetic-job'};}
   async lookupNative(job:string):Promise<ProviderResult>{expect(job).toBe('synthetic-job');return {outcome:'success',output:{content_type:'application/json',text:'{"ok":true}'},usage:{state:'known',items:[{dimension:'pages',unit:'pages',quantity:'3'}]}};}
  }
  const deps=defaultRuntime(pool!,f.clock);deps.limits={scope:f.scope};deps.adapter=async()=>new NativeApi();
  await expect(executeOne(pool!,deps,f.clock)).rejects.toMatchObject({code:'stale_lease'});
  expect((await f.state()).metrics[1].reserved).toBe('10');
  await f.run(tx=>recoverExpiredLeases(tx,f.clock,f.scope));
  const restarted=defaultRuntime(pool!,f.clock);restarted.limits={scope:f.scope};restarted.adapter=async()=>new NativeApi();
  expect((await executeOne(pool!,restarted,f.clock)).worked).toBe(false);
  expect((await observeNativeOne(pool!,restarted,f.clock)).state).toBe('succeeded');
  expect(submits).toBe(1);
  const resumedAbort=new AbortController(),resumed=new UaiClient({baseUrl:address,token}).events({operation_id:call.operation_id,lastEventId:first.id,signal:AbortSignal.any([resumedAbort.signal,AbortSignal.timeout(5000)])});
  try{const next=(await resumed.next()).value!;expect(BigInt(next.sequence)).toBeGreaterThan(BigInt(first.sequence));}finally{resumedAbort.abort();await resumed.return(undefined);}
  expect(await client.operations.get(call.operation_id)).toMatchObject({settlement_status:'settled'});
  expect((await f.state()).metrics[1]).toMatchObject({consumed:'3',reserved:'0'});
  expect(await f.run(tx=>quoting.getOperation(tx,f.scope,f.clock,call.operation_id))).toMatchObject({captured_units:'1300',settlement_status:'settled'});
  }finally{await api.close();}
 });
 it('audited increase covers prior overdraw before granting new capacity',async()=>{
  const f=await fixture();await f.invoke();await f.execute('30');const state=await f.state();
  await f.run(tx=>new AllowanceService(tx,f.clock).adjust(f.scope,f.subscription.id,{period_id:state.period_id,metric:'pages',direction:'increase',quantity:'20',reason:actor.reason,evidence_id:'correction'},actor));
  expect((await f.state()).metrics[1]).toMatchObject({available:'10',overdrawn:'0',consumed:'30'});
  await f.invoke();expect((await f.state()).metrics[1].reserved).toBe('10');
 });
 it('protects administrative allowance data and uses idempotency and binding revisions',async()=>{
  const f=await fixture(),app=createApi(pool!,f.clock);
  const token=async(accountIds:string[]|null)=>f.run(tx=>issueToken(tx,{...f.scope,account_ids:accountIds,scopes:['operations:admin','config:write'],max_grant_units:'1',expires_at:null}));
  const admin=(await token(null)).token,user=(await token([f.scope.account_id])).token;
  try{
   expect((await app.inject({method:'GET',url:`/v1/admin/provider-subscriptions/${f.subscription.id}/allowance`,headers:{authorization:`Bearer ${user}`}})).statusCode).toBe(403);
   expect((await app.inject({method:'GET',url:`/v1/admin/provider-subscriptions/${f.subscription.id}/allowance`,headers:{authorization:`Bearer ${admin}`}})).statusCode).toBe(200);
   const request={method:'PUT' as const,url:`/v1/admin/connections/${f.connection.id}/provider-account`,headers:{authorization:`Bearer ${admin}`,'idempotency-key':'rebind','if-match':'1'},payload:{provider_account_id:f.account.id,subscription_id:f.subscription.id,reason:'Fixture rebinding'}};
   const first=await app.inject(request),second=await app.inject(request);expect(first.statusCode).toBe(200);expect(first.json()).toEqual(second.json());expect(first.json().revision).toBe(2);
   expect((await app.inject({...request,headers:{...request.headers,'idempotency-key':'stale'}})).statusCode).toBe(409);
  }finally{await app.close();}
 });
});
