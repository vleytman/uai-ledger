import {settleRequest} from '../../../packages/quoting/src/index.js';
import {writeWorkerHeartbeat} from '../../../packages/queue/src/worker-heartbeat.js';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {enqueue,leaseNext,prepareDispatch,observeAttempt,closeUnresolved,configureLimiter,configureBudget,type ExecutionRoute} from '../../../packages/execution/src/index.js';
import {id,ManualClock} from '../../../packages/contracts/src/index.js';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {createApi} from './server.js';
import {isolatedTestDatabase} from '../../../packages/db/test/isolated-database.js';
const database=isolatedTestDatabase(process.env.DATABASE_URL);let pool:ReturnType<typeof createPool>|null=null;
beforeAll(async()=>{if(process.env.DATABASE_URL){await database.initialize();pool=database.pool}});
afterAll(()=>database.close());
describe.skipIf(!process.env.DATABASE_URL)('execution metrics API',()=>{
 it('measures only unconsumed notification events in this application, including old backlog',async()=>{
  const clock=new ManualClock(new Date('2026-01-03T12:00:00Z')),scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const token=await transaction(pool!,async tx=>{await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Outbox metrics']);return issueToken(tx,{...scope,scopes:['operations:admin'],account_ids:null,max_grant_units:null,expires_at:null})});
  const event=async(type:string,seconds:number,application=scope.application_id)=>{
   const key=id('event');await pool!.query("INSERT INTO outbox_events(id,organization_id,application_id,account_id,type,resource,occurred_at) VALUES($1,$2,$3,$4,$5,'{}',$6)",[key,scope.organization_id,application,scope.account_id,type,new Date(clock.now().getTime()-seconds*1000)]);return key;
  };
  const old=await event('provider.auth_failed',90000),recent=await event('provider.recovered',30),consumed=await event('provider.failover_started',120000);
  await event('provider.auth_failed',180000,id('foreign'));await event('request.queued',180000);await event('provider.auth_failed',-60);
  await pool!.query('INSERT INTO notification_event_consumption(event_id,consumed_at) VALUES($1,$2)',[consumed,clock.now()]);
  const app=createApi(pool!,clock);
  try{
   const get=async()=>{const r=await app.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${token.token}`}});expect(r.statusCode,r.body).toBe(200);return apiSchemas.ExecutionMetricsResponse.parse(r.json()).notification_outbox};
   expect(await get()).toEqual({pending:2,oldest_pending_seconds:90000});
   await pool!.query('INSERT INTO notification_event_consumption(event_id,consumed_at) VALUES($1,$3),($2,$3)',[old,recent,clock.now()]);
   expect(await get()).toEqual({pending:0,oldest_pending_seconds:0});
  }finally{await app.close()}
 });
 it('retains settlement failure diagnostics after rollback without committing execution changes',async()=>{
  const clock=new ManualClock(new Date('2026-01-03T12:00:00Z')),scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const token=await transaction(pool!,async tx=>{await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Settlement metrics']);return issueToken(tx,{...scope,scopes:['operations:admin'],account_ids:null,max_grant_units:null,expires_at:null})});
  const request=await transaction(pool!,tx=>enqueue(tx,scope,clock,{backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'result',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(clock.now().getTime()+3600000)}));
  // Deliberately no accounting claim: settlement must fail and roll back all preceding writes.
  await expect(transaction(pool!,async tx=>{await tx.query("UPDATE execution_requests SET reason='must_rollback' WHERE id=$1",[request.id]);await settleRequest(tx,scope,clock,{request_id:request.id,charged_units:'0',reason:'test',idempotency_key:id('key')})})).rejects.toThrow();
  expect((await pool!.query('SELECT reason FROM execution_requests WHERE id=$1',[request.id])).rows[0].reason).not.toBe('must_rollback');
  expect((await pool!.query('SELECT error_kind FROM execution_settlement_errors WHERE request_id=$1',[request.id])).rows).toEqual([{error_kind:'domain'}]);
  const app=createApi(pool!,clock);
  try{const r=await app.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${token.token}`}});expect(r.statusCode,r.body).toBe(200);expect(r.json().settlement_errors).toEqual({total_24h:1,domain_24h:1,infrastructure_24h:0});}finally{await app.close()}
 });
 it('scopes live backlog and current outbox generation, retaining old unknowns outside the latency window',async()=>{
  const clock=new ManualClock(new Date('2026-01-03T12:00:00Z')),scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const other={...scope,application_id:id('app')};
  const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const tokens=await transaction(pool!,async tx=>{
   for(const s of [scope,other])await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[s.application_id,s.organization_id,'Metrics test']);
   const token=(scopes:string[],accounts:string[]|null=null,s=scope)=>issueToken(tx,{...s,scopes,account_ids:accounts,max_grant_units:null,expires_at:null});
   return {admin:await token(['operations:admin']),restricted:await token(['operations:admin'],[scope.account_id]),denied:await token(['ai:read']),other:await token(['operations:admin'],null,other)};
  });
  const add=(s=scope,capability='text.generate')=>transaction(pool!,tx=>enqueue(tx,s,clock,{priority:10,backend:'bullmq',capability,operation_id:id('op'),component:'result',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(clock.now().getTime()+3600000)}));
  const waiting=await add(),running=await add(),unknown=await add(),done=await add(),failed=await add(),future=await add(scope,'image.generate');
  await add(other);
  // Financial closure is final even when a legacy status is open or the platform absorbed the cost.
  for(const status of ['platform_absorbed','settled','open']){
   const closed=await add(scope,'speech.synthesize');
   await pool!.query("UPDATE execution_requests SET execution_status='succeeded',settlement_status=$2,financial_closed_at=$3 WHERE id=$1",[closed.id,status,clock.now()]);
  }
  const oldUnsettled=await add(scope,'speech.synthesize');
  await pool!.query("UPDATE execution_requests SET execution_status='succeeded',settlement_status='unresolved',created_at=$2::timestamptz-interval '28 hours',first_dispatched_at=$2::timestamptz-interval '27 hours' WHERE id=$1",[oldUnsettled.id,clock.now()]);
  await pool!.query("UPDATE execution_requests SET reason='waiting_rate_limit',execution_status='waiting_retry',enqueued_at=$2::timestamptz-interval '10 seconds',dispatch_generation=1 WHERE id=$1",[waiting.id,clock.now()]);
  await pool!.query("INSERT INTO execution_dispatches(request_id,generation,queue_kind,due_at) VALUES($1,1,'text',$2::timestamptz-interval '5 seconds')",[waiting.id,clock.now()]);
  await pool!.query("UPDATE execution_dispatches SET due_at=$2::timestamptz-interval '100 seconds' WHERE request_id=$1 AND generation=0",[waiting.id,clock.now()]);
  await pool!.query("UPDATE execution_requests SET execution_status='running',lease_expires_at=$2::timestamptz+interval '20 seconds' WHERE id=$1",[running.id,clock.now()]);
  await pool!.query("UPDATE execution_requests SET execution_status='outcome_unknown',created_at=$2::timestamptz-interval '28 hours',unresolved_at=$2::timestamptz-interval '26 hours' WHERE id=$1",[unknown.id,clock.now()]);
  await pool!.query("UPDATE execution_requests SET execution_status='succeeded',settlement_status='settled',financial_closed_at=$2,enqueued_at=$2::timestamptz-interval '20 seconds',first_dispatched_at=$2::timestamptz-interval '15 seconds' WHERE id=$1",[done.id,clock.now()]);
  await pool!.query("UPDATE execution_requests SET execution_status='failed',financial_closed_at=$2 WHERE id=$1",[failed.id,clock.now()]);
  await pool!.query("UPDATE execution_dispatches SET due_at=$2::timestamptz+interval '10 seconds' WHERE request_id=$1",[future.id,clock.now()]);
  const app=createApi(pool!,clock),url='/v1/admin/execution-metrics';
  const get=(token:string)=>app.inject({method:'GET',url,headers:{authorization:`Bearer ${token}`}});
  try{
   expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
   expect((await get(tokens.denied.token)).statusCode).toBe(403);
   expect((await get(tokens.restricted.token)).statusCode).toBe(403);
   const response=await get(tokens.admin.token);expect(response.statusCode).toBe(200);
   const report=apiSchemas.ExecutionMetricsResponse.parse(response.json());
   expect(report.data.find(q=>q.queue_kind==='text')).toMatchObject({waiting:1,active_leases:1,running:1,unknown:1,waiting_rate_limit:1,oldest_wait_seconds:10,oldest_unknown_seconds:93600,dispatch_samples_24h:1,first_dispatch_wait_p50_ms:5000,first_dispatch_wait_p95_ms:5000,queue_wait_samples_24h:0,ready_queue_wait_p50_ms:null,ready_queue_wait_p95_ms:null,failed_24h:1,unpublished_due:1,oldest_unpublished_seconds:5});
   expect(report.data.find(q=>q.queue_kind==='image')).toMatchObject({waiting:1,unpublished_due:0,dispatch_samples_24h:0,first_dispatch_wait_p95_ms:null});
   expect(report.data.find(q=>q.queue_kind==='audio')).toMatchObject({waiting:0,unknown:0,unsettled_terminal:1,first_dispatch_wait_p95_ms:null});
   const foreign=(await get(tokens.other.token)).json();expect(foreign.data.find((q:any)=>q.queue_kind==='text')).toMatchObject({waiting:1,unknown:0,running:0});
  }finally{await app.close()}
 });
 it('records ready-to-lease latency once per delivery, excluding scheduled provider waits and other applications',async()=>{
  const clock=new ManualClock(new Date('2026-01-05T12:00:00Z')),scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const token=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Queue latency']);
   return issueToken(tx,{...scope,scopes:['operations:admin'],account_ids:null,max_grant_units:null,expires_at:null});
  });
  const add=(s=scope)=>transaction(pool!,tx=>enqueue(tx,s,clock,{priority:10,backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'result',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(clock.now().getTime()+3600000)}));
  const first=await add(),second=await add(),foreign=await add({...scope,application_id:id('foreign-app')});
  const due=new Date(clock.now().getTime()+600000);
  await pool!.query('UPDATE execution_requests SET not_before=$2 WHERE id=ANY($1::text[])',[[first.id,second.id],due]);
  await pool!.query('UPDATE execution_dispatches SET due_at=$2 WHERE request_id=ANY($1::text[])',[[first.id,second.id],due]);
  const lease=(request:string)=>transaction(pool!,tx=>leaseNext(tx,clock,'metrics-worker',{backend:'bullmq',generation:0,scope},undefined,request,true));
  expect(await lease(first.id)).toBeNull();
  clock.advance(601000);expect((await lease(first.id))?.id).toBe(first.id);
  clock.advance(4000);expect((await lease(second.id))?.id).toBe(second.id);
  expect(await lease(first.id)).toBeNull();
  expect(new Date((await pool!.query('SELECT first_leased_at FROM execution_dispatches WHERE request_id=$1',[first.id])).rows[0].first_leased_at).getTime()).toBe(due.getTime()+1000);
  await pool!.query('UPDATE execution_dispatches SET first_leased_at=$2 WHERE request_id=$1',[foreign.id,clock.now()]);
  const app=createApi(pool!,clock);
  try{
   const response=await app.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${token.token}`}});
   expect(response.statusCode,response.body).toBe(200);
   const report=apiSchemas.ExecutionMetricsResponse.parse(response.json());
   expect(report.data.find(q=>q.queue_kind==='text')).toMatchObject({queue_wait_samples_24h:2,ready_queue_wait_p50_ms:3000,ready_queue_wait_p95_ms:4800,first_dispatch_wait_p50_ms:null});
   expect(report.data.find(q=>q.queue_kind==='image')).toMatchObject({queue_wait_samples_24h:0,ready_queue_wait_p50_ms:null,ready_queue_wait_p95_ms:null});
   clock.advance(86400001);
   const expired=apiSchemas.ExecutionMetricsResponse.parse((await app.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${token.token}`}})).json());
   expect(expired.data.find(q=>q.queue_kind==='text')).toMatchObject({queue_wait_samples_24h:0,ready_queue_wait_p50_ms:null,ready_queue_wait_p95_ms:null});
  }finally{await app.close()}
 });

 it('shows limiter slots held by unknown outcomes and counts requests starved by the limiter',async()=>{
  const clock=new ManualClock(new Date('2026-10-20T22:41:00Z')),scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},limiter=id('limiter');
  const route:ExecutionRoute={primary:{connection_id:id('conn'),model:'fake',endpoint_scope:id('endpoint'),max_cost_units:'10',limiter_key:limiter},period_budget_key:id('period'),request_risk_limit_units:'1000',incident_risk_limit_units:'1000'};
  const token=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Limiter metrics']);
   await configureBudget(tx,scope,'provider',route.primary.connection_id,'1000');await configureBudget(tx,scope,'period',route.period_budget_key,'1000');
   await configureLimiter(tx,scope,clock,{key:limiter,window_ms:1000,request_limit:100,token_limit:'0',concurrency_limit:2});
   await configureLimiter(tx,{...scope,organization_id:id('foreign-org')},clock,{key:limiter,window_ms:1000,request_limit:100,token_limit:'0',concurrency_limit:9});
   return issueToken(tx,{...scope,scopes:['operations:admin'],account_ids:null,max_grant_units:null,expires_at:null});
  });
  const settle=async()=>{};
  const add=(deadlineMs:number)=>transaction(pool!,tx=>enqueue(tx,scope,clock,{priority:10,capability:'text.generate',operation_id:id('op'),component:'result',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'10',deadline_at:new Date(clock.now().getTime()+deadlineMs)}));
  const unknown=async()=>{
   const request=await add(7200000),lease=await transaction(pool!,tx=>leaseNext(tx,clock,'w',{scope,account:10},settle,request.id));
   const attempt=await transaction(pool!,tx=>prepareDispatch(tx,scope,clock,lease.id,lease.fencing_token));
   await transaction(pool!,tx=>observeAttempt(tx,scope,clock,{request_id:request.id,attempt_id:attempt!.id,fence:lease.fencing_token,observation_key:'lost',outcome:'unknown'},settle));
  };
  await unknown();clock.advance(3600001);await transaction(pool!,tx=>closeUnresolved(tx,clock,settle,scope));
  await unknown();await unknown();
  const starved=await add(600000);
  expect(await transaction(pool!,async tx=>{const lease=await leaseNext(tx,clock,'w',{scope,account:10},settle,starved.id);return prepareDispatch(tx,scope,clock,lease.id,lease.fencing_token)})).toBeNull();
  clock.advance(600001);expect(await transaction(pool!,tx=>leaseNext(tx,clock,'w',{scope,account:10},settle,starved.id))).toBeNull();
  // Two unknown outcomes came from calls cut by the attempt timeout, one of them more than a day ago.
  const cut=(await pool!.query("SELECT a.id FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id WHERE r.organization_id=$1 AND a.status IN ('outcome_unknown','abandoned') ORDER BY a.created_at,a.id",[scope.organization_id])).rows.map(r=>r.id);
  await pool!.query("UPDATE execution_attempts SET timed_out_at=$2::timestamptz-interval '1 minute' WHERE id=$1",[cut[2],clock.now()]);
  await pool!.query("UPDATE execution_attempts SET timed_out_at=$2::timestamptz-interval '25 hours' WHERE id=$1",[cut[1],clock.now()]);
  const app=createApi(pool!,clock);
  try{
   const response=await app.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${token.token}`}});expect(response.statusCode,response.body).toBe(200);
   const report=apiSchemas.ExecutionMetricsResponse.parse(response.json());
   expect(report.limiters).toEqual([{limiter_key:limiter,concurrency_limit:2,held_slots:2,unknown_held_slots:2,oldest_unknown_held_seconds:600.001}]);
   expect(report.data.find(q=>q.queue_kind==='text')).toMatchObject({unknown:3,rate_limit_starved_24h:1,admission_timeout_24h:0,attempt_timeouts_24h:1});
  }finally{await app.close()}
 });

 it('counts durable HTTP observations and recovered execute deliveries without guessing from retry generations',async()=>{
  const clock=new ManualClock(new Date('2026-01-07T12:00:00Z')),scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const token=await transaction(pool!,async tx=>{await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'HTTP metrics']);return issueToken(tx,{...scope,scopes:['operations:admin'],account_ids:null,max_grant_units:null,expires_at:null})});
  const add=(s=scope)=>transaction(pool!,tx=>enqueue(tx,s,clock,{priority:10,backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'result',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(clock.now().getTime()+3600000)}));
  const request=await add(),foreign=await add({...scope,application_id:id('foreign')});
  const observe=async(requestId:string,status:number,offset:number)=>{
   const attempt=id('attempt'),at=new Date(clock.now().getTime()+offset);
   await pool!.query("INSERT INTO execution_attempts(id,request_id,number,fencing_token,variant,status,submission_intent_at,provider_idempotency_key,created_at) VALUES($1,$2,(SELECT COALESCE(max(number),0)+1 FROM execution_attempts WHERE request_id=$2),1,'{}','submitting',$3,$1,$3)",[attempt,requestId,at]);
   await pool!.query('INSERT INTO provider_http_observations(attempt_id,sent_at,received_at,status) VALUES($1,$2,$2,$3)',[attempt,at,status]);
   // Delivery retries of the same observation do not create another metric fact.
   await pool!.query('INSERT INTO provider_http_observations(attempt_id,sent_at,received_at,status) VALUES($1,$2,$2,$3) ON CONFLICT DO NOTHING',[attempt,at,status]);
  };
  await observe(request.id,429,-1000);await observe(request.id,200,-500);await observe(request.id,429,-86400001);await observe(request.id,429,1000);await observe(foreign.id,429,-1000);
  await pool!.query("INSERT INTO execution_dispatches(request_id,generation,queue_kind,due_at,recovered_at) VALUES($1,1,'text',$3,$3),($1,2,'text',$3,NULL),($1,3,'text',$3,$3::timestamptz-interval '25 hours'),($2,1,'text',$3,$3)",[request.id,foreign.id,clock.now()]);
  const app=createApi(pool!,clock);
  try{
   const response=await app.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${token.token}`}});expect(response.statusCode,response.body).toBe(200);
   const report=apiSchemas.ExecutionMetricsResponse.parse(response.json());
   expect(report.data.find(q=>q.queue_kind==='text')).toMatchObject({http_observations_24h:2,http_429_observations_24h:1,recovered_execute_deliveries_24h:1});
   expect(report.data.find(q=>q.queue_kind==='image')).toMatchObject({http_observations_24h:0,http_429_observations_24h:0,recovered_execute_deliveries_24h:0});
  }finally{await app.close()}
 });

 it('combines raw latency samples across fresh workers instead of averaging percentiles',async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},installation=id('metrics');
  const token=await transaction(pool!,async tx=>{await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Latency aggregation']);return issueToken(tx,{...scope,scopes:['operations:admin'],account_ids:null,max_grant_units:null,expires_at:null})});
  const telemetry=(samples:number[],db:number,redis:number|null)=>({admission_ms:samples,admission_denied:1,admission_errors:0,db:{state:'ok' as const,ms:db},redis:redis===null?{state:'failed' as const,ms:null}:{state:'ok' as const,ms:redis}});
  await writeWorkerHeartbeat(pool!,installation,'one','running',[{queue_kind:'text',concurrency:2,active_jobs:0,telemetry:telemetry([10,20],2,4)},{queue_kind:'image',concurrency:2,active_jobs:0,telemetry:telemetry([9999],9999,9999)}]);
  await writeWorkerHeartbeat(pool!,installation,'two','draining',[{queue_kind:'text',concurrency:2,active_jobs:0,telemetry:{...telemetry([30,40],8,null),admission_denied:0,admission_errors:1}}]);
  await writeWorkerHeartbeat(pool!,installation,'stopped','stopped',[{queue_kind:'text',concurrency:2,active_jobs:0,telemetry:telemetry([9999],9999,9999)}]);
  await writeWorkerHeartbeat(pool!,id('foreign-installation'),'foreign','running',[{queue_kind:'text',concurrency:2,active_jobs:0,telemetry:telemetry([9999],9999,9999)}]);
  await pool!.query("UPDATE execution_worker_heartbeats SET heartbeat_at=clock_timestamp()-interval '46 seconds' WHERE installation_id=$1 AND queue_kind='image'",[installation]);
  vi.stubEnv('UAI_INSTALLATION_ID',installation);const app=createApi(pool!);
  try{
   const response=await app.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${token.token}`}});expect(response.statusCode,response.body).toBe(200);
   const rows=apiSchemas.ExecutionMetricsResponse.parse(response.json()).workers!.data,text=rows.find(q=>q.queue_kind==='text')!;
   expect(text).toMatchObject({admission_samples:4,admission_p50_ms:25,admission_p95_ms:38.5,admission_denied:1,admission_errors:1,redis_probe_p95_ms:4,redis_probe_failures:1,db_probe_failures:0});expect(text.db_probe_p95_ms).toBeCloseTo(7.7);
   expect(rows.find(q=>q.queue_kind==='image')).toMatchObject({admission_samples:0,admission_p95_ms:null,db_probe_p95_ms:null,redis_probe_p95_ms:null});
  }finally{await app.close();vi.unstubAllEnvs()}
 });

});
