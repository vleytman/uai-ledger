import {backgroundSlotsFull} from './priority.js';
import {withQuotaGroupLock,quotaTransaction,lockQuotaGroupRows} from './group-lock.js';
import {applyQuotaUsage} from './quota-adjustments.js';
import {refundUnusedAdmissions} from './unused-admissions.js';
import {applyQuotaHeaders} from './headers.js';
import type pg from 'pg';
import {transaction,type Tx} from '../../db/src/index.js';
import {DomainError,hash} from '../../contracts/src/index.js';
import {QuotaStore,type Admission,type QuotaDemand,type QuotaWaiter} from './quota.js';

// Slot expiry is a safety hold, not a promised release time. Poll for a known
// completion without shortening the hold or allowing an extra provider call.
export function concurrencyRetryAt(expiresAt:Date|string){return Math.min(new Date(expiresAt).getTime(),Date.now()+1000)}
/** Calls wait for a quota group in the order they were enqueued. */
export async function quotaWaiter(db:{query:pg.Pool['query']},requestId:string):Promise<QuotaWaiter|undefined>{
 const row=(await db.query('SELECT enqueued_at FROM execution_requests WHERE id=$1',[requestId])).rows[0];
 return row?{id:requestId,since:new Date(row.enqueued_at).getTime()}:undefined;
}
/**
 * Admissions a new, empty Redis must learn again before the group opens. An admission outside every rule
 * window of its group no longer counts and holds no slot; an intent whose request has moved to another fence
 * or state can never be acknowledged, so it never led to a call. Restoring them only cost time under the
 * group lock and, for intents, counted them as fresh use at recovery time.
 */
export async function recoverableAdmissions(db:{query:pg.Pool['query']},groupId:string,excludeId:string){
 return (await db.query(`SELECT d.* FROM dispatch_admissions d JOIN execution_requests r ON r.id=d.request_id
  WHERE d.group_id=$1 AND (d.id<>$2 OR d.state='admitted') AND d.state<>'rejected' AND d.unused_at IS NULL AND d.created_at>now()-interval '25 hours'
   AND ((d.state='admitted' AND (d.admitted_at>now()-((SELECT COALESCE(max(window_ms),0) FROM provider_quota_rules WHERE group_id=$1)+60000)*interval '1 millisecond'
     OR (d.slot_released_at IS NULL AND d.slot_expires_at>now())))
    OR (d.state='intent' AND r.fencing_token=d.fencing_token AND r.execution_status='leased'))
  ORDER BY d.created_at`,[groupId,excludeId])).rows;
}
export type AdmissionInput={id:string;group_id:string;request_id:string;fence:string;demands:QuotaDemand[]};
/** With lock 'none' the group row is read without a lock; the caller locks it later, when it counts slots. */
export async function validateIntent(tx:Tx,input:AdmissionInput,lock:'share'|'none'='share'){
 const group=(await tx.query(`SELECT * FROM provider_quota_groups WHERE id=$1${lock==='share'?' FOR SHARE':''}`,[input.group_id])).rows[0];if(!group)throw new DomainError('quota_group_missing');
 const request=(await tx.query("SELECT organization_id,fencing_token,execution_status,lease_expires_at>now() AS live,deadline_at>now() AS timely,cancel_requested_at FROM execution_requests WHERE id=$1 FOR SHARE",[input.request_id])).rows[0];
 if(!request||request.organization_id!==group.organization_id)throw new DomainError('not_found');
 if(String(request.fencing_token)!==input.fence||request.execution_status!=='leased'||!request.live||!request.timely||request.cancel_requested_at)throw new DomainError('stale_lease');
 const rules=(await tx.query('SELECT * FROM provider_quota_rules WHERE group_id=$1 ORDER BY key',[input.group_id])).rows;
 if(!rules.length||rules.length!==input.demands.length||new Set(input.demands.map(r=>r.key)).size!==rules.length)throw new DomainError('quota_rules_mismatch');
 for(const rule of rules){const demand=input.demands.find(r=>r.key===rule.key);if(!demand||demand.capacity!==Number(rule.capacity)||demand.window_ms!==rule.window_ms||!Number.isSafeInteger(demand.amount)||demand.amount<0)throw new DomainError('quota_rules_mismatch');}
 return group;
}
function sameIntent(existing:any,input:AdmissionInput){
 if(existing.group_id!==input.group_id||existing.request_id!==input.request_id||String(existing.fencing_token)!==input.fence||hash(existing.demands)!==hash(input.demands))throw new DomainError('idempotency_conflict');
}
const notReady:Admission={allowed:false,reason:'not_ready'};
/** Admissions run side by side, so the last slot or a new cooldown can be taken between Redis and confirmation: that is a limit, not a failure. */
export function limitedAtConfirmation(error:unknown):Admission|undefined{
 if(!(error instanceof DomainError))return;
 if(error.code==='quota_concurrency_changed')return {allowed:false,reason:'limited',rule:'concurrency',retry_at:Number(error.details.retry_at)};
 if(error.code==='quota_cooldown_changed')return {allowed:false,reason:'limited',rule:'cooldown',retry_at:Number(error.details.retry_at)};
}
/**
 * Rebuilds a group's Redis state from PostgreSQL under the exclusive group lock, unless another process did it first.
 * Other intents still in flight are restored conservatively. The caller's own is not: it acquires next, and a restored
 * marker would let it replay a permit it never had.
 */
export async function recoverQuotaGroup(pool:pg.Pool,store:QuotaStore,groupId:string,ownAdmissionId:string){
 await withQuotaGroupLock(pool,groupId,async client=>{
  const group=(await client.query('SELECT * FROM provider_quota_groups WHERE id=$1',[groupId])).rows[0];
  if(!group)throw new DomainError('quota_group_missing');
  if(await store.isReady(group.recovery_epoch))return;
  await store.closeGate();
  const admissions=await recoverableAdmissions(client,group.id,ownAdmissionId);
  const recoveryTime=await store.currentTime();
  // An unacknowledged acquire may have happened long after its intent was created.
  // Restart its conservative window rather than releasing possibly fresh consumption early.
  for(const row of admissions)await store.restore(row.id,row.admitted_at?new Date(row.admitted_at).getTime():recoveryTime,row.demands);
  await applyQuotaUsage(client,store,group,true);
  const observations=(await client.query("SELECT * FROM quota_observations WHERE group_id=$1 AND received_at>now()-interval '25 hours' ORDER BY received_at",[group.id])).rows;
  const rules=(await client.query('SELECT key,metric,window_ms FROM provider_quota_rules WHERE group_id=$1',[group.id])).rows;
  for(const observation of observations)await applyQuotaHeaders(store,rules,{...observation,sent_at:new Date(observation.sent_at).toISOString(),received_at:new Date(observation.received_at).toISOString()});
  await store.markRestored(group.recovery_epoch);
 });
}
/**
 * PostgreSQL journals intent before Redis. Uncertain intents are conservatively replayed.
 * Admissions of one group run side by side without a group lock; only confirming a slot is one at a time, in a short transaction.
 */
export async function acquireDurable(pool:pg.Pool,store:QuotaStore,input:AdmissionInput):Promise<Admission>{
 for(let round=0;;round++){
  const result=await admitOnce(pool,store,input);
  if(result!=='recover')return result;
  if(round>0)return notReady;
  await recoverQuotaGroup(pool,store,input.group_id,input.id);
 }
}
async function admitOnce(pool:pg.Pool,store:QuotaStore,input:AdmissionInput):Promise<Admission|'recover'>{
 const client=await pool.connect();let lost=false;const disconnected=()=>{lost=true};client.on('error',disconnected);
 try{
  const prepared=await quotaTransaction(client,async tx=>{
   const group=await validateIntent(tx,input);
   if(group.coordination_domain)throw new DomainError('quota_bundle_required');
   const existing=(await tx.query('SELECT *,slot_heartbeat_until>now() AS slot_live FROM dispatch_admissions WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(!existing)throw new DomainError('quota_intent_missing');
   if((await tx.query('SELECT 1 FROM dispatch_admission_bundle_members WHERE admission_id=$1',[input.id])).rowCount)throw new DomainError('quota_bundle_required');
   sameIntent(existing,input);
   if(existing.rules_revision!==group.revision)throw new DomainError('quota_revision_changed');
   if(existing.unused_at)throw new DomainError('quota_slot_lost');
   if(existing.state==='rejected')return {result:existing.rejection as Admission};
   if(existing.state==='admitted'&&(existing.slot_released_at||existing.slot_unknown_at||!existing.slot_live))throw new DomainError('quota_slot_lost');
   const slots=(await tx.query(`SELECT count(*)::integer count,min(slot_expires_at) earliest,now() checked_at FROM dispatch_admissions WHERE group_id=$1 AND id<>$2 AND slot_released_at IS NULL AND slot_expires_at>now()`,[group.id,input.id])).rows[0];
   if(existing.state!=='admitted'&&(slots.count>=group.concurrency_limit||await backgroundSlotsFull(tx,group,input.request_id,input.id)))return {result:{allowed:false,reason:'limited',rule:'concurrency',retry_at:concurrencyRetryAt(slots.earliest),details:{group_id:group.id,rule:'concurrency',demand:'1',available:'0',capacity:String(group.concurrency_limit),window_ms:null,checked_at:new Date(slots.checked_at).getTime()}} as Admission};
   return {group,existing};
  });
  if(prepared.result)return prepared.result;
  const {group,existing}=prepared;
  if(!await store.isReady(group.recovery_epoch))return 'recover';
  if(group.blocked_until&&new Date(group.blocked_until).getTime()>Date.now()){for(const demand of input.demands)await store.blockUntil(group.recovery_epoch,demand.key,new Date(group.blocked_until).getTime());}
  await applyQuotaUsage(client,store,group);
  await refundUnusedAdmissions(client,store,group);
  const result=await store.acquire(group.recovery_epoch,input.id,input.demands,await quotaWaiter(client,input.request_id));
  // A missing epoch or conflicting cache cannot disprove an earlier acquire with a lost reply.
  // Keep the journal entry recoverable, just as multi-group admission does.
  if(!result.allowed&&(result.reason==='not_ready'||result.reason==='conflict'))return result;

  try{return await quotaTransaction(client,async tx=>{
   // Redis may have taken time. Recheck permission and configuration before issuing a proof.
   const validated=await validateIntent(tx,input,'none');let current=validated;
   if(current.coordination_domain||current.revision!==group.revision||current.recovery_epoch!==group.recovery_epoch)throw new DomainError('quota_revision_changed');
   const latest=(await tx.query('SELECT *,slot_heartbeat_until>now() AS slot_live FROM dispatch_admissions WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(!latest)throw new DomainError('quota_intent_missing');sameIntent(latest,input);
   if(latest.unused_at||latest.slot_released_at||latest.slot_unknown_at||(latest.state==='admitted'&&!latest.slot_live))throw new DomainError('quota_slot_lost');
   // Another admission of this intent confirmed it meanwhile: its proof stands, this one gets none.
   if(latest.state!==existing.state)throw new DomainError('quota_slot_lost');
   if(result.allowed&&existing.state!=='admitted'){
    // Only here, at the end, is the group row locked: counting slots and writing the proof are one at a time.
    current=(await lockQuotaGroupRows(tx,[input.group_id])).get(input.group_id);
    if(!current||current.revision!==validated.revision||current.recovery_epoch!==validated.recovery_epoch)throw new DomainError('quota_revision_changed');
    const slots=(await tx.query(`SELECT count(*)::int count,min(slot_expires_at) earliest FROM dispatch_admissions WHERE group_id=$1 AND id<>$2 AND slot_released_at IS NULL AND slot_expires_at>now()`,[group.id,input.id])).rows[0];
    if(slots.count>=current.concurrency_limit||await backgroundSlotsFull(tx,current,input.request_id,input.id))throw new DomainError('quota_concurrency_changed','Concurrency filled during admission',409,{retry_at:concurrencyRetryAt(slots.earliest??new Date())});
    if(current.blocked_until&&new Date(current.blocked_until).getTime()>Date.now())throw new DomainError('quota_cooldown_changed','Cooldown began during admission',409,{retry_at:new Date(current.blocked_until).getTime()});
   }
   await tx.query('UPDATE dispatch_admissions SET state=$2,admitted_at=$3,rejection=$4 WHERE id=$1',[input.id,result.allowed?'admitted':'rejected',result.allowed?new Date(result.at):null,result.allowed?null:result]);
   if(result.allowed&&existing.state!=='admitted')await tx.query("UPDATE dispatch_admissions SET slot_heartbeat_until=now()+$2*interval '1 millisecond',slot_expires_at=now()+($2+$3)*interval '1 millisecond',slot_released_at=NULL WHERE id=$1",[input.id,current.slot_lease_ms,current.unknown_hold_ms]);
   return result;
  })}catch(error){
   // A known Redis result grants no external-send permission if confirmation failed.
   // Lock the request before proving there is no concurrent submission for this fence.
   await quotaTransaction(client,async tx=>{
    await tx.query('SELECT id FROM execution_requests WHERE id=$1 FOR UPDATE',[input.request_id]);
    await tx.query(`UPDATE dispatch_admissions d SET unused_at=COALESCE(unused_at,now()),slot_released_at=COALESCE(slot_released_at,now()),slot_heartbeat_until=NULL
     WHERE d.id=$1 AND d.state='intent' AND d.slot_unknown_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM execution_attempts a WHERE a.request_id=d.request_id AND a.fencing_token=d.fencing_token)`,[input.id]);
   });
   const limited=limitedAtConfirmation(error);if(limited)return limited;
   throw error;
  }
 }finally{client.off('error',disconnected);client.release(lost)}
}
export async function recordAdmissionIntent(pool:pg.Pool,input:AdmissionInput){
 return transaction(pool,async tx=>{
  // No group lock: confirmation rechecks the rules revision, recovery is gated in Redis, and the id is unique.
  const group=await validateIntent(tx,input);
  const prior=(await tx.query('SELECT * FROM dispatch_admissions WHERE id=$1',[input.id])).rows[0];
  if(prior){sameIntent(prior,input);return}
  await tx.query("INSERT INTO dispatch_admissions(id,group_id,request_id,fencing_token,rules_revision,demands,state,rule_metrics) VALUES($1,$2,$3,$4,$5,$6,'intent',(SELECT COALESCE(jsonb_object_agg(key,metric),'{}'::jsonb) FROM provider_quota_rules WHERE group_id=$2)) ON CONFLICT(id) DO NOTHING",[input.id,input.group_id,input.request_id,input.fence,group.revision,JSON.stringify(input.demands)]);
 });
}
