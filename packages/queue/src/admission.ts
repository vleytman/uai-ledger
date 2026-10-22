import {backgroundSlotsFull} from './priority.js';
import {withQuotaGroupLock,quotaTransaction} from './group-lock.js';
import {applyQuotaExcess} from './quota-adjustments.js';
import {refundUnusedAdmissions} from './unused-admissions.js';
import {applyQuotaHeaders} from './headers.js';
import type pg from 'pg';
import {transaction,type Tx} from '../../db/src/index.js';
import {DomainError,hash} from '../../contracts/src/index.js';
import {QuotaStore,type Admission,type QuotaDemand} from './quota.js';

// Slot expiry is a safety hold, not a promised release time. Poll for a known
// completion without shortening the hold or allowing an extra provider call.
export function concurrencyRetryAt(expiresAt:Date|string){return Math.min(new Date(expiresAt).getTime(),Date.now()+1000)}
export type AdmissionInput={id:string;group_id:string;request_id:string;fence:string;demands:QuotaDemand[]};
export async function validateIntent(tx:Tx,input:AdmissionInput){
 const group=(await tx.query('SELECT * FROM provider_quota_groups WHERE id=$1 FOR SHARE',[input.group_id])).rows[0];if(!group)throw new DomainError('quota_group_missing');
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
/** PostgreSQL journals intent before Redis. Uncertain intents are conservatively replayed. */
export async function acquireDurable(pool:pg.Pool,store:QuotaStore,input:AdmissionInput):Promise<Admission>{
 return withQuotaGroupLock(pool,input.group_id,async client=>{
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
  if(!await store.isReady(group.recovery_epoch)){
   await store.closeGate();
   const admissions=(await client.query("SELECT * FROM dispatch_admissions WHERE group_id=$1 AND (id<>$2 OR state='admitted') AND state<>'rejected' AND unused_at IS NULL AND created_at>now()-interval '25 hours' ORDER BY created_at",[group.id,input.id])).rows;
   const recoveryTime=await store.currentTime();
   // An unacknowledged acquire may have happened long after its intent was created.
   // Restart its conservative window rather than releasing possibly fresh consumption early.
   for(const row of admissions)await store.restore(row.id,row.admitted_at?new Date(row.admitted_at).getTime():recoveryTime,row.demands);
   await applyQuotaExcess(client,store,group,true);
   const observations=(await client.query("SELECT * FROM quota_observations WHERE group_id=$1 AND received_at>now()-interval '25 hours' ORDER BY received_at",[group.id])).rows;
   const rules=(await client.query('SELECT key,metric,window_ms FROM provider_quota_rules WHERE group_id=$1',[group.id])).rows;
   for(const observation of observations)await applyQuotaHeaders(store,rules,{...observation,sent_at:new Date(observation.sent_at).toISOString(),received_at:new Date(observation.received_at).toISOString()});
   await store.markRestored(group.recovery_epoch);
  }
  if(group.blocked_until&&new Date(group.blocked_until).getTime()>Date.now()){for(const demand of input.demands)await store.blockUntil(group.recovery_epoch,demand.key,new Date(group.blocked_until).getTime());}
  await applyQuotaExcess(client,store,group);
  await refundUnusedAdmissions(client,store,group);
  const result=await store.acquire(group.recovery_epoch,input.id,input.demands);
  // A missing epoch or conflicting cache cannot disprove an earlier acquire with a lost reply.
  // Keep the journal entry recoverable, just as multi-group admission does.
  if(!result.allowed&&(result.reason==='not_ready'||result.reason==='conflict'))return result;

  try{return await quotaTransaction(client,async tx=>{
   // Redis may have taken time. Recheck permission and configuration before issuing a proof.
   const current=await validateIntent(tx,input);
   if(current.coordination_domain||current.revision!==group.revision||current.recovery_epoch!==group.recovery_epoch)throw new DomainError('quota_revision_changed');
   const latest=(await tx.query('SELECT *,slot_heartbeat_until>now() AS slot_live FROM dispatch_admissions WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(!latest)throw new DomainError('quota_intent_missing');sameIntent(latest,input);
   if(latest.unused_at||latest.slot_released_at||latest.slot_unknown_at||(latest.state==='admitted'&&!latest.slot_live))throw new DomainError('quota_slot_lost');
   if(result.allowed&&existing.state!=='admitted'){
    const slots=(await tx.query(`SELECT count(*)::int count,min(slot_expires_at) earliest FROM dispatch_admissions WHERE group_id=$1 AND id<>$2 AND slot_released_at IS NULL AND slot_expires_at>now()`,[group.id,input.id])).rows[0];
    if(slots.count>=current.concurrency_limit||await backgroundSlotsFull(tx,current,input.request_id,input.id))throw new DomainError('quota_concurrency_changed');
    if(current.blocked_until&&new Date(current.blocked_until).getTime()>Date.now())throw new DomainError('quota_cooldown_changed');
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
   throw error;
  }
 });
}
export async function recordAdmissionIntent(pool:pg.Pool,input:AdmissionInput){
 return transaction(pool,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8192))',[input.group_id]);
  const group=await validateIntent(tx,input);
  const prior=(await tx.query('SELECT * FROM dispatch_admissions WHERE id=$1',[input.id])).rows[0];
  if(prior){sameIntent(prior,input);return}
  await tx.query("INSERT INTO dispatch_admissions(id,group_id,request_id,fencing_token,rules_revision,demands,state,rule_metrics) VALUES($1,$2,$3,$4,$5,$6,'intent',(SELECT COALESCE(jsonb_object_agg(key,metric),'{}'::jsonb) FROM provider_quota_rules WHERE group_id=$2)) ON CONFLICT(id) DO NOTHING",[input.id,input.group_id,input.request_id,input.fence,group.revision,JSON.stringify(input.demands)]);
 });
}
