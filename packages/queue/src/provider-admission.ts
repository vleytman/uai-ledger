import {quotaDemands} from './quota-demands.js';
import {recordQuotaExcess,applyQuotaExcess} from './quota-adjustments.js';
import {transaction} from '../../db/src/index.js';
import {recordAdmissionBundle,acquireAdmissionBundle} from './admission-bundle.js';
import {applyQuotaHeaders} from './headers.js';
import type pg from 'pg';
import {DomainError,id,hash} from '../../contracts/src/index.js';
import type {WorkerDependencies} from '../../execution/src/runtime.js';
import {QuotaStore} from './quota.js';
import {recordAdmissionIntent,acquireDurable} from './admission.js';

export function providerAdmission(pool:pg.Pool,url:string,installation:string){
 const stores=new Map<string,QuotaStore>();
 const memberIds=async(representative:string)=>(await pool.query(`SELECT a.id FROM dispatch_admissions a WHERE a.id=$1 OR a.id IN (
  SELECT m.admission_id FROM dispatch_admission_bundle_members m JOIN dispatch_admission_bundle_members root ON root.bundle_id=m.bundle_id WHERE root.admission_id=$1) ORDER BY a.id`,[representative])).rows.map(row=>row.id) as string[];
 const storeFor=async(group:any)=>{
  const domain=group.coordination_domain?JSON.stringify([group.organization_id,group.coordination_domain]):undefined;
  const key=JSON.stringify([group.id,domain]);let store=stores.get(key);
  if(!store){store=new QuotaStore(url,installation,group.id,domain);store.redis.on('error',()=>{});stores.set(key,store)}await store.connect();return store;
 };
 const admit:NonNullable<WorkerDependencies['admit']>=async(scope,request,variant,context,adapter)=>{
  const boundGroups=(await pool.query(`SELECT g.* FROM provider_quota_groups g JOIN provider_quota_bindings b ON b.group_id=g.id WHERE b.connection_id=$1 AND b.model=$2 AND g.organization_id=$3 ORDER BY g.id`,[variant.connection_id,variant.model,scope.organization_id])).rows;
  if(!boundGroups.length)return {allowed:false,reason:'quota_group_missing'};
  const quantities=context.limit_usage_estimate??adapter.estimateLimitUsage(context.input,{expected_output_tokens:context.expected_output_tokens});
  const ruleMetrics=new Map<string,Record<string,string>>();
  const inputs=[];const bundleId=`quota-${request.id}-${request.fencing_token}`;
  for(const group of boundGroups){
   const rules=(await pool.query('SELECT * FROM provider_quota_rules WHERE group_id=$1 ORDER BY key',[group.id])).rows;
   ruleMetrics.set(group.id,Object.fromEntries(rules.map(rule=>[rule.key,rule.metric])));
   const demands=quotaDemands(rules,quantities);
   if(!demands.length)return {allowed:false,reason:'quota_rules_missing'};
   inputs.push({id:boundGroups.length===1?bundleId:`${bundleId}-${hash(group.id)}`,group_id:group.id,request_id:request.id,fence:String(request.fencing_token),demands});
  }
  let result;
  if(inputs.length>1||boundGroups[0].coordination_domain){await recordAdmissionBundle(pool,bundleId,inputs);result=await acquireAdmissionBundle(pool,url,installation,bundleId)}
  else {await recordAdmissionIntent(pool,inputs[0]!);result=await acquireDurable(pool,await storeFor(boundGroups[0]),inputs[0]!)}
  let quota_wait;
  if(!result.allowed&&result.details){
   const d=result.details,group=boundGroups.find(group=>group.id===d.group_id);
   const metric=d.rule==='concurrency'?'concurrency':ruleMetrics.get(d.group_id)?.[d.rule];
   if(group&&metric)quota_wait={...d,group_name:group.name,metric,checked_at:new Date(d.checked_at).toISOString()};
  }
  return result.allowed?{allowed:true,admission_id:inputs[0]!.id}:{allowed:false,reason:result.reason==='too_large'?'quota_request_too_large':result.reason==='limited'?'waiting_rate_limit':`quota_${result.reason}`,...(result.reason==='limited'?{retry_at:new Date(result.retry_at!)}:{}),...(quota_wait?{quota_wait}:{})};
 };

 /** Advisory snapshot. No intent, permit, gate recovery or provider call is made here. */
 const preview=async(...[scope,_request,variant,context,adapter]:Parameters<NonNullable<WorkerDependencies['admit']>>)=>{
  const unknown=(reason:string)=>({mode:'shadow' as const,would_allow:null,reason});
  const read=async()=>(await pool.query(`SELECT g.*,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('key',r.key,'metric',r.metric,'capacity',r.capacity::text,'window_ms',r.window_ms) ORDER BY r.key),'[]') FROM provider_quota_rules r WHERE r.group_id=g.id) AS rules,
   (SELECT count(*)::int FROM dispatch_admissions a WHERE a.group_id=g.id AND a.slot_released_at IS NULL AND a.slot_expires_at>now()) AS held_slots,
   EXISTS(SELECT 1 FROM quota_observations o WHERE o.group_id=g.id AND o.applied_at IS NULL)
    OR EXISTS(SELECT 1 FROM quota_usage_adjustments x WHERE x.group_id=g.id AND x.applied_at IS NULL)
    OR EXISTS(SELECT 1 FROM dispatch_admissions a WHERE a.group_id=g.id AND ((a.state='intent' AND a.unused_at IS NULL) OR (a.unused_at IS NOT NULL AND a.unused_refunded_at IS NULL))) AS pending_reconciliation
   FROM provider_quota_groups g JOIN provider_quota_bindings b ON b.group_id=g.id
   WHERE b.connection_id=$1 AND b.model=$2 AND g.organization_id=$3 ORDER BY g.id`,[variant.connection_id,variant.model,scope.organization_id])).rows;
  try{
   const groups=await read();if(!groups.length)return unknown('quota_group_missing');
   if(groups.some(group=>!group.rules.length))return unknown('quota_rules_missing');
   if(groups.some(group=>group.pending_reconciliation))return unknown('pending_reconciliation');
   const quantities=context.limit_usage_estimate??adapter.estimateLimitUsage(context.input,{expected_output_tokens:context.expected_output_tokens});
   const inputs=await Promise.all(groups.map(async group=>({store:await storeFor(group),epoch:group.recovery_epoch,demands:quotaDemands(group.rules,quantities)})));
   const result=await QuotaStore.previewMany(inputs);
   // SQL configuration/slots and Redis are not a joint atomic snapshot. Detect visible changes;
   // even an unchanged observation grants no external-send permission.
   if(hash(groups)!==hash(await read()))return unknown('quota_state_changed');
   if(result.would_allow===null)return {mode:'shadow' as const,...result};
   const held=groups.find(group=>group.held_slots>=group.concurrency_limit);
   if(held)return {mode:'shadow' as const,would_allow:false,reason:'concurrency',group_id:held.id};
   const blocked=groups.find(group=>group.blocked_until&&new Date(group.blocked_until).getTime()>Date.now());
   if(blocked)return {mode:'shadow' as const,would_allow:false,reason:'cooldown',group_id:blocked.id,retry_at:new Date(blocked.blocked_until).getTime()};
   return {mode:'shadow' as const,...result};
  }catch(error){return unknown(error instanceof DomainError?error.code:error instanceof Error&&error.message==='quota_domains_must_match'?'quota_domains_must_match':'quota_infrastructure_unavailable')}
 };

 const onRateLimits:NonNullable<WorkerDependencies['onRateLimits']>=async(_scope,_request,attempt,observation)=>{
  await pool.query('INSERT INTO provider_http_observations(attempt_id,sent_at,received_at,status) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[attempt.id,observation.sent_at,observation.received_at,observation.status]);
  if(!attempt.quota_admission_id)return;
  const ids=await memberIds(attempt.quota_admission_id);
  const groups=(await pool.query('SELECT g.* FROM provider_quota_groups g JOIN dispatch_admissions a ON a.group_id=g.id WHERE a.id=ANY($1::text[])',[ids])).rows;
  for(const group of groups){
   // A response header describes a provider scope, not every group on the route.
   if(groups.length>1&&group.scope.response_headers!==true)continue;
   const rules=(await pool.query('SELECT key,metric,window_ms FROM provider_quota_rules WHERE group_id=$1',[group.id])).rows;
   const observationId=id('qobs'),domain=group.coordination_domain?JSON.stringify([group.organization_id,group.coordination_domain]):null;
   await pool.query('INSERT INTO quota_observations(id,group_id,attempt_id,sent_at,received_at,headers,delivery_rules,delivery_domain) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[observationId,group.id,attempt.id,observation.sent_at,observation.received_at,observation.headers,JSON.stringify(rules),domain]);
   await applyQuotaHeaders(await storeFor(group),rules,observation);
   await pool.query('UPDATE quota_observations SET applied_at=now() WHERE id=$1',[observationId]);
  }
 };

 const applyCooldown=async(group:any)=>{
  const store=await storeFor(group),until=new Date(group.blocked_until).getTime();
  const rules=(await pool.query('SELECT key FROM provider_quota_rules WHERE group_id=$1',[group.id])).rows;
  for(const rule of rules)if(!await store.blockUntil(group.recovery_epoch,rule.key,until))return;
  await pool.query('UPDATE provider_quota_groups SET cooldown_applied_until=$2 WHERE id=$1 AND blocked_until=$2',[group.id,group.cooldown_target]);
 };
 const replayCooldowns=async()=>{
  const groups=(await pool.query(`UPDATE provider_quota_groups SET cooldown_retry_at=now()+interval '30 seconds'
   WHERE id IN (SELECT id FROM provider_quota_groups WHERE blocked_until>now()
    AND (cooldown_applied_until IS NULL OR cooldown_applied_until<blocked_until) AND cooldown_retry_at<=now()
    ORDER BY cooldown_retry_at,id LIMIT 32 FOR UPDATE SKIP LOCKED) RETURNING *,blocked_until::text AS cooldown_target`)).rows;
  for(const group of groups)try{await applyCooldown(group)}catch{console.error('quota_cooldown_replay_failed')}
  return groups.length;
 };
 const onProviderResult:NonNullable<WorkerDependencies['onProviderResult']>=async(_scope,_request,attempt,result)=>{
  if(!attempt.quota_admission_id)return;
  const ids=await memberIds(attempt.quota_admission_id);
  let adjustedGroups:any[]=[];
  const groups=await transaction(pool,async tx=>{
   adjustedGroups=await recordQuotaExcess(tx,ids,result.limit_usage,attempt.quota_observed_at);
   if(result.outcome==='unknown')await tx.query(`UPDATE dispatch_admissions a SET slot_unknown_at=COALESCE(a.slot_unknown_at,$2::timestamptz,now()),slot_heartbeat_until=NULL,slot_expires_at=COALESCE(a.slot_unknown_at,$2::timestamptz,now())+g.unknown_hold_ms*interval '1 millisecond' FROM provider_quota_groups g WHERE a.id=ANY($1::text[]) AND a.group_id=g.id AND a.slot_released_at IS NULL AND a.slot_expires_at>now()`,[ids,attempt.quota_observed_at??null]);
   else await tx.query('UPDATE dispatch_admissions SET slot_released_at=COALESCE(slot_released_at,now()) WHERE id=ANY($1::text[])',[ids]);
   if(result.outcome==='success'||result.failure.kind!=='transient')return [];
   const delay=Math.min(86400000,Math.max(1000,result.failure.retry_after_ms??5000));
   await tx.query("UPDATE dispatch_admissions SET cooldown_until=COALESCE(cooldown_until,COALESCE($3::timestamptz,now())+$2*interval '1 millisecond') WHERE id=ANY($1::text[])",[ids,delay,attempt.quota_observed_at??null]);
   return (await tx.query(`UPDATE provider_quota_groups g SET blocked_until=GREATEST(g.blocked_until,a.cooldown_until),cooldown_retry_at=now() FROM dispatch_admissions a WHERE a.id=ANY($1::text[]) AND a.group_id=g.id RETURNING g.*,g.blocked_until::text AS cooldown_target`,[ids])).rows;
  });
  for(const group of adjustedGroups)await applyQuotaExcess(pool,await storeFor(group),group);
  for(const group of groups)await applyCooldown(group);
 };
 // A confirmed remote job is held independently of the original submission lease.
 // Only its current observer may extend the hold; it never authorizes a new submission.
 const onNativePending:NonNullable<WorkerDependencies['onNativePending']>=async(request,attempt)=>{
  if(!attempt.quota_admission_id)return;
  const ids=await memberIds(attempt.quota_admission_id);
  await transaction(pool,async tx=>{const result=await tx.query(`UPDATE dispatch_admissions a
   SET slot_heartbeat_until=NULL,slot_unknown_at=NULL,
       slot_expires_at=now()+GREATEST(g.unknown_hold_ms,90000)*interval '1 millisecond'
   FROM provider_quota_groups g,execution_requests r,execution_attempts e
   WHERE a.id=ANY($1::text[]) AND a.group_id=g.id AND a.request_id=r.id
     AND r.id=$2 AND r.fencing_token=$3 AND r.lease_expires_at>now()
     AND e.id=$4 AND e.request_id=r.id AND e.number=r.attempt_count
     AND e.quota_admission_id=$5 AND e.remote_job_id IS NOT NULL
     AND r.execution_status IN ('running','outcome_unknown')
     AND a.slot_released_at IS NULL RETURNING a.id`,
   [ids,request.id,request.fencing_token,attempt.id,attempt.quota_admission_id]);
  if(!ids.length||result.rowCount!==ids.length)throw new DomainError('quota_slot_lost');});
 };
 const renewAdmission:NonNullable<WorkerDependencies['renewAdmission']>=async(_request,attempt)=>{
  if(!attempt.quota_admission_id)return;
  const ids=await memberIds(attempt.quota_admission_id);
  await transaction(pool,async tx=>{const result=await tx.query(`UPDATE dispatch_admissions a SET slot_heartbeat_until=now()+g.slot_lease_ms*interval '1 millisecond',slot_expires_at=now()+(g.slot_lease_ms+g.unknown_hold_ms)*interval '1 millisecond' FROM provider_quota_groups g,execution_requests r WHERE a.id=ANY($1::text[]) AND a.group_id=g.id AND a.request_id=r.id AND a.fencing_token=r.fencing_token AND r.lease_expires_at>now() AND a.slot_unknown_at IS NULL AND a.slot_heartbeat_until>now() AND a.slot_released_at IS NULL AND a.slot_expires_at>now() RETURNING a.id`,[ids]);
  if(!ids.length||result.rowCount!==ids.length)throw new DomainError('quota_slot_lost');});
 };
 // Claim a bounded batch without keeping a SQL transaction open during Redis calls.
 const replayObservations=async()=>{
  const rows=(await pool.query(`UPDATE quota_observations SET retry_at=now()+interval '30 seconds'
   WHERE id IN (SELECT id FROM quota_observations WHERE applied_at IS NULL AND retry_at<=now()
    ORDER BY retry_at,id LIMIT 32 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows;
  let applied=0;
  for(const row of rows){
   try{
    const key=JSON.stringify([row.group_id,row.delivery_domain??undefined]);let store=stores.get(key);
    if(!store){store=new QuotaStore(url,installation,row.group_id,row.delivery_domain??undefined);store.redis.on('error',()=>{});stores.set(key,store)}
    await store.connect();
    await applyQuotaHeaders(store,row.delivery_rules??[],{headers:row.headers,sent_at:new Date(row.sent_at).toISOString(),received_at:new Date(row.received_at).toISOString()});
    await pool.query('UPDATE quota_observations SET applied_at=now() WHERE id=$1',[row.id]);applied++;
   }catch{console.error('quota_observation_replay_failed')}
  }
  return {selected:rows.length,applied};
 };
 return {replayCooldowns,replayObservations,preview,admit,onRateLimits,onProviderResult,onNativePending,renewAdmission,close:()=>Promise.all([...stores.values()].map(store=>store.close()))};
}
