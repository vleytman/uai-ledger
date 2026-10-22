import {backgroundCapacity} from './priority.js';
import {resolveExecutionPolicy,nextAttemptAt,type ExecutionPolicy} from '../../contracts/invocation.js';
import {executionLimits} from './policy.js';
import {prepareAttemptAllowance,type AllowanceAuthorization} from '../../allowance/src/execution.js';
import {lockExecutionAccount,tryLockExecutionAccount,lockLegacyCapacity,forAvailableExecutionAccounts} from '../../db/src/execution-lock.js';
import {assertQuotaProof} from './quota-proof.js';
import { DomainError, hash, id, units, type Clock, type Scope } from '../../contracts/src/index.js';
import { emit, type Tx, type SqlExecutor } from '../../db/src/index.js';
export interface RouteVariant { service_mode?:'standard';  overdraft_allowed?:boolean; text_features?:import('../../catalog/src/index.js').ModelDefinition['text_features']; cache_identity?:import('../../quoting/src/cache.js').CacheIdentity; cache_forecast?:Awaited<ReturnType<typeof import('../../quoting/src/cache.js').cacheForecast>>; rate_card_version_id?:string; usage_pricing?:{safety_factor:string;markup_percent:string;rounding_units:string}; execution_parameters?:Record<string,unknown>; maximum_items?:import('../../providers/src/contracts.js').BillableItem[]; allowance?:AllowanceAuthorization; adapter_ref?:string; connection_id: string; model: string; endpoint_scope: string; max_cost_units: string; eligible?: boolean; limiter_key?: string; limit_tokens?: string }
export interface ExecutionRoute {priority?:number;delivery?:{stream?:boolean;field_paths?:string[]};execution_policy_version_id?:string|null;execution?:ExecutionPolicy;billing?:{refused:'platform'|'actual_usage'}; initial_allowance_reservation_id?:string; customer_price_units?:string; primary: RouteVariant; fallback?: RouteVariant; period_budget_key: string; request_risk_limit_units: string; incident_risk_limit_units: string }
export function selectedVariant(request:{route:ExecutionRoute;slot:number}):RouteVariant{
 const {route}=request;
 return request.slot>=2&&route.fallback?route.fallback:route.primary;
}
export interface EnqueueInput { capability?:string; backend?:'legacy'|'bullmq'; id?:string; operation_id:string; component:string; client_request_key:string; input_hash:string; input_ref:string; route:ExecutionRoute; max_units:string; deadline_at:Date; initial_queue_budget_ms?:number; content_ttl_seconds?:number; external_project_id?:string; project_generation?:string; priority?:number }
export type Settlement = (tx:Tx, scope:Scope, input:{request_id:string; charged_units:string; reason:string; idempotency_key:string})=>Promise<unknown>;
const scopeValues=(s:Scope)=>[s.organization_id,s.application_id,s.account_id];
const scoped='organization_id=$1 AND application_id=$2 AND account_id=$3';
const nowPlus=(clock:Clock,ms:number)=>new Date(clock.now().getTime()+ms);
const scopeOf=(row:any):Scope=>({organization_id:row.organization_id,application_id:row.application_id,account_id:row.account_id});
const terminal=(s:string)=>['succeeded','failed','canceled','refused'].includes(s);
/** A synchronous call is aborted at the deadline; this covers work the provider may still finish after it. */
export const UNKNOWN_SLOT_GRACE_MS=300000;
/** Remote jobs are polled until the deadline plus this window. */
export const REMOTE_OBSERVATION_WINDOW_MS=3600000;
/** An unknown outcome keeps its protective limiter slot only while a result can still land. */
export const unknownSlotHeld=(attempt:string,request:string,now:string)=>`(${attempt}.status='outcome_unknown' AND ${request}.financial_closed_at IS NULL AND ${request}.deadline_at+CASE WHEN ${attempt}.remote_job_id IS NULL THEN ${UNKNOWN_SLOT_GRACE_MS} ELSE ${REMOTE_OBSERVATION_WINDOW_MS} END*interval '1 millisecond'>${now})`;
// Closing a request that never reached the provider: name what kept it waiting, not a slow model.
function unsentDeadlineReason(r:any){
 if(Number(r.attempt_count)>0||['paused','waiting_recovery'].includes(r.execution_status))return 'deadline_exceeded';
 return r.reason==='waiting_rate_limit'?'rate_limit_starved':'admission_timeout';
}
async function endpointLock(tx:Tx,r:any){await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8195))',[JSON.stringify([r.organization_id,r.route.primary.endpoint_scope])]);}
export async function getRequest(tx:SqlExecutor,scope:Scope,requestId:string){ const q=await tx.query(`SELECT * FROM execution_requests WHERE ${scoped} AND id=$4`,[...scopeValues(scope),requestId]); if(!q.rows[0])throw new DomainError('not_found','Request not found',404);return q.rows[0]; }
export async function getOperationRequests(tx:SqlExecutor,scope:Scope,operationId:string){return (await tx.query(`SELECT * FROM execution_requests WHERE ${scoped} AND operation_id=$4 ORDER BY created_at,id`,[...scopeValues(scope),operationId])).rows;}
async function lockedRequest(tx:Tx,scope:Scope,requestId:string){const q=await tx.query(`SELECT * FROM execution_requests WHERE ${scoped} AND id=$4 FOR UPDATE`,[...scopeValues(scope),requestId]);if(!q.rows[0])throw new DomainError('not_found','Request not found',404);return q.rows[0];}
export async function configureBudget(tx:Tx,scope:Scope,kind:'provider'|'period'|'request'|'incident',key:string,limit:string){ units(limit);await tx.query(`INSERT INTO execution_budgets(organization_id,kind,budget_key,limit_units) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,kind,budget_key) DO UPDATE SET limit_units=EXCLUDED.limit_units`,[scope.organization_id,kind,key,limit]);}
export async function configureLimiter(tx:Tx,scope:Scope,clock:Clock,input:{key:string;window_ms:number;request_limit:number;token_limit:string;concurrency_limit:number;interactive_reserve?:number}){
 units(input.token_limit);const reserve=input.interactive_reserve;if(reserve!==undefined&&(!Number.isSafeInteger(reserve)||reserve<0||reserve>100000))throw new DomainError('invalid_input');
 await tx.query(`INSERT INTO execution_limiters(organization_id,limiter_key,window_started_at,window_ms,request_limit,token_limit,concurrency_limit,interactive_reserve) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,1)) ON CONFLICT(organization_id,limiter_key) DO UPDATE SET window_ms=EXCLUDED.window_ms,request_limit=EXCLUDED.request_limit,token_limit=EXCLUDED.token_limit,concurrency_limit=EXCLUDED.concurrency_limit,interactive_reserve=COALESCE($8,execution_limiters.interactive_reserve)`,[scope.organization_id,input.key,clock.now(),input.window_ms,input.request_limit,input.token_limit,input.concurrency_limit,reserve??null]);
}
export async function enqueue(tx:Tx,scope:Scope,clock:Clock,input:EnqueueInput){
 input={...input,route:{...input.route,execution:resolveExecutionPolicy(input.route.execution,undefined,await executionLimits(tx))}};
 units(input.max_units); for(const v of [input.route.primary,input.route.fallback].filter(Boolean) as RouteVariant[])units(v.max_cost_units);
 if(input.deadline_at<=clock.now() || (!!input.external_project_id!==!!input.project_generation))throw new DomainError('invalid_input','Invalid deadline or project binding',422);
 const prior=await tx.query(`SELECT * FROM execution_requests WHERE ${scoped} AND operation_id=$4 AND client_request_key=$5`,[...scopeValues(scope),input.operation_id,input.client_request_key]);
 if(prior.rows[0]){if(prior.rows[0].input_hash!==input.input_hash)throw new DomainError('idempotency_conflict');return prior.rows[0];}
 // Scope advisory lock also used by storage deletion: a deletion cannot race admission.
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scopeValues(scope).join(':')]);
 const deleted=await tx.query(`SELECT id FROM storage_tombstones WHERE ${scoped} AND (operation_id=$4 OR (external_project_id=$5 AND project_generation=$6))`,[...scopeValues(scope),input.operation_id,input.external_project_id??null,input.project_generation??null]);
 if(deleted.rows.length)throw new DomainError('content_deleted');
 const requestId=input.id??id('req');
 const backend=input.backend??process.env.UAI_EXECUTION_BACKEND??'legacy';if(!['legacy','bullmq'].includes(backend))throw new DomainError('invalid_execution_backend');
 const capability=input.capability??'';const queueKind=capability.startsWith('text.')?'text':capability.startsWith('image.')?'image':capability.startsWith('speech.')?'audio':'tools';
 const result=await tx.query(`INSERT INTO execution_requests(id,organization_id,application_id,account_id,operation_id,component,client_request_key,input_hash,input_ref,route,max_units,deadline_at,enqueued_at,not_before,created_at,initial_queue_budget_ms,content_ttl_seconds,external_project_id,project_generation,priority,execution_backend,queue_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,[requestId,...scopeValues(scope),input.operation_id,input.component,input.client_request_key,input.input_hash,input.input_ref,input.route,input.max_units,input.deadline_at,clock.now(),input.initial_queue_budget_ms??900000,input.content_ttl_seconds??3600,input.external_project_id??null,input.project_generation??null,input.priority??0,backend,queueKind]);
 if(backend==='bullmq')await tx.query('INSERT INTO execution_dispatches(request_id,generation,queue_kind,due_at) VALUES($1,0,$2,$3)',[requestId,queueKind,clock.now()]);
 await configureBudget(tx,scope,'request',requestId,input.route.request_risk_limit_units);
 await emit(tx,scope,'request.queued',{type:'request',id:requestId});return result.rows[0];
}
export interface LeaseLimits { interactive_reserve?:number; global?:number; application?:number; account?:number; lease_ms?:number; scope?:Scope; backend?:'legacy'|'bullmq'; generation?:number }
/** Caller locks the request and is invalidating execution permission in this transaction. */
export async function releaseUnusedAdmissions(tx:Tx,r:any,clock:Clock){
 // Earlier unused fences are safe too. Any fence with a submission intent keeps
 // its hold, even when a later attempt is currently leased or being canceled.
 await tx.query(`UPDATE dispatch_admissions d SET slot_released_at=$3,slot_heartbeat_until=NULL,unused_at=COALESCE(unused_at,$3)
  WHERE d.request_id=$1 AND d.fencing_token<=$2 AND d.state IN ('intent','admitted')
   AND d.slot_released_at IS NULL AND d.slot_unknown_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM execution_attempts a WHERE a.request_id=d.request_id AND a.fencing_token=d.fencing_token)`,[r.id,r.fencing_token,clock.now()]);
}
async function closeUnsent(tx:Tx,r:any,clock:Clock,reason:string,settle?:Settlement){await releaseUnusedAdmissions(tx,r,clock);await tx.query(`UPDATE execution_requests SET execution_status='canceled',reason=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.id,reason]);if(r.incident_id)await tx.query(`UPDATE execution_incidents SET owner_request_id=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND owner_request_id=$2`,[r.incident_id,r.id]);if(settle){await settle(tx,scopeOf(r),{request_id:r.id,charged_units:'0',reason,idempotency_key:`execution:${r.id}:settled`});await tx.query(`UPDATE execution_requests SET settlement_status='settled',financial_closed_at=$2 WHERE id=$1`,[r.id,clock.now()]);}await emit(tx,scopeOf(r),'request.canceled',{type:'request',id:r.id},{reason});}
export async function leaseNext(tx:Tx,clock:Clock,worker:string,limits:LeaseLimits={},settle?:Settlement,requestId?:string,deferClosure=false){
 const deferred=deferClosure&&!!requestId&&limits.backend==='bullmq';
 if(deferred){
  const target=(await tx.query('SELECT organization_id,application_id,account_id FROM execution_requests WHERE id=$1',[requestId])).rows[0];
  if(!target)return null;
  await lockExecutionAccount(tx,scopeOf(target),'shared');
 }else if((limits.backend??'legacy')==='legacy')await lockLegacyCapacity(tx);
 let queue:string|null=null,reserve=limits.interactive_reserve??1;if(!Number.isSafeInteger(reserve)||reserve<0||reserve>100000)throw new DomainError('invalid_input','Invalid interactive reserve',422);
 if(requestId&&limits.backend==='bullmq'){
  const target=(await tx.query("SELECT queue_kind FROM execution_requests WHERE id=$1 AND execution_backend='bullmq'",[requestId])).rows[0];
  if(!target)return null;queue=target.queue_kind;
  const policy=(await tx.query('SELECT * FROM execution_dispatch_policies WHERE queue_kind=$1 FOR UPDATE',[queue])).rows[0];
  if(!policy)throw new DomainError('execution_capacity_missing');reserve=policy.interactive_reserve;
  limits={...limits,global:Math.min(limits.global??Infinity,policy.active_queue_limit),application:Math.min(limits.application??Infinity,policy.active_application_limit),account:Math.min(limits.account??Infinity,policy.active_account_limit)};
 }
 const counts=(await tx.query(`SELECT organization_id,application_id,account_id,count(*)::int AS count,count(*) FILTER(WHERE priority=0)::int AS background FROM execution_requests WHERE execution_backend=$6 AND execution_status IN ('leased','submitting','running') AND lease_expires_at>$1 AND ($2::text IS NULL OR (organization_id=$2 AND application_id=$3 AND account_id=$4)) AND ($5::text IS NULL OR (execution_backend='bullmq' AND queue_kind=$5 AND NOT EXISTS(SELECT 1 FROM execution_attempts observer WHERE observer.request_id=execution_requests.id AND observer.number=execution_requests.attempt_count AND observer.observation_fence=execution_requests.fencing_token))) GROUP BY organization_id,application_id,account_id`,[clock.now(),limits.scope?.organization_id??null,limits.scope?.application_id??null,limits.scope?.account_id??null,queue,limits.backend??'legacy'])).rows;
 if(counts.reduce((n,r)=>n+r.count,0)>=(limits.global??16))return null;
 const candidates=await tx.query(`SELECT r.* FROM execution_requests r LEFT JOIN execution_fairness f USING(organization_id,application_id,account_id) WHERE r.execution_backend=$8 AND ($10::text IS NULL OR r.queue_kind=$10) AND ($9::integer IS NULL OR r.dispatch_generation=$9) AND ($7::text IS NULL OR r.id=$7) AND r.execution_status IN ('queued','waiting_retry','waiting_recovery') AND r.not_before<=$1 AND NOT EXISTS(SELECT 1 FROM execution_incidents i WHERE i.organization_id=r.organization_id AND i.failure_scope=r.route->'primary'->>'endpoint_scope' AND i.status<>'recovered' AND i.owner_request_id IS NOT NULL AND i.owner_request_id<>r.id) AND ($2::text IS NULL OR (r.organization_id=$2 AND r.application_id=$3 AND r.account_id=$4)) AND (SELECT count(*) FROM execution_requests active WHERE active.execution_backend=r.execution_backend AND active.organization_id=r.organization_id AND active.application_id=r.application_id AND active.execution_status IN ('leased','submitting','running') AND active.lease_expires_at>$1 AND ($10::text IS NULL OR (active.execution_backend='bullmq' AND active.queue_kind=$10 AND NOT EXISTS(SELECT 1 FROM execution_attempts observer WHERE observer.request_id=active.id AND observer.number=active.attempt_count AND observer.observation_fence=active.fencing_token))))<$5 AND (SELECT count(*) FROM execution_requests active WHERE active.execution_backend=r.execution_backend AND active.organization_id=r.organization_id AND active.application_id=r.application_id AND active.account_id=r.account_id AND active.execution_status IN ('leased','submitting','running') AND active.lease_expires_at>$1 AND ($10::text IS NULL OR (active.execution_backend='bullmq' AND active.queue_kind=$10 AND NOT EXISTS(SELECT 1 FROM execution_attempts observer WHERE observer.request_id=active.id AND observer.number=active.attempt_count AND observer.observation_fence=active.fencing_token))))<$6 ORDER BY COALESCE(f.last_served_at,r.enqueued_at) ASC,(r.priority+EXTRACT(EPOCH FROM ($1-r.enqueued_at))/60) DESC,r.enqueued_at,r.id LIMIT 100 FOR UPDATE OF r SKIP LOCKED`,[clock.now(),limits.scope?.organization_id??null,limits.scope?.application_id??null,limits.scope?.account_id??null,limits.application??8,limits.account??2,requestId??null,limits.backend??'legacy',limits.generation??null,queue]);
 for(const r of candidates.rows){
  if(!deferred&&!await tryLockExecutionAccount(tx,scopeOf(r)))continue;
  const waited=clock.now().getTime()-new Date(r.enqueued_at).getTime()-Number(r.recovery_wait_ms)-(r.recovery_wait_started_at?clock.now().getTime()-new Date(r.recovery_wait_started_at).getTime():0);
  if(new Date(r.deadline_at)<=clock.now() || (!r.first_dispatched_at&&waited>=r.initial_queue_budget_ms)){if(deferred)throw new DomainError('execution_closure_required');await closeUnsent(tx,r,clock,unsentDeadlineReason(r),settle);continue;}
  const appCount=counts.filter(c=>c.application_id===r.application_id&&c.organization_id===r.organization_id).reduce((n,c)=>n+c.count,0);
  const accountCount=counts.filter(c=>c.account_id===r.account_id&&c.application_id===r.application_id&&c.organization_id===r.organization_id).reduce((n,c)=>n+c.count,0);
  if(appCount>=(limits.application??8)||accountCount>=(limits.account??2))continue;
  if(r.priority===0){const background=counts.reduce((n,c)=>n+c.background,0),appBackground=counts.filter(c=>c.application_id===r.application_id&&c.organization_id===r.organization_id).reduce((n,c)=>n+c.background,0);const accountBackground=counts.filter(c=>c.account_id===r.account_id&&c.application_id===r.application_id&&c.organization_id===r.organization_id).reduce((n,c)=>n+c.background,0);if(accountBackground>=backgroundCapacity(limits.account??2,reserve)||background>=backgroundCapacity(limits.global??16,reserve)||appBackground>=backgroundCapacity(limits.application??8,reserve))continue;}
  const route=r.route as ExecutionRoute;
  const incident=(await tx.query(`SELECT * FROM execution_incidents WHERE organization_id=$1 AND failure_scope=$2 FOR UPDATE`,[r.organization_id,route.primary.endpoint_scope])).rows[0];
  if(incident?.status==='recovered'&&incident.recovered_at&&clock.now().getTime()-new Date(incident.recovered_at).getTime()<60000){
   const active=(await tx.query(`SELECT count(*)::int n FROM execution_requests WHERE organization_id=$1 AND route->'primary'->>'endpoint_scope'=$2 AND execution_status IN ('leased','submitting','running') AND lease_expires_at>$3`,[r.organization_id,route.primary.endpoint_scope,clock.now()])).rows[0].n;
   if(active>=1)continue;
  }
  if(incident?.status==='recovered'&&r.incident_id){r.incident_id=null;r.slot=0;}
  if(incident&&incident.status!=='recovered'){
   if(incident.status==='locked'){if(deferred)throw new DomainError('execution_closure_required');await closeUnsent(tx,r,clock,'provider_recovery_exhausted',settle);continue;}
   if(new Date(incident.next_retry_at)>clock.now() || (incident.owner_request_id&&incident.owner_request_id!==r.id)){
    await tx.query(`UPDATE execution_requests SET execution_status='waiting_recovery',incident_id=$2,recovery_wait_started_at=COALESCE(recovery_wait_started_at,$3),not_before=$4 WHERE id=$1`,[r.id,incident.id,clock.now(),incident.next_retry_at]);continue;
   }
   await tx.query(`UPDATE execution_incidents SET status='probing',owner_request_id=$2,lease_owner=$3,lease_expires_at=$4,fencing_token=fencing_token+1 WHERE id=$1`,[incident.id,r.id,worker,nowPlus(clock,limits.lease_ms??30000)]);
   r.incident_id=incident.id;r.cycle=incident.cycle;r.slot=Math.max(r.slot,incident.dispatch_count);
  }
  const next=await tx.query(`UPDATE execution_requests SET execution_status='leased',quota_wait=NULL,lease_owner=$2,lease_expires_at=$3,fencing_token=fencing_token+1,incident_id=$4,cycle=$5,slot=$7,recovery_wait_ms=recovery_wait_ms+CASE WHEN recovery_wait_started_at IS NULL THEN 0 ELSE GREATEST(0,EXTRACT(EPOCH FROM ($6-recovery_wait_started_at))*1000)::bigint END,recovery_wait_started_at=NULL WHERE id=$1 RETURNING *`,[r.id,worker,nowPlus(clock,limits.lease_ms??30000),r.incident_id,r.cycle,clock.now(),r.slot]);
  if(r.execution_backend==='bullmq')await tx.query('UPDATE execution_dispatches SET first_leased_at=COALESCE(first_leased_at,$3) WHERE request_id=$1 AND generation=$2',[r.id,r.dispatch_generation,clock.now()]);
  await tx.query(`INSERT INTO execution_fairness VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,application_id,account_id) DO UPDATE SET last_served_at=$4`,[r.organization_id,r.application_id,r.account_id,clock.now()]);return next.rows[0];
 }return null;
}
/** A separate transaction must recheck closure; never upgrade a shared lease barrier. */
export async function closeUnsentIfRequired(tx:Tx,clock:Clock,requestId:string,limits:LeaseLimits,settle:Settlement){
 const target=(await tx.query('SELECT organization_id,application_id,account_id FROM execution_requests WHERE id=$1',[requestId])).rows[0];
 if(!target)return false;
 await lockExecutionAccount(tx,scopeOf(target));
 const r=(await tx.query('SELECT * FROM execution_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
 if(!r||r.execution_backend!=='bullmq'||!['queued','waiting_retry','waiting_recovery'].includes(r.execution_status))return false;
 if(limits.generation!==undefined&&r.dispatch_generation!==limits.generation)return false;
 if(limits.scope&&scopeValues(limits.scope).some((value,index)=>value!==scopeValues(scopeOf(r))[index]))return false;
 const waited=clock.now().getTime()-new Date(r.enqueued_at).getTime()-Number(r.recovery_wait_ms)-(r.recovery_wait_started_at?clock.now().getTime()-new Date(r.recovery_wait_started_at).getTime():0);
 let reason=new Date(r.deadline_at)<=clock.now()||(!r.first_dispatched_at&&waited>=r.initial_queue_budget_ms)?unsentDeadlineReason(r):null;
 if(!reason){const incident=(await tx.query("SELECT status FROM execution_incidents WHERE organization_id=$1 AND failure_scope=$2 FOR UPDATE",[r.organization_id,r.route.primary.endpoint_scope])).rows[0];if(incident?.status==='locked')reason='provider_recovery_exhausted';}
 if(!reason)return false;
 await closeUnsent(tx,r,clock,reason,settle);return true;
}

function assertFence(r:any,fence:string|number,clock:Clock){if(String(r.fencing_token)!==String(fence)||!r.lease_expires_at||new Date(r.lease_expires_at)<=clock.now())throw new DomainError('stale_lease');}
export async function renewLease(tx:Tx,scope:Scope,clock:Clock,requestId:string,fence:string|number,leaseMs=30000){const r=await lockedRequest(tx,scope,requestId);assertFence(r,fence,clock);await tx.query('UPDATE execution_requests SET lease_expires_at=$2 WHERE id=$1',[requestId,nowPlus(clock,leaseMs)]);if(r.incident_id)await tx.query('UPDATE execution_incidents SET lease_expires_at=$2 WHERE id=$1 AND owner_request_id=$3',[r.incident_id,nowPlus(clock,leaseMs),r.id]);}
async function claimExposure(tx:Tx,r:any,attemptId:string,v:RouteVariant){
 const route=r.route as ExecutionRoute;const keys:[string,string][]=[['provider',v.connection_id],['request',r.id],['period',route.period_budget_key]];if(r.incident_id)keys.push(['incident',r.incident_id]);
 for(const [kind,key] of keys.sort((a,b)=>a.join(':').localeCompare(b.join(':')))){
  const b=(await tx.query('SELECT * FROM execution_budgets WHERE organization_id=$1 AND kind=$2 AND budget_key=$3 FOR UPDATE',[r.organization_id,kind,key])).rows[0];
  if(!b||BigInt(b.reserved_units)+BigInt(b.spent_units)+units(v.max_cost_units)>BigInt(b.limit_units))throw new DomainError(kind==='provider'?'provider_budget_exhausted':'platform_risk_budget_exhausted');
  await tx.query('UPDATE execution_budgets SET reserved_units=reserved_units+$4 WHERE organization_id=$1 AND kind=$2 AND budget_key=$3',[r.organization_id,kind,key,v.max_cost_units]);
  await tx.query('INSERT INTO execution_exposures(attempt_id,organization_id,kind,budget_key,reserved_units) VALUES($1,$2,$3,$4,$5)',[attemptId,r.organization_id,kind,key,v.max_cost_units]);
 }
}
async function permitLimit(tx:Tx,r:any,v:RouteVariant,clock:Clock){
 if(!v.limiter_key)return true;
 const l=(await tx.query('SELECT * FROM execution_limiters WHERE organization_id=$1 AND limiter_key=$2 FOR UPDATE',[r.organization_id,v.limiter_key])).rows[0];if(!l)throw new DomainError('limiter_not_configured');
 let end=new Date(new Date(l.window_started_at).getTime()+l.window_ms);if(end<=clock.now()){l.requests_used=0;l.tokens_used='0';end=nowPlus(clock,l.window_ms);await tx.query('UPDATE execution_limiters SET window_started_at=$3,requests_used=0,tokens_used=0 WHERE organization_id=$1 AND limiter_key=$2',[r.organization_id,v.limiter_key,clock.now()]);}
 const active=(await tx.query(`SELECT count(*)::int AS count,count(*) FILTER(WHERE q.priority=0)::int AS background FROM execution_attempts a JOIN execution_requests q ON q.id=a.request_id WHERE q.organization_id=$1 AND a.variant->>'limiter_key'=$2 AND (a.status IN ('submitting','running') OR ${unknownSlotHeld('a','q','$3')})`,[r.organization_id,v.limiter_key,clock.now()])).rows[0];
 if((l.blocked_until&&new Date(l.blocked_until)>clock.now())||l.requests_used>=l.request_limit||BigInt(l.tokens_used)+units(v.limit_tokens??'0')>BigInt(l.token_limit)||active.count>=l.concurrency_limit||r.priority===0&&active.background>=backgroundCapacity(l.concurrency_limit,l.interactive_reserve)){const next=l.blocked_until&&new Date(l.blocked_until)>end?l.blocked_until:end;await tx.query(`UPDATE execution_requests SET execution_status='waiting_retry',reason='waiting_rate_limit',not_before=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.id,next]);await emit(tx,scopeOf(r),'request.waiting_rate_limit',{type:'request',id:r.id},{next_retry_at:next});return false;}
 await tx.query('UPDATE execution_limiters SET requests_used=requests_used+1,tokens_used=tokens_used+$3 WHERE organization_id=$1 AND limiter_key=$2',[r.organization_id,v.limiter_key,v.limit_tokens??'0']);return true;
}
export async function prepareDispatch(tx:Tx,scope:Scope,clock:Clock,requestId:string,fence:string|number,eligible?:(tx:Tx,variant:RouteVariant)=>Promise<boolean>,admissionId?:string){
 // Independent accounts may prepare concurrently; endpoint and budget locks protect shared resources.
 await lockExecutionAccount(tx,scope,'shared');
 const r=await lockedRequest(tx,scope,requestId);assertFence(r,fence,clock);
 if(r.execution_status!=='leased'||r.cancel_requested_at||new Date(r.deadline_at)<=clock.now())throw new DomainError('dispatch_not_allowed');
 const policy=resolveExecutionPolicy(r.route.execution);const limits=await executionLimits(tx);
 if(new Date(r.created_at).getTime()+limits.max_deadline_seconds*1000<=clock.now().getTime())throw new DomainError('execution_limit_changed');
 if(r.attempt_count>=Math.min(policy.max_attempts,limits.max_attempts))throw new DomainError('attempt_limit');
 const account=(await tx.query('SELECT spending_suspended FROM accounts WHERE organization_id=$1 AND application_id=$2 AND id=$3',[...scopeValues(scope)])).rows[0];if(account?.spending_suspended)throw new DomainError('spending_suspended');
 await endpointLock(tx,r);
 const route=r.route as ExecutionRoute;let slot=r.slot;
 let variant=selectedVariant(r);
 if(variant.eligible===false||(eligible&&!await eligible(tx,variant))){
  if(!route.fallback||route.fallback===variant||route.fallback.eligible===false||(eligible&&!await eligible(tx,route.fallback)))throw new DomainError('route_exhausted');
  variant=route.fallback;slot=Math.max(slot,2);
 }
 const activeIncident=(await tx.query(`SELECT * FROM execution_incidents WHERE organization_id=$1 AND failure_scope=$2 AND status<>'recovered' FOR UPDATE`,[scope.organization_id,route.primary.endpoint_scope])).rows[0];if(activeIncident&&activeIncident.owner_request_id!==r.id){await tx.query(`UPDATE execution_requests SET execution_status='waiting_recovery',incident_id=$2,recovery_wait_started_at=COALESCE(recovery_wait_started_at,$3),not_before=$4,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.id,activeIncident.id,clock.now(),activeIncident.next_retry_at]);return null;}
 if(r.execution_backend==='bullmq'&&!admissionId)throw new DomainError('quota_admission_required');
 if(admissionId){
  await assertQuotaProof(tx,admissionId,r.id,fence,variant.connection_id,variant.model);
 }else if(!await permitLimit(tx,r,variant,clock))return null;

 if(r.incident_id){const inc=(await tx.query('SELECT * FROM execution_incidents WHERE id=$1 FOR UPDATE',[r.incident_id])).rows[0];if(!inc||inc.status!=='probing'||inc.owner_request_id!==r.id||inc.dispatch_count>=4)throw new DomainError('recovery_lease_required');await tx.query('UPDATE execution_incidents SET dispatch_count=dispatch_count+1 WHERE id=$1',[inc.id]);}
 // Retrying a timed-out call on the same connection reuses its key, so an idempotent provider runs it once.
 const previous=(await tx.query('SELECT provider_idempotency_key,variant FROM execution_attempts WHERE request_id=$1 AND number=$2 AND reuse_idempotency_key',[r.id,r.attempt_count])).rows[0];
 const attemptId=id('att'),idempotencyKey=previous&&previous.variant.connection_id===variant.connection_id&&previous.variant.model===variant.model?previous.provider_idempotency_key:attemptId;
 const a=(await tx.query(`INSERT INTO execution_attempts(id,request_id,number,fencing_token,variant,status,submission_intent_at,provider_idempotency_key,incident_id,incident_cycle,created_at) VALUES($1,$2,$3,$4,$5,'submitting',$6,$9,$7,$8,$6) RETURNING *`,[attemptId,r.id,r.attempt_count+1,fence,variant,clock.now(),r.incident_id,r.incident_id?r.cycle:null,idempotencyKey])).rows[0];
 if(admissionId)await tx.query('UPDATE execution_attempts SET quota_admission_id=$2 WHERE id=$1',[attemptId,admissionId]);
 const allowanceReservationId=await prepareAttemptAllowance(tx,scope,clock,r,variant,attemptId);
 await claimExposure(tx,r,attemptId,variant);
 await tx.query(`UPDATE execution_requests SET execution_status='submitting',attempt_count=attempt_count+1,slot=$2,first_dispatched_at=COALESCE(first_dispatched_at,$3) WHERE id=$1`,[r.id,slot+1,clock.now()]);
 if(slot===2)await emit(tx,scope,'provider.failover_started',{type:'request',id:r.id},{connection_id:variant.connection_id});
 await emit(tx,scope,'request.started',{type:'request',id:r.id},{attempt_id:attemptId});return {...a,allowance_reservation_id:allowanceReservationId,quota_admission_id:admissionId??null,input_ref:r.input_ref};
}
export async function recordRemoteJob(tx:Tx,scope:Scope,clock:Clock,requestId:string,fence:string|number,attemptId:string,jobId:string){const r=await lockedRequest(tx,scope,requestId);assertFence(r,fence,clock);const q=await tx.query(`UPDATE execution_attempts SET remote_job_id=$3,status='running' WHERE id=$1 AND request_id=$2 AND status IN ('submitting','running') AND (remote_job_id IS NULL OR remote_job_id=$3) RETURNING id`,[attemptId,requestId,jobId]);if(!q.rowCount)throw new DomainError('invalid_attempt');await tx.query(`UPDATE execution_requests SET execution_status='running' WHERE id=$1`,[requestId]);}
async function settleExposure(tx:Tx,a:any,cost:string|undefined,charge:string|undefined){
 if(cost===undefined)return;units(cost);if(charge!==undefined)units(charge);
 const exposures=(await tx.query(`SELECT * FROM execution_exposures WHERE attempt_id=$1 AND state='open' ORDER BY kind,budget_key FOR UPDATE`,[a.id])).rows;
 for(const e of exposures){if(e.kind!=='provider'&&charge===undefined)continue;const actual=e.kind==='provider'?BigInt(cost):(BigInt(cost)>BigInt(charge!)?BigInt(cost)-BigInt(charge!):0n);await tx.query('UPDATE execution_budgets SET reserved_units=reserved_units-$4,spent_units=spent_units+$5 WHERE organization_id=$1 AND kind=$2 AND budget_key=$3',[e.organization_id,e.kind,e.budget_key,e.reserved_units,actual.toString()]);await tx.query(`UPDATE execution_exposures SET state='settled',actual_units=$4 WHERE attempt_id=$1 AND kind=$2 AND budget_key=$3`,[a.id,e.kind,e.budget_key,actual.toString()]);}
}
export interface Observation {request_id:string;attempt_id:string;fence:string|number;observation_key:string;outcome:'success'|'transient'|'defect'|'unknown'|'auth'|'quota'|'invalid'|'canceled'|'refused';cost_units?:string;charged_units?:string;retry_after_ms?:number;safe_to_retry?:boolean;result_available?:boolean;remote_request_id?:string}
async function finishSettlement(tx:Tx,r:any,scope:Scope,clock:Clock,charge:string,reason:string,settle?:Settlement){if(r.financial_closed_at)return;if(!settle)throw new DomainError('settlement_handler_required');await settle(tx,scope,{request_id:r.id,charged_units:charge,reason,idempotency_key:`execution:${r.id}:settled`});await tx.query(`UPDATE execution_requests SET settlement_status='settled',financial_closed_at=$2 WHERE id=$1`,[r.id,clock.now()]);await emit(tx,scope,'request.settled',{type:'request',id:r.id},{charged_units:charge});}
export async function observeAttempt(tx:Tx,scope:Scope,clock:Clock,o:Observation,settle?:Settlement){
 await lockExecutionAccount(tx,scope);const r=await lockedRequest(tx,scope,o.request_id);const fingerprint=hash({...o,fence:undefined});
 const previous=(await tx.query('SELECT fingerprint FROM execution_observations WHERE attempt_id=$1 AND observation_key=$2',[o.attempt_id,o.observation_key])).rows[0];if(previous){if(previous.fingerprint!==fingerprint)throw new DomainError('observation_conflict');return r;}
 assertFence(r,o.fence,clock);const a=(await tx.query('SELECT * FROM execution_attempts WHERE id=$1 AND request_id=$2 FOR UPDATE',[o.attempt_id,r.id])).rows[0];if(!a)throw new DomainError('not_found');
 if(!['submitting','running','outcome_unknown','succeeded','canceled','refused'].includes(a.status)&&!(a.status==='abandoned'&&a.cost_units===null))throw new DomainError('attempt_terminal');
 // Match dispatch ordering: endpoint/incident before shared exposure budgets.
 await endpointLock(tx,r);
 await tx.query('SELECT id FROM execution_incidents WHERE organization_id=$1 AND failure_scope=$2 FOR UPDATE',[r.organization_id,r.route.primary.endpoint_scope]);
 const outcome=o.outcome==='transient'&&!o.safe_to_retry?'unknown':o.outcome;
 await tx.query('INSERT INTO execution_observations VALUES($1,$2,$3,$4)',[a.id,o.observation_key,fingerprint,clock.now()]);
 const fixed=(r.route as ExecutionRoute).customer_price_units;let charge=fixed!==undefined?(outcome==='unknown'?undefined:outcome==='success'&&o.result_available!==false&&!r.cancel_requested_at?fixed:'0'):o.charged_units;if(outcome==='refused')charge=r.route.billing?.refused==='actual_usage'?o.charged_units:'0';else if(outcome!=='success'&&outcome!=='canceled'&&!r.cancel_requested_at)charge='0';if(r.financial_closed_at)charge='0';
 if(!r.route.primary.usage_pricing&&charge!==undefined&&units(charge)>BigInt(r.max_units))throw new DomainError('charge_exceeds_claim');
 await tx.query('UPDATE execution_attempts SET status=$2,cost_units=COALESCE($3,cost_units),charged_units=CASE WHEN $7::boolean THEN COALESCE(charged_units,0) ELSE COALESCE($4,charged_units) END,remote_request_id=COALESCE($5,remote_request_id),finished_at=$6 WHERE id=$1',[a.id,outcome==='success'?'succeeded':outcome==='unknown'?(a.status==='abandoned'?'abandoned':'outcome_unknown'):outcome,o.cost_units??null,charge??null,o.remote_request_id??null,outcome==='unknown'?null:clock.now(),!!r.financial_closed_at]);
 await settleExposure(tx,a,o.cost_units,outcome==='success'&&o.result_available===false&&!r.financial_closed_at?undefined:charge);
 const unknown=outcome==='unknown'||(o.cost_units===undefined&&(fixed===undefined||outcome==='refused'))||((outcome==='success'||outcome==='canceled'||outcome==='refused')&&charge===undefined)||(outcome==='success'&&o.result_available===false);
 if(unknown)await tx.query(`UPDATE execution_requests SET settlement_status='unresolved',unresolved_at=COALESCE(unresolved_at,$2) WHERE id=$1 AND financial_closed_at IS NULL`,[r.id,clock.now()]);
 if(outcome==='unknown'){await tx.query(`UPDATE execution_requests SET execution_status='outcome_unknown',reason='outcome_unknown',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.id]);await emit(tx,scope,'request.outcome_unknown',{type:'request',id:r.id},{attempt_id:a.id});return getRequest(tx,scope,r.id);}
 if(outcome==='refused'){
  await tx.query(`UPDATE execution_requests SET execution_status='refused',reason='model_refused',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.id]);
  if(!unknown)await finishSettlement(tx,r,scope,clock,charge!,'model_refused',settle);
  await emit(tx,scope,'request.refused',{type:'request',id:r.id},{attempt_id:a.id});
 }else if(outcome==='success'){
  await tx.query(`UPDATE execution_requests SET execution_status=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.id,r.cancel_requested_at?'canceled':'succeeded']);
  if(!unknown)await finishSettlement(tx,r,scope,clock,charge!,'valid_result',settle);
  if(r.incident_id){await tx.query(`UPDATE execution_incidents SET status='recovered',recovered_at=$3,working_endpoint_scope=$2,owner_request_id=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.incident_id,a.variant.endpoint_scope,clock.now()]);await emit(tx,scope,'provider.recovered',{type:'incident',id:r.incident_id});}
  await emit(tx,scope,r.cancel_requested_at?'request.canceled':'request.succeeded',{type:'request',id:r.id},{attempt_id:a.id});
 }else{
  const policy=resolveExecutionPolicy(r.route.execution);
  const limits=await executionLimits(tx);
  const retryPolicy={...policy,max_attempts:Math.min(policy.max_attempts,limits.max_attempts)};
  const canFallback=!!r.route.fallback&&r.route.fallback.eligible!==false&&r.route.fallback.connection_id!==a.variant.connection_id;
  const finalFailure=r.cancel_requested_at||outcome==='canceled'||outcome==='invalid'||(['auth','quota'].includes(outcome)&&!canFallback)||(r.reason==='output_started'&&!(outcome==='defect'&&policy.retry_after_output));
  const next=finalFailure?null:nextAttemptAt(retryPolicy,r.attempt_count,outcome,clock.now(),new Date(r.deadline_at),o.retry_after_ms??0,parseInt(hash([r.id,r.attempt_count]).slice(0,8),16)/0xffffffff);
  if(outcome==='defect')await tx.query('UPDATE execution_requests SET defect_seen=true WHERE id=$1',[r.id]);
  if(next){
   const slot=['auth','quota'].includes(outcome)?Math.max(2,r.slot):r.slot;
   await tx.query(`UPDATE execution_requests SET execution_status='waiting_retry',slot=$3,reason=$4,not_before=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.id,next,slot,outcome]);
  }else{
   const reason=finalFailure?outcome:outcome==='defect'?'result_defect':'attempt_limit';
   await tx.query(`UPDATE execution_requests SET execution_status=$2,reason=$3,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[r.id,r.cancel_requested_at||outcome==='canceled'?'canceled':'failed',reason]);
   if(!unknown)await finishSettlement(tx,r,scope,clock,charge??'0',reason,settle);
  }
 }

 const final=await getRequest(tx,scope,r.id);if(terminal(final.execution_status)&&r.incident_id)await tx.query(`UPDATE execution_incidents SET owner_request_id=NULL,lease_owner=NULL,lease_expires_at=NULL,status=CASE WHEN status='probing' THEN 'recovery_wait' ELSE status END WHERE id=$1 AND owner_request_id=$2`,[r.incident_id,r.id]);return final;
}
export async function cancelRequest(tx:Tx,scope:Scope,clock:Clock,requestId:string,settle?:Settlement){await lockExecutionAccount(tx,scope);const r=await lockedRequest(tx,scope,requestId);if(terminal(r.execution_status))return r;await tx.query('UPDATE execution_requests SET cancel_requested_at=COALESCE(cancel_requested_at,$2) WHERE id=$1',[r.id,clock.now()]);if(['queued','leased','waiting_retry','waiting_recovery','paused'].includes(r.execution_status)){await closeUnsent(tx,r,clock,'canceled_by_client',settle);}else {await tx.query(`UPDATE execution_requests SET settlement_status='unresolved',unresolved_at=COALESCE(unresolved_at,$2) WHERE id=$1 AND financial_closed_at IS NULL`,[r.id,clock.now()]);await emit(tx,scope,'request.cancel_requested',{type:'request',id:r.id});}return getRequest(tx,scope,r.id);}
/** Trusted financial reconciliation only. Never changes the failed outcome or authorizes dispatch. */
export async function confirmFailedAttemptCost(tx:Tx,scope:Scope,clock:Clock,input:{request_id:string;attempt_id:string;cost_entry_id:string;actor_id:string;reason:string},settle:Settlement){
 if(!input.actor_id.trim()||!input.reason.trim())throw new DomainError('reason_required');
 await lockExecutionAccount(tx,scope);const r=await lockedRequest(tx,scope,input.request_id);
 const a=(await tx.query('SELECT * FROM execution_attempts WHERE id=$1 AND request_id=$2 FOR UPDATE',[input.attempt_id,r.id])).rows[0];
 if(!a)throw new DomainError('not_found');
 if(r.execution_status!=='failed'||!['transient','defect','auth','quota','invalid'].includes(a.status))throw new DomainError('failed_attempt_required');
 const cost=(await tx.query(`SELECT * FROM provider_cost_entries WHERE ${scoped} AND id=$4 AND attempt_id=$5 AND connection_id=$6 AND model=$7 AND state='calculated' AND rounded_units IS NOT NULL`,[...scopeValues(scope),input.cost_entry_id,a.id,a.variant.connection_id,a.variant.model])).rows[0];
 if(!cost)throw new DomainError('confirmed_cost_required');
 units(cost.rounded_units);
 const key=`cost-confirmed:${cost.id}`,fingerprint=hash(input);
 const prior=(await tx.query('SELECT fingerprint FROM execution_observations WHERE attempt_id=$1 AND observation_key=$2',[a.id,key])).rows[0];
 if(prior){if(prior.fingerprint!==fingerprint)throw new DomainError('observation_conflict');return r;}
 if(a.cost_units!==null&&a.cost_units!==cost.rounded_units)throw new DomainError('confirmed_cost_conflict');
 if(a.charged_units!==null&&a.charged_units!=='0')throw new DomainError('failed_charge_conflict');
 await endpointLock(tx,r);
 await tx.query('INSERT INTO execution_observations VALUES($1,$2,$3,$4)',[a.id,key,fingerprint,clock.now()]);
 await settleExposure(tx,a,cost.rounded_units,'0');
 await tx.query('UPDATE execution_attempts SET cost_units=$2,charged_units=0 WHERE id=$1',[a.id,cost.rounded_units]);
 const unknown=(await tx.query('SELECT 1 FROM execution_attempts WHERE request_id=$1 AND cost_units IS NULL LIMIT 1',[r.id])).rowCount;
 if(!unknown)await finishSettlement(tx,r,scope,clock,'0','failed_cost_confirmed',settle);
 await tx.query('INSERT INTO audit_events(id,organization_id,application_id,actor_id,action,resource_id,reason,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id('audit'),scope.organization_id,scope.application_id,input.actor_id,'attempt.cost_confirmed',a.id,input.reason,JSON.stringify({cost_entry_id:cost.id,source_hash:cost.source_hash,cost_units:cost.rounded_units}),clock.now()]);
 return getRequest(tx,scope,r.id);
}
/** Trusted resolution of an unknown outcome from provider evidence. The customer is never charged for it. */
export async function resolveUnknownAttempt(tx:Tx,scope:Scope,clock:Clock,input:{request_id:string;attempt_id:string;actor_id:string;reason:string;provider_charged:boolean;cost_units?:string},settle:Settlement){
 if(!input.actor_id.trim()||!input.reason.trim())throw new DomainError('reason_required');
 if(input.provider_charged?input.cost_units===undefined:input.cost_units!==undefined)throw new DomainError('invalid_input','A charged resolution needs cost_units; an uncharged one has none',422);
 const cost=input.cost_units??'0';units(cost);
 await lockExecutionAccount(tx,scope);const r=await lockedRequest(tx,scope,input.request_id);
 const a=(await tx.query('SELECT * FROM execution_attempts WHERE id=$1 AND request_id=$2 FOR UPDATE',[input.attempt_id,r.id])).rows[0];
 if(!a)throw new DomainError('not_found','Attempt not found',404);
 const key='operator-resolution',fingerprint=hash(input);
 const prior=(await tx.query('SELECT fingerprint FROM execution_observations WHERE attempt_id=$1 AND observation_key=$2',[a.id,key])).rows[0];
 if(prior){if(prior.fingerprint!==fingerprint)throw new DomainError('observation_conflict');return getRequest(tx,scope,r.id);}
 // Maintenance may already have absorbed the request and abandoned the attempt with its cost still unknown.
 if(a.status!=='outcome_unknown'&&!(a.status==='abandoned'&&a.cost_units===null))throw new DomainError('unknown_attempt_required');
 if(r.lease_expires_at&&new Date(r.lease_expires_at)>clock.now())throw new DomainError('request_leased','A worker or observer currently owns this request');
 await endpointLock(tx,r);
 await tx.query('INSERT INTO execution_observations VALUES($1,$2,$3,$4)',[a.id,key,fingerprint,clock.now()]);
 await settleExposure(tx,a,cost,'0');
 await tx.query(`UPDATE execution_attempts SET status='abandoned',cost_units=$2,charged_units=0,finished_at=COALESCE(finished_at,$3) WHERE id=$1`,[a.id,cost,clock.now()]);
 if(!r.financial_closed_at){
  await finishSettlement(tx,r,scope,clock,'0','unknown_resolved',settle);
  if(input.provider_charged)await tx.query(`UPDATE execution_requests SET settlement_status='platform_absorbed' WHERE id=$1`,[r.id]);
 }
 await tx.query('INSERT INTO audit_events(id,organization_id,application_id,actor_id,action,resource_id,reason,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id('audit'),scope.organization_id,scope.application_id,input.actor_id,'attempt.unknown_resolved',a.id,input.reason,JSON.stringify({request_id:r.id,provider_charged:input.provider_charged,cost_units:cost,previous_status:a.status}),clock.now()]);
 return getRequest(tx,scope,r.id);
}
export async function recoverExpiredLeases(tx:Tx,clock:Clock,scope?:Scope){const rows=(await tx.query(`SELECT * FROM execution_requests WHERE execution_status IN ('leased','submitting','running') AND lease_expires_at<=$1 AND ($2::text IS NULL OR (organization_id=$2 AND application_id=$3 AND account_id=$4)) ORDER BY lease_expires_at,id LIMIT 256 FOR UPDATE SKIP LOCKED`,[clock.now(),scope?.organization_id??null,scope?.application_id??null,scope?.account_id??null])).rows;for(const r of rows){const a=(await tx.query('SELECT * FROM execution_attempts WHERE request_id=$1 ORDER BY number DESC LIMIT 1',[r.id])).rows[0];if(r.execution_status==='leased')await releaseUnusedAdmissions(tx,r,clock);
let status='queued';if(r.execution_status!=='leased')status=a?.remote_job_id?'running':'outcome_unknown';await tx.query(`UPDATE execution_requests SET execution_status=$2,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,unresolved_at=CASE WHEN $2='outcome_unknown' THEN COALESCE(unresolved_at,$3) ELSE unresolved_at END,settlement_status=CASE WHEN $2='outcome_unknown' THEN 'unresolved' ELSE settlement_status END WHERE id=$1`,[r.id,status,clock.now()]);if(status==='outcome_unknown'){await tx.query(`UPDATE execution_attempts SET status='outcome_unknown' WHERE id=$1`,[a.id]);await emit(tx,scopeOf(r),'request.outcome_unknown',{type:'request',id:r.id},{attempt_id:a.id});}}return rows.length;}
// Observation lease only. This never authorizes another execute call.
export async function leaseObservation(tx:Tx,scope:Scope,clock:Clock,requestId:string,worker:string,leaseMs=30000){const r=await lockedRequest(tx,scope,requestId);if(!['outcome_unknown','running','succeeded','canceled','refused'].includes(r.execution_status)||(r.lease_expires_at&&new Date(r.lease_expires_at)>clock.now()))throw new DomainError('observation_not_available');return (await tx.query('UPDATE execution_requests SET lease_owner=$2,lease_expires_at=$3,fencing_token=fencing_token+1 WHERE id=$1 RETURNING *',[r.id,worker,nowPlus(clock,leaseMs)])).rows[0];}
export async function closeUnresolved(tx:Tx,clock:Clock,settle:Settlement,scope?:Scope):Promise<number>{if(!scope){const accounts=(await tx.query('SELECT DISTINCT organization_id,application_id,account_id FROM execution_requests WHERE unresolved_at<=$1 AND financial_closed_at IS NULL',[new Date(clock.now().getTime()-3600000)])).rows;return forAvailableExecutionAccounts(tx,accounts,s=>closeUnresolved(tx,clock,settle,s));}await lockExecutionAccount(tx,scope);const rows=(await tx.query(`SELECT * FROM execution_requests WHERE unresolved_at<=$1 AND financial_closed_at IS NULL AND ($2::text IS NULL OR (organization_id=$2 AND application_id=$3 AND account_id=$4)) FOR UPDATE SKIP LOCKED`,[new Date(clock.now().getTime()-3600000),scope?.organization_id??null,scope?.application_id??null,scope?.account_id??null])).rows;for(const r of rows){await finishSettlement(tx,r,scopeOf(r),clock,'0','unresolved_timeout',settle);for(const a of (await tx.query('SELECT * FROM execution_attempts WHERE request_id=$1 AND cost_units IS NOT NULL',[r.id])).rows)await settleExposure(tx,a,a.cost_units,'0');await tx.query(`UPDATE execution_requests SET settlement_status='platform_absorbed' WHERE id=$1`,[r.id]);await tx.query(`UPDATE execution_attempts SET status='abandoned',finished_at=COALESCE(finished_at,$2) WHERE request_id=$1 AND status='outcome_unknown'`,[r.id,clock.now()]);}return rows.length;}
export async function enableIncident(tx:Tx,scope:Scope,clock:Clock,incidentId:string,reason:string){if(!reason.trim())throw new DomainError('reason_required');
 const incident=(await tx.query('SELECT failure_scope FROM execution_incidents WHERE id=$1 AND organization_id=$2',[incidentId,scope.organization_id])).rows[0];
 if(!incident)throw new DomainError('not_found');
 await endpointLock(tx,{organization_id:scope.organization_id,route:{primary:{endpoint_scope:incident.failure_scope}}});
 const q=await tx.query(`UPDATE execution_incidents SET status='recovered',working_endpoint_scope=NULL,owner_request_id=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND organization_id=$2 RETURNING *`,[incidentId,scope.organization_id]);if(!q.rows[0])throw new DomainError('not_found');await emit(tx,scope,'provider.enabled',{type:'incident',id:incidentId},{reason,at:clock.now().toISOString()});return q.rows[0];}
export async function expireRequests(tx:Tx,clock:Clock,settle:Settlement,scope?:Scope):Promise<number>{if(!scope){const accounts=(await tx.query("SELECT DISTINCT organization_id,application_id,account_id FROM execution_requests WHERE deadline_at<=$1 AND execution_status NOT IN ('succeeded','failed','canceled','refused')",[clock.now()])).rows;return forAvailableExecutionAccounts(tx,accounts,s=>expireRequests(tx,clock,settle,s));}await lockExecutionAccount(tx,scope);const rows=(await tx.query(`SELECT * FROM execution_requests WHERE deadline_at<=$1 AND execution_status NOT IN ('succeeded','failed','canceled','refused') AND ($2::text IS NULL OR (organization_id=$2 AND application_id=$3 AND account_id=$4)) FOR UPDATE SKIP LOCKED`,[clock.now(),scope?.organization_id??null,scope?.application_id??null,scope?.account_id??null])).rows;for(const r of rows){if(['queued','leased','waiting_retry','waiting_recovery','paused'].includes(r.execution_status))await closeUnsent(tx,r,clock,unsentDeadlineReason(r),settle);else if(!r.cancel_requested_at){await tx.query(`UPDATE execution_requests SET cancel_requested_at=$2,reason='deadline_exceeded',settlement_status=CASE WHEN financial_closed_at IS NULL THEN 'unresolved' ELSE settlement_status END,unresolved_at=COALESCE(unresolved_at,$2) WHERE id=$1`,[r.id,clock.now()]);await emit(tx,scopeOf(r),'request.cancel_requested',{type:'request',id:r.id},{reason:'deadline_exceeded'});}}return rows.length;}
