/** Opt-in, synthetic-only load runner. Retains the isolated database for inspection. */
import {writeFile} from 'node:fs/promises';
import {fork,type ChildProcess} from 'node:child_process';
import type {PoolClient} from 'pg';
import {cpus,totalmem,platform,arch} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {createPool,transaction} from '../packages/db/src/index.js';
import {id} from '../packages/contracts/src/index.js';
import {getWallet} from '../packages/accounting/src/index.js';
import {systemClock} from '../packages/contracts/src/index.js';
import {createApi} from '../apps/api/src/server.js';
import {defaultRuntime} from '../packages/execution/src/default-runtime.js';
import {executeRequest,schedulerTick} from '../packages/execution/src/runtime.js';
import {ExecutionTransport} from '../packages/queue/src/transport.js';
import {relayOne,reconcileDeliveries} from '../packages/queue/src/relay.js';
import {providerAdmission} from '../packages/queue/src/provider-admission.js';
import {injectMockFailure} from './load/inject.js';
import {seedLoadFixture} from './load/fixture.js';
import {LoadRedisMetrics} from './load/redis-metrics.js';

if(process.env.UAI_LOAD_TEST_ONLY!=='1'||!process.env.DATABASE_URL||!new URL(process.env.DATABASE_URL).pathname.startsWith('/uai_load_')||!process.env.REDIS_URL)throw new Error('dedicated_uai_load_database_and_opt_in_required');
function setting(key:string,fallback:number,min:number,max:number){const n=Number(process.env[key]??fallback);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`invalid_${key}`);return n}
const users=setting('LOAD_USERS',30,1,1000),duration=setting('LOAD_SECONDS',30,1,3600),rps=setting('LOAD_RPS',0.5,0.01,100),scale=setting('LOAD_DELAY_SCALE',1,0.001,10),drainSeconds=setting('LOAD_DRAIN_SECONDS',180,1,1800);
const workerProcesses=setting('LOAD_WORKERS',0,0,16),rateLimitEvery=setting('LOAD_429_EVERY',0,0,10000),unknownEvery=setting('LOAD_UNKNOWN_EVERY',0,0,10000);
const splitServices=process.env.LOAD_SPLIT_SERVICES==='1';
if(splitServices&&workerProcesses<1)throw new Error('split_services_require_child_workers');
if(!Number.isInteger(unknownEvery))throw new Error('integer_unknown_interval_required');
const activeQueueLimit=setting('LOAD_ACTIVE_QUEUE_LIMIT',8,1,1000),providerConcurrency=setting('LOAD_PROVIDER_CONCURRENCY',8,1,1000),minimumPeak=setting('LOAD_MIN_PEAK',0,0,1000);
if(!Number.isInteger(activeQueueLimit)||!Number.isInteger(providerConcurrency)||!Number.isInteger(minimumPeak))throw new Error('integer_capacity_required');
const expectsUnknown=(sequence:number)=>unknownEvery>0&&(sequence+1)%unknownEvery===0;
if(!Number.isInteger(rateLimitEvery))throw new Error('integer_rate_limit_interval_required');
if(!Number.isInteger(users)||!Number.isInteger(workerProcesses))throw new Error('integer_users_and_workers_required');
const installation=id('load'),output=process.env.LOAD_REPORT??`/tmp/${installation}.json`;
process.env.UAI_EXECUTION_BACKEND='bullmq';process.env.UAI_ALLOW_REAL_PROVIDERS='false';process.env.UAI_BLOB_BACKEND='local';process.env.UAI_BLOB_ROOT=`/tmp/${installation}-blobs`;
const apiPool=createPool(undefined,'api'),workerPool=createPool(undefined,'worker'),schedulerPool=createPool(undefined,'scheduler');
const transport=new ExecutionTransport(installation,process.env.REDIS_URL),quota=providerAdmission(workerPool,process.env.REDIS_URL,installation),app=createApi(apiPool);
const redisMetrics=new LoadRedisMetrics(process.env.REDIS_URL,installation);
const faults:string[]=[],arrivals:{sequence:number;scheduled_ms:number;started_ms:number;latency_ms:number;status:number;request_id?:string;operation_id?:string}[]=[],samples:unknown[]=[];
let stop=false,active=0,peak=0,submitted=0,arrivalTasks=new Set<Promise<void>>(),loop:Promise<void>|undefined;
let fixture:Awaited<ReturnType<typeof seedLoadFixture>>|undefined;
let databaseGuard:PoolClient|undefined;
const children:ChildProcess[]=[],childStats=new Map<number,{active:number;submitted:number;rss:number;db_clients:number}>();
const serviceStats=new Map<number,{role:string;rss:number;db_clients:number}>();
const processRoles=new Map<number,string>();
type ChildShutdown={pid:number|undefined;role:string|undefined;code:number|null;signal:NodeJS.Signals|null;forced:boolean};
let saveShutdown:((results:ChildShutdown[])=>Promise<void>)|undefined;
function startChild(role:'worker'|'api'|'scheduler'):Promise<{address?:string}>{return new Promise((resolve,reject)=>{
 const child=fork(new URL(role==='worker'?'./load/worker.ts':'./load/service.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,UAI_INSTALLATION_ID:installation,LOAD_SERVICE_ROLE:role},stdio:['ignore','ignore','pipe','ipc']});
 children.push(child);if(child.pid)processRoles.set(child.pid,role);
 let ready=false;
 const timer=setTimeout(()=>reject(new Error(`load_${role}_ready_timeout`)),15000);
 child.stderr?.on('data',()=>faults.push(`${role}_stderr:${child.pid}`));
 child.on('error',error=>{clearTimeout(timer);faults.push(error.message);reject(error)});
 child.on('exit',(code,signal)=>{clearTimeout(timer);if(!stop)faults.push(`${role}_exit:${child.pid}:${code}:${signal}`);if(!ready)reject(new Error(`load_${role}_start_failed`))});
 child.on('message',(message:any)=>{
  if(message.type==='ready'){ready=true;clearTimeout(timer);resolve(message)}
  if(message.type==='fault')faults.push(message.message);
  if(message.type==='stats'){
   if(role==='worker'){
    childStats.set(child.pid!,message);active=[...childStats.values()].reduce((n,s)=>n+s.active,0);submitted=[...childStats.values()].reduce((n,s)=>n+s.submitted,0);peak=Math.max(peak,active);
   }else serviceStats.set(child.pid!,message);
  }
 });
})}
const startedAt=new Date();
try{
 await redisMetrics.connect();
 databaseGuard=await apiPool.connect();
 const locked=(await databaseGuard.query('SELECT pg_try_advisory_lock(73286419) AS locked')).rows[0].locked;
 if(!locked)throw new Error('another_load_runner_uses_this_database');
 const pending=await databaseGuard.query("SELECT 1 FROM execution_requests WHERE settlement_status<>'settled' LIMIT 1");
 if(pending.rowCount)throw new Error('unfinished_previous_load_requires_fresh_database');
 fixture=await seedLoadFixture(apiPool,users,providerConcurrency);
 // Dedicated DB only. Default eight slots per capability; capacity profiles opt in explicitly.
 await apiPool.query("UPDATE execution_dispatch_policies SET active_queue_limit=$1,active_application_limit=$1,active_account_limit=2 WHERE queue_kind IN ('text','image')",[activeQueueLimit]);
 const deps=defaultRuntime(workerPool),adapter=deps.adapter;
 deps.onDelta=undefined;
 deps.adapter=async(...args)=>{
  const base=await adapter(...args),execute=base.execute.bind(base);
  base.execute=async(input,context)=>{
   submitted++;active++;peak=Math.max(peak,active);
   // Deterministic varied delays, no external calls. Native jobs are a separate profile.
   const text=input.capability==='text.generate',seconds=text?2+(submitted%9):30+(submitted%61);
   try{const injected=await injectMockFailure(workerPool,{rateLimitEvery,unknownEvery},input,context);if(injected)return injected;await delay(seconds*1000*scale,undefined,{signal:context.signal});return await execute(input,context)}finally{active--}
  };return base;
 };
 Object.assign(deps,{admit:quota.admit,onRateLimits:quota.onRateLimits,onProviderResult:quota.onProviderResult,renewAdmission:quota.renewAdmission,onNativePending:quota.onNativePending});
 if(workerProcesses)await Promise.all(Array.from({length:workerProcesses},()=>startChild('worker')));
 else for(const kind of ['text','image'] as const)transport.consume(kind,8,delivery=>executeRequest(workerPool,{...deps,limits:{backend:'bullmq',generation:delivery.generation}},delivery.request_id),error=>faults.push(error.message));
 let address:string;
 if(splitServices){const [api]=await Promise.all([startChild('api'),startChild('scheduler')]);if(!api.address)throw new Error('load_api_address_missing');address=api.address}
 else address=await app.listen({host:'127.0.0.1',port:0});
 const beginning=performance.now();let lastSample=0,lastMaintenance=0;
 loop=(async()=>{while(!stop){try{
  if(!splitServices){
   for(let n=0;n<50&&await relayOne(schedulerPool,transport);n++);
   if(performance.now()-lastMaintenance>=1000){await reconcileDeliveries(schedulerPool,transport);await schedulerTick(schedulerPool,{...defaultRuntime(schedulerPool),limits:{backend:'legacy'}});lastMaintenance=performance.now()}
  }
  if(performance.now()-lastSample>=1000){samples.push({elapsed_ms:performance.now()-beginning,active,rss:process.memoryUsage().rss,workers:Object.fromEntries(childStats),services:Object.fromEntries(serviceStats),db_clients:{api:apiPool.totalCount,worker:workerPool.totalCount,scheduler:schedulerPool.totalCount},redis_clients:await redisMetrics.sample(),backlog:(await schedulerPool.query("SELECT execution_status,count(*)::int AS count FROM execution_requests WHERE organization_id=$1 GROUP BY execution_status",[fixture!.scope.organization_id])).rows});lastSample=performance.now()}
 }catch(error){faults.push((error as Error).message)}await delay(100)}})();
 async function arrive(sequence:number,scheduled:number){
  const start=performance.now(),image=sequence%4===0,account=fixture!.accounts[sequence%users]!;
  try{
   const response=await fetch(`${address}/v1/invocations`,{method:'POST',headers:{authorization:`Bearer ${fixture!.token}`,'content-type':'application/json','idempotency-key':`load-${sequence}`},body:JSON.stringify({account_id:account.account_id,budget:{max_units:'24000000'},profile:image?'image.standard':'text.standard',input:{[image?'prompt':'text']:`Synthetic load ${sequence}`},parameters:image?{count:1,size:'1024x1024',quality:'standard'}:{max_output_tokens:100}}),signal:AbortSignal.timeout(30000)});
   const body=await response.json() as any;arrivals.push({sequence,scheduled_ms:scheduled,started_ms:start-beginning,latency_ms:performance.now()-start,status:response.status,...(response.ok?{request_id:body.request_id,operation_id:body.operation_id}:{})});
   if(response.status!==202&&!(response.status===429&&body.error?.code==='queue_backpressure'))faults.push(`api_${response.status}:${JSON.stringify(body).slice(0,500)}`);
  }catch(error){faults.push((error as Error).message);arrivals.push({sequence,scheduled_ms:scheduled,started_ms:start-beginning,latency_ms:performance.now()-start,status:0})}
 }
 // Open-loop arrivals: no response is awaited before scheduling the next request.
 for(let sequence=0;sequence<duration*rps;sequence++){
  const scheduled=sequence*1000/rps,wait=beginning+scheduled-performance.now();if(wait>0)await delay(wait);
  const task=arrive(sequence,scheduled);arrivalTasks.add(task);void task.finally(()=>arrivalTasks.delete(task));
 }
 await Promise.all(arrivalTasks);
 const expectedUnknownIds=arrivals.filter(a=>a.status===202&&expectsUnknown(a.sequence)).map(a=>a.request_id!);
 const drainEnd=performance.now()+drainSeconds*1000;
 let unexpectedUnfinished=0;
 do{
  unexpectedUnfinished=Number((await apiPool.query("SELECT count(*) FROM execution_requests WHERE organization_id=$1 AND settlement_status<>'settled' AND NOT (id=ANY($2::text[]) AND execution_status='outcome_unknown' AND settlement_status='unresolved')",[fixture.scope.organization_id,expectedUnknownIds])).rows[0].count);
  if(!unexpectedUnfinished)break;await delay(250);
 }while(performance.now()<drainEnd);
 // Keep scheduler and workers alive to catch accidental resubmission of an unknown outcome.
 if(expectedUnknownIds.length&&!unexpectedUnfinished)await delay(10000);
 stop=true;await loop;
 const accepted=arrivals.filter(a=>a.status===202),latencies=arrivals.map(a=>a.latency_ms).sort((a,b)=>a-b),percentile=(p:number)=>latencies[Math.min(latencies.length-1,Math.floor(latencies.length*p))]??0;
 const requests=(await apiPool.query(`SELECT r.id,r.operation_id,r.execution_status,r.settlement_status,r.attempt_count,
   extract(epoch FROM (r.first_dispatched_at-r.enqueued_at))*1000 AS queue_wait_ms,
   extract(epoch FROM (r.financial_closed_at-r.created_at))*1000 AS total_ms,
   (SELECT COALESCE(sum(a.charged_units),0)::text FROM execution_attempts a WHERE a.request_id=r.id) AS charged_units,
   v.captured_units::text AS captured_units,
   (v.max_units-v.captured_units-v.released_units)::text AS held_units,
   (SELECT count(*)::int FROM execution_attempts a WHERE a.request_id=r.id AND a.cost_units IS NULL) AS unknown_cost_attempts
   FROM execution_requests r JOIN reservations v ON v.operation_id=r.operation_id
   WHERE r.organization_id=$1`,[fixture.scope.organization_id])).rows;
 const expectedAttempts=new Map(accepted.map(a=>[a.request_id,!expectsUnknown(a.sequence)&&rateLimitEvery&&(a.sequence+1)%rateLimitEvery===0?2:1]));
 const retries=(await apiPool.query(`SELECT a.request_id,a.cost_units,a.charged_units,
   extract(epoch FROM (b.submission_intent_at-max(o.received_at)))*1000 AS retry_gap_ms
   FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id
   JOIN quota_observations o ON o.attempt_id=a.id
   JOIN execution_attempts b ON b.request_id=a.request_id AND b.number=a.number+1
   WHERE r.organization_id=$1 GROUP BY a.id,b.submission_intent_at`,[fixture.scope.organization_id])).rows;
 const expectedRetries=[...expectedAttempts.values()].filter(n=>n===2).length;
 const retriesMatch=retries.length===expectedRetries&&retries.every(r=>Number(r.retry_gap_ms)>=1000&&r.cost_units==='0'&&r.charged_units==='0');
 const attemptsMatch=requests.every(r=>r.attempt_count===expectedAttempts.get(r.id));
 const totalAttempts=requests.reduce((n,r)=>n+Number(r.attempt_count),0);
 const acceptedIds=new Set(accepted.map(a=>a.request_id));
 const identityMatches=acceptedIds.size===accepted.length&&requests.every(r=>acceptedIds.has(r.id));
 const outcomesMatch=requests.every(r=>expectedUnknownIds.includes(r.id)
  ?r.execution_status==='outcome_unknown'&&r.settlement_status==='unresolved'&&r.charged_units==='0'&&BigInt(r.held_units)>0n&&r.unknown_cost_attempts===1
  :r.execution_status==='succeeded'&&r.settlement_status==='settled'&&r.held_units==='0');
 const financialMatches=requests.every(r=>r.charged_units===r.captured_units);
 const waits=requests.map(r=>Number(r.queue_wait_ms)).sort((a,b)=>a-b);
 const waitP95=waits[Math.min(waits.length-1,Math.floor(waits.length*.95))]??0;
 let captured=0n,spent=0n;
 for(const scope of fixture.accounts){const wallet=await transaction(apiPool,tx=>getWallet(tx,scope,systemClock));spent+=100000000000n-BigInt(wallet.available_units)-BigInt(wallet.reserved_units)}
 captured=BigInt((await apiPool.query('SELECT COALESCE(sum(captured_units),0) AS total FROM reservations r JOIN wallets w ON w.id=r.wallet_id WHERE w.organization_id=$1',[fixture.scope.organization_id])).rows[0].total);
 const maintenance=splitServices?(await apiPool.query('SELECT generation,completed_at FROM execution_maintenance_cycles WHERE installation_id=$1',[installation])).rows[0]:null;
 const servicesMatch=!splitServices||(serviceStats.size===2&&[...serviceStats.values()].some(s=>s.role==='api')&&[...serviceStats.values()].some(s=>s.role==='scheduler')&&Number(maintenance?.generation)>0&&!!maintenance?.completed_at);
 const report={installation,scope:fixture.scope,started_at:startedAt.toISOString(),finished_at:new Date().toISOString(),profile:{users,duration,rps,scale,drainSeconds,workerProcesses,splitServices,rateLimitEvery,unknownEvery,activeQueueLimit,providerConcurrency,minimumPeak},environment:{platform:platform(),arch:arch(),cpus:cpus().length,memory_bytes:totalmem(),node:process.version,processes:{[process.pid]:'load-generator',...Object.fromEntries(processRoles)},topology:splitServices?'independent API, scheduler and worker processes; loopback HTTP/PostgreSQL/Redis':workerProcesses?'parent API/scheduler plus child workers, loopback HTTP/PostgreSQL/Redis':'single process, separate pools, loopback HTTP/PostgreSQL/Redis'},summary:{arrivals:arrivals.length,accepted:accepted.length,requests:requests.length,unexpected_unfinished:unexpectedUnfinished,unsettled:requests.filter(r=>r.settlement_status!=='settled').length,expected_unknown:expectedUnknownIds.length,outcomes_match:outcomesMatch,total_attempts:totalAttempts,attempts_match:attemptsMatch,retries_match:retriesMatch,peak_provider_calls:peak,submitted,api_p50_ms:percentile(.5),api_p95_ms:percentile(.95),queue_wait_p95_ms:waitP95,identity_matches:identityMatches,per_request_financial_matches:financialMatches,captured_units:String(captured),wallet_spent_units:String(spent)},faults,arrivals,requests,retries,samples};
 saveShutdown=async shutdown=>{await writeFile(output,JSON.stringify({...report,maintenance,services_match:servicesMatch,shutdown},null,2))};
 await writeFile(output,JSON.stringify({...report,maintenance,services_match:servicesMatch},null,2));console.log(JSON.stringify({report:output,...report.summary}));
 if(!servicesMatch||peak<minimumPeak||!accepted.length||unexpectedUnfinished||faults.length||accepted.length!==requests.length||!identityMatches||!financialMatches||!retriesMatch||submitted!==totalAttempts||!attemptsMatch||captured!==spent||!outcomesMatch)throw new Error('load_acceptance_failed');
}finally{
 stop=true;await Promise.allSettled(arrivalTasks);await loop?.catch(()=>{});
 const shutdown=await Promise.all(children.map(child=>new Promise<ChildShutdown>(resolve=>{
  let forced=false;
  const result=()=>({pid:child.pid,role:processRoles.get(child.pid!),code:child.exitCode,signal:child.signalCode,forced});
  if(child.exitCode!==null||child.signalCode!==null){resolve(result());return}
  const timer=setTimeout(()=>{forced=true;child.kill('SIGKILL')},30000);
  child.once('exit',()=>{clearTimeout(timer);resolve(result())});
  child.kill('SIGTERM');
 })));
 await transport.close();await quota.close();await app.close();
 redisMetrics.close();
 databaseGuard?.release(true);
 await Promise.all([apiPool.end(),workerPool.end(),schedulerPool.end()]);
 await saveShutdown?.(shutdown);
 if(shutdown.some(result=>result.forced||result.code!==0))throw new Error('load_child_shutdown_failed');
}
