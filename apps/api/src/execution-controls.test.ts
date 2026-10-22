import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {ManualClock,id} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {ConnectionService} from '../../../packages/reconciliation/src/index.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';
import {publishRecipe} from '../../../packages/quoting/src/index.js';
import {configureBudget,enqueue,leaseNext,prepareDispatch,observeAttempt} from '../../../packages/execution/src/index.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>pool?.end());
async function controlsFixture(clock:ManualClock,organization:string,limiterKey:string,publish=true){
 return transaction(pool!,async tx=>{
  const scope={organization_id:organization,application_id:id('app'),account_id:id('account')};await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,organization,'Limiter controls fixture']);await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,organization,scope.application_id,id('external')]);
  const connection=await new ConnectionService(tx,clock).create(scope,{provider:'fake',name:'Local fixture',account_scope:{fixture:scope.application_id},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'test',reason:'Control boundary fixture'});
  const catalog=new CatalogService(tx,clock),model=await catalog.createDraft(scope,{kind:'catalog',key:'models',version:1,payload:{models:[{id:'fixture-text',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'}]},author:'test',comment:'Synthetic fixture'});await catalog.publish(scope,model.id,1);
  const route=await catalog.createDraft(scope,{kind:'route',key:'route',version:1,payload:{capability:'text.generate',primary:{catalog_version_id:model.id,model:'fixture-text',connection_id:connection.id,max_cost_units:'10',limiter_key:limiterKey},deadline_seconds:1800,platform_risk_budget_units:'1000'},author:'test',comment:'Published primary limiter ownership'});if(publish)await catalog.publish(scope,route.id,1);
  const rate=await catalog.createDraft(scope,{kind:'rate_card',key:'rates',version:1,payload:{id:'fixture',currency:'USD',source:'Synthetic fixture',checked_at:clock.now().toISOString(),rates:[{id:'input',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01'},{id:'text',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01'}]},author:'test',comment:'Synthetic fixture'});await catalog.publish(scope,rate.id,1,[{usage:{state:'known',items:[{dimension:'output.text',quantity:'1',unit:'tokens'}]},context:{at:clock.now().toISOString()}}]);
  const token=(await issueToken(tx,{...scope,account_ids:null,scopes:['operations:admin','config:write'],max_grant_units:null,expires_at:null})).token;return {scope,connection,route,rate,token};
 });
}
describe.skipIf(!pool)('Effective execution controls',()=>{
 it('updates actual admission budgets with CAS, replay and application isolation, preserving spent exposure',async()=>{
  const clock=new ManualClock(new Date('2026-09-18T00:00:00Z')),scope={organization_id:id('org'),application_id:id('app')};
  const setup=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Controls']);
   const connection=await new ConnectionService(tx,clock).create(scope,{provider:'fake',name:'Fixture',account_scope:{installation:'fixture'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'test',reason:'Fixture'});
   const token=await issueToken(tx,{...scope,account_ids:null,scopes:['operations:admin','config:write'],max_grant_units:null,expires_at:null});return {connection,token};
  });
  const app=createApi(pool!,clock),headers={authorization:`Bearer ${setup.token.token}`,'idempotency-key':'create-budget'};
  const body={kind:'provider',budget_key:setup.connection.id,limit_units:'1000',expected_limit_units:null,reason:'Explicit local budget'};
  try{
   const first=await app.inject({method:'POST',url:'/v1/admin/execution-budgets',headers,payload:body});expect(first.statusCode).toBe(200);expect(first.json().limit_units).toBe('1000');
   await pool!.query('UPDATE execution_budgets SET reserved_units=100,spent_units=200 WHERE organization_id=$1',[scope.organization_id]);
   const replay=await app.inject({method:'POST',url:'/v1/admin/execution-budgets',headers,payload:body});expect(replay.statusCode).toBe(200);expect(replay.json()).toMatchObject({reserved_units:'100',spent_units:'200'});
   expect((await app.inject({method:'POST',url:'/v1/admin/execution-budgets',headers:{...headers,'idempotency-key':'stale'},payload:{...body,limit_units:'2000'}})).statusCode).toBe(409);
   const updated=await app.inject({method:'POST',url:'/v1/admin/execution-budgets',headers:{...headers,'idempotency-key':'update'},payload:{...body,limit_units:'250',expected_limit_units:'1000'}});expect(updated.statusCode).toBe(200);expect(updated.json()).toMatchObject({limit_units:'250',spent_units:'200',reserved_units:'100'});
   expect((await app.inject({method:'POST',url:'/v1/admin/execution-budgets',headers:{...headers,'idempotency-key':'foreign'},payload:{...body,budget_key:'foreign-connection'}})).statusCode).toBe(404);
   const list=await app.inject({method:'GET',url:'/v1/admin/execution-budgets',headers});expect(list.json().data).toHaveLength(1);
   expect((await pool!.query("SELECT count(*)::int n FROM audit_events WHERE application_id=$1 AND action='execution_budget.updated'",[scope.application_id])).rows[0].n).toBe(2);
  }finally{await app.close();}
 });
 it('published primary limiter controls enforce scope, concurrent CAS and replay while preserving live counters',async()=>{
  const clock=new ManualClock(new Date('2026-09-18T00:00:00Z')),organization=id('org'),key=id('quota'),f=await controlsFixture(clock,organization,key),foreign=await controlsFixture(clock,organization,id('other-quota'));
  const app=createApi(pool!,clock),headers={authorization:`Bearer ${f.token}`,'idempotency-key':'create-limiter'},body={key,window_ms:60000,request_limit:10,token_limit:'10000',concurrency_limit:2,expected_config_hash:null,reason:'Authorized local shared provider quota'};
  try{
   const created=await app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers,payload:body});expect(created.statusCode).toBe(200);expect(created.json()).toMatchObject({limiter_key:key,requests_used:0,tokens_used:'0'});const originalHash=created.json().config_hash;expect(typeof originalHash).toBe('string');
   await transaction(pool!,async tx=>{await configureBudget(tx,f.scope,'provider',f.connection.id,'1000');await configureBudget(tx,f.scope,'period','period','1000');const request=await enqueue(tx,f.scope,clock,{operation_id:id('operation'),component:'answer',client_request_key:'consume-quota',input_hash:'fixture-hash',input_ref:'fixture-input',max_units:'10',deadline_at:new Date(clock.now().getTime()+600000),route:{primary:{connection_id:f.connection.id,model:'fixture-text',endpoint_scope:`${f.connection.id}:fixture-text`,max_cost_units:'10',limiter_key:key,limit_tokens:'25'},period_budget_key:'period',request_risk_limit_units:'1000',incident_risk_limit_units:'1000'}});const lease=await leaseNext(tx,clock,'control-test-worker',{scope:f.scope});const attempt=await prepareDispatch(tx,f.scope,clock,request.id,lease.fencing_token);await observeAttempt(tx,f.scope,clock,{request_id:request.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'complete',outcome:'success',result_available:true,cost_units:'1',charged_units:'1'},async()=>{});});
   const blockedUntil=new Date(clock.now().getTime()+120000);await pool!.query('UPDATE execution_limiters SET blocked_until=$3 WHERE organization_id=$1 AND limiter_key=$2',[organization,key,blockedUntil]);clock.advance(1000);
   const listed=await app.inject({method:'GET',url:'/v1/admin/execution-limiters',headers});expect(listed.statusCode).toBe(200);expect(listed.json().data).toHaveLength(1);expect(listed.json().data[0]).toMatchObject({limiter_key:key,requests_used:1,tokens_used:'25',config_hash:originalHash});
   const raced=await Promise.all([11,12].map(request_limit=>app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers:{...headers,'idempotency-key':`race-${request_limit}`},payload:{...body,request_limit,window_ms:120000,expected_config_hash:originalHash}})));expect(raced.map(r=>r.statusCode).sort()).toEqual([200,409]);const updated=raced.find(r=>r.statusCode===200)!.json();expect(updated.config_hash).not.toBe(originalHash);expect(updated).toMatchObject({requests_used:1,tokens_used:'25',window_started_at:created.json().window_started_at,blocked_until:blockedUntil.toISOString()});
   const replay=await app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers,payload:body});expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(updated);expect((await app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers,payload:{...body,request_limit:99}})).statusCode).toBe(409);
   const foreignHeaders={authorization:`Bearer ${foreign.token}`,'idempotency-key':'foreign-mutation'};expect((await app.inject({method:'GET',url:'/v1/admin/execution-limiters',headers:foreignHeaders})).json().data).toEqual([]);expect((await app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers:foreignHeaders,payload:{...body,expected_config_hash:updated.config_hash}})).statusCode).toBe(404);
   const restricted=await transaction(pool!,tx=>issueToken(tx,{...f.scope,account_ids:[f.scope.account_id],scopes:['operations:admin','config:write'],max_grant_units:null,expires_at:null}));expect((await app.inject({method:'GET',url:'/v1/admin/execution-limiters',headers:{authorization:`Bearer ${restricted.token}`}})).statusCode).toBe(403);expect((await pool!.query("SELECT count(*)::int n FROM audit_events WHERE application_id=$1 AND action='execution_limiter.updated'",[f.scope.application_id])).rows[0].n).toBe(2);
  }finally{await app.close();}
 });
 it('a foreign draft cannot claim a live limiter and published cross-application key collisions deny reads, writes and replay',async()=>{
  const clock=new ManualClock(new Date('2026-09-18T00:00:00Z')),organization=id('org'),key=id('quota'),f=await controlsFixture(clock,organization,key),foreign=await controlsFixture(clock,organization,key,false),app=createApi(pool!,clock);
  const body={key,window_ms:60000,request_limit:10,token_limit:'10000',concurrency_limit:2,expected_config_hash:null,reason:'Local quota'},headers={authorization:`Bearer ${f.token}`,'idempotency-key':'create'};
  try{
   const first=await app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers,payload:body});expect(first.statusCode).toBe(200);const foreignHeaders={authorization:`Bearer ${foreign.token}`,'idempotency-key':'claim-via-draft'};expect((await app.inject({method:'GET',url:'/v1/admin/execution-limiters',headers:foreignHeaders})).json().data).toEqual([]);expect((await app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers:foreignHeaders,payload:{...body,expected_config_hash:first.json().config_hash}})).statusCode).toBe(404);
   await transaction(pool!,tx=>new CatalogService(tx,clock).publish(foreign.scope,foreign.route.id,1));for(const token of [f.token,foreign.token]){const h={authorization:`Bearer ${token}`,'idempotency-key':'new-edit'};expect((await app.inject({method:'GET',url:'/v1/admin/execution-limiters',headers:h})).json().data).toEqual([]);expect((await app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers:h,payload:{...body,request_limit:999,expected_config_hash:first.json().config_hash}})).statusCode).toBe(404);}
   expect((await app.inject({method:'POST',url:'/v1/admin/execution-limiters',headers,payload:body})).statusCode).toBe(404);expect((await pool!.query('SELECT request_limit,requests_used,tokens_used FROM execution_limiters WHERE organization_id=$1 AND limiter_key=$2',[organization,key])).rows[0]).toEqual({request_limit:10,requests_used:0,tokens_used:'0'});
  }finally{await app.close();}
 });
 it('period budget keys shared by two application recipes cannot be changed or read by either application administrator',async()=>{
  const clock=new ManualClock(new Date('2026-09-18T00:00:00Z')),organization=id('org'),key=id('period'),f=await controlsFixture(clock,organization,id('quota')),foreign=await controlsFixture(clock,organization,id('quota')),app=createApi(pool!,clock);
  const recipe=async(owner:typeof f)=>transaction(pool!,tx=>publishRecipe(tx,owner.scope,clock,{key:'recipe',version:1,period_budget_key:key,components:[{key:'answer',capability:'text.generate',route_version_id:owner.route.id,rate_card_version_id:owner.rate.id,count:{constant:1},limits:{input_tokens:100,output_tokens:10}}]}));await recipe(f);const headers={authorization:`Bearer ${f.token}`,'idempotency-key':'create-period'},body={kind:'period',budget_key:key,limit_units:'1000',expected_limit_units:null,reason:'Local recipe period budget'};
  try{
   expect((await app.inject({method:'POST',url:'/v1/admin/execution-budgets',headers,payload:body})).statusCode).toBe(200);await recipe(foreign);
   for(const token of [f.token,foreign.token]){const h={authorization:`Bearer ${token}`,'idempotency-key':'attempt-edit'};expect((await app.inject({method:'GET',url:'/v1/admin/execution-budgets',headers:h})).json().data).toEqual([]);expect((await app.inject({method:'POST',url:'/v1/admin/execution-budgets',headers:h,payload:{...body,limit_units:'999999',expected_limit_units:'1000'}})).statusCode).toBe(404);}
   expect((await app.inject({method:'POST',url:'/v1/admin/execution-budgets',headers,payload:body})).statusCode).toBe(404);expect((await pool!.query("SELECT limit_units FROM execution_budgets WHERE organization_id=$1 AND kind='period' AND budget_key=$2",[organization,key])).rows[0].limit_units).toBe('1000');
  }finally{await app.close();}
 });

});
