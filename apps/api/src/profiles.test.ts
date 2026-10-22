import {afterAll,describe,test,expect} from 'vitest';
import {createPool,transaction,type Tx} from '../../../packages/db/src/index.js';
import {id,ManualClock,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';
import {ConnectionService,ReconciliationService} from '../../../packages/reconciliation/src/index.js';
import {getWallet} from '../../../packages/accounting/src/index.js';
import {createApi} from './server.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const integration=process.env.DATABASE_URL?describe:describe.skip;const pool=process.env.DATABASE_URL?createPool():null;const apps:ReturnType<typeof createApi>[]=[];
afterAll(async()=>{await Promise.all(apps.map(app=>app.close()));await pool?.end();});
async function fixture(organization_id=id('org')){
 const scope:Scope={organization_id,application_id:id('app'),account_id:id('account')};const clock=new ManualClock(new Date('2026-01-01T12:00:00Z'));const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Public profile limit fixture']);await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$1)',[scope.account_id,scope.organization_id,scope.application_id]);
 const account_scope={provider_account:'private-account-sentinel',project:'private-project-sentinel'};const primary=await run(tx=>new ConnectionService(tx,clock).create(scope,{provider:'fake',name:'Private connection name',account_scope,capabilities:{usage_reporting:true,cost_reporting:true,balance_reporting:true,request_cost_lookup:false,reporting_granularity:['account'],reporting_lag_seconds:0},limits:{},risk_policy:{}},{actor_id:'private-author-sentinel',reason:'private-reason-sentinel'}));
 const fallback=await run(tx=>new ConnectionService(tx,clock).create(scope,{provider:'fake',name:'No report connection',account_scope:{provider_account:'other-private-account'},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'private-author-sentinel',reason:'private-reason-sentinel'}));
 const profiles=await run(async tx=>{
  const catalog=new CatalogService(tx,clock);const models=await catalog.createDraft(scope,{kind:'catalog',key:'fixture-models',version:1,payload:{models:[{id:'fixture-model',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'}]},author:'private-author-sentinel',comment:'private-comment-sentinel'});await catalog.publish(scope,models.id,1);
  const profiles=[];for(const version of [1,2]){const profile=await catalog.createDraft(scope,{kind:'route',key:'fixture-profile',version,payload:{capability:'text.generate',primary:{catalog_version_id:models.id,model:'fixture-model',connection_id:primary.id,max_cost_units:'100'},fallback:{catalog_version_id:models.id,model:'fixture-model',connection_id:fallback.id,max_cost_units:'100'},deadline_seconds:1800,platform_risk_budget_units:'1000'},author:'private-author-sentinel',comment:'private-comment-sentinel'});await catalog.publish(scope,profile.id,1);profiles.push(profile);}
  return profiles;
 });
 const api=createApi(pool!,clock);apps.push(api);const token=(await run(tx=>issueToken(tx,{...scope,account_ids:[scope.account_id],scopes:['ai:read'],max_grant_units:null,expires_at:null}))).token;
 const get=()=>api.inject({method:'GET',url:'/v1/profiles',headers:{authorization:`Bearer ${token}`}});
 const snapshot=(extra:Record<string,unknown>={})=>run(tx=>new ReconciliationService(tx,clock).addSnapshot(scope,{connection_id:primary.id,account_scope,metric:'prepaid_balance',source:'provider_api',native_unit:'USD',total:'100',used:'20',remaining:'80',fetched_at:'2026-01-01T11:59:00Z',covered_through:'2026-01-01T11:58:00Z',precision:'exact',stale_after_seconds:300,...extra} as any,{actor_id:'private-author-sentinel',reason:'private-reason-sentinel'}));
 return {scope,clock,run,primary,fallback,profiles,get,snapshot,account_scope};
}
integration('Public published profile provider limits',()=>{
 test('latest per metric keeps source/precision/native decimals; stale and unknown remain explicit without wallet writes',async()=>{
  const f=await fixture();const before=await f.run(tx=>getWallet(tx,f.scope,f.clock));
  await f.snapshot();await f.snapshot({source:'manual',fetched_at:'2026-01-01T11:59:30Z',precision:'estimated',total:'9007199254740993.000000001',used:'0',remaining:'9007199254740993.000000001'});
  await f.snapshot({metric:'quota',source:'derived',native_unit:'tokens',total:'1000',used:'700',remaining:'300',fetched_at:'2026-01-01T10:00:00Z',covered_through:'2026-01-01T09:59:00Z',precision:'estimated',stale_after_seconds:60});
  const response=await f.get();expect(response.statusCode,response.body).toBe(200);const rows=response.json().data;expect(rows.map((p:any)=>p.version)).toEqual([2,1]);
  const [primary,fallback]=rows[0].provider_limits;expect(primary).toMatchObject({role:'primary',model:'fixture-model',provider:'fake',scope:'provider_account',status:'known'});expect(primary.metrics).toHaveLength(2);
  expect(primary.metrics.find((m:any)=>m.metric==='prepaid_balance')).toEqual({metric:'prepaid_balance',source:'manual',precision:'estimated',freshness:'fresh',fetched_at:'2026-01-01T11:59:30.000Z',covered_through:'2026-01-01T11:58:00.000Z',native_unit:'USD',total:'9007199254740993.000000001',used:'0',remaining:'9007199254740993.000000001'});
  expect(primary.metrics.find((m:any)=>m.metric==='quota')).toMatchObject({freshness:'stale',native_unit:'tokens',remaining:'300'});expect(fallback).toEqual({role:'fallback',model:'fixture-model',provider:'fake',scope:'provider_account',status:'unknown',metrics:[]});
  expect(response.body).not.toMatch(/private-|account_scope|author|"reason"|comment|secret|credential/);expect(response.body).not.toContain(f.scope.account_id);
  f.clock.advance(300001);expect((await f.get()).json().data[0].provider_limits[0].metrics.every((m:any)=>m.freshness==='stale')).toBe(true);
  expect(await f.run(tx=>getWallet(tx,f.scope,f.clock))).toEqual(before);expect((await pool!.query('SELECT count(*)::int n FROM journal_transactions WHERE wallet_id=$1',[before.id])).rows[0].n).toBe(0);
 });
 test('foreign and malformed route references cannot expose another app snapshot or metadata',async()=>{
  const f=await fixture();const other=await fixture(f.scope.organization_id);await other.snapshot({remaining:'987654321',source:'manual'});
  // Insert malformed legacy configuration to verify read isolation independently of publish-time validation.
  for(const [key,payload] of [['foreign',{primary:{model:'legacy-model',connection_id:other.primary.id,catalog_version_id:other.profiles[0].id,secret:'private-secret-sentinel'},account_scope:{account:'private-scope-sentinel'}}],['malformed',{primary:null,fallback:'invalid',author:'private-author-sentinel',deadline_seconds:{account_scope:'private-scope-sentinel'},recovery_delays_seconds:[{secret:'private-secret-sentinel'}]}]] as const){await pool!.query("INSERT INTO configuration_versions(id,organization_id,application_id,kind,key,version,status,payload,author,comment,created_at,published_at) VALUES($1,$2,$3,'route',$4,1,'published',$5,$6,$7,$8,$8)",[id('profile'),f.scope.organization_id,f.scope.application_id,key,payload,'private-author-sentinel','private-comment-sentinel',f.clock.now()]);}
  const response=await f.get();expect(response.statusCode,response.body).toBe(200);expect(response.body).not.toContain('987654321');expect(response.body).not.toContain(other.primary.id);expect(response.body).not.toContain(other.profiles[0].id);expect(response.body).not.toMatch(/private-|account_scope|author|"reason"|comment|secret|credential/);
  expect(response.json().data.find((p:any)=>p.key==='foreign').provider_limits).toEqual([{role:'primary',model:'legacy-model',provider:'unavailable',scope:'provider_account',status:'unknown',metrics:[]}]);
  expect(response.json().data.find((p:any)=>p.key==='malformed').provider_limits.every((v:any)=>v.provider==='unavailable'&&v.status==='unknown'&&v.metrics.length===0)).toBe(true);
 });
 test('unknown precision or mismatched provider-account snapshot cannot masquerade as a known limit',async()=>{
  const f=await fixture();await f.snapshot({precision:'unknown',total:undefined,used:undefined,remaining:undefined});
  await pool!.query("INSERT INTO provider_snapshots(id,connection_id,organization_id,application_id,account_scope,metric,source,native_unit,total,fetched_at,precision,stale_after_seconds,author,reason) VALUES($1,$2,$3,$4,$5,'credit_limit','manual','USD','222222',$6,'exact',300,$7,$7)",[id('snapshot'),f.primary.id,f.scope.organization_id,f.scope.application_id,{provider_account:'wrong-account'},f.clock.now(),'private-author-sentinel']);
  const response=await f.get();expect(response.statusCode).toBe(200);const limit=response.json().data[0].provider_limits[0];expect(limit).toMatchObject({status:'unknown',metrics:[{precision:'unknown',total:null,used:null,remaining:null}]});expect(limit.metrics).toHaveLength(1);expect(response.body).not.toContain('222222');
 });
});
