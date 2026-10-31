import {hash} from '../../contracts/src/index.js';
import type {SqlExecutor,Tx} from '../../db/src/index.js';
import {validLimitUsage} from '../../providers/src/limit-usage.js';
import type {QuotaStore} from './quota.js';

/**
 * Reported usage against each admitted demand: an excess is added to the window, the unused part is given back.
 * The original admission fingerprint stays intact. One final report per attempt is expected; a refund is recorded once.
 */
export async function recordQuotaUsage(tx:Tx,admissionIds:string[],reported:unknown,observedAt:Date|string|undefined){
 const counters=validLimitUsage(reported);if(!counters)return [];
 const admissions=(await tx.query("SELECT * FROM dispatch_admissions WHERE id=ANY($1::text[]) AND state='admitted' ORDER BY group_id,id",[admissionIds])).rows;
 const groupIds=[...new Set(admissions.map(a=>a.group_id))];
 // No group lock: recording is idempotent per admission and rule, and applying it waits for an open Redis gate.
 for(const admission of admissions)for(const demand of admission.demands){
  const metric=admission.rule_metrics[demand.key] as keyof typeof counters|undefined;
  const actual=metric?counters[metric]:undefined;if(actual===undefined||actual===demand.amount)continue;
  if(actual<demand.amount){
   await tx.query(`INSERT INTO quota_usage_refunds(admission_id,rule_key,group_id,admitted_units,actual_units,window_ms,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now())) ON CONFLICT DO NOTHING`,[admission.id,demand.key,admission.group_id,String(demand.amount),String(actual),demand.window_ms,observedAt??null]);
   continue;
  }
  const prior=(await tx.query('SELECT max(reported_units)::text AS units FROM quota_usage_adjustments WHERE admission_id=$1 AND rule_key=$2',[admission.id,demand.key])).rows[0].units;
  const previous=Math.max(demand.amount,prior===null?0:Number(prior));if(actual<=previous)continue;
  const adjustmentId=`qextra-${hash([admission.id,demand.key,actual])}`;
  await tx.query(`INSERT INTO quota_usage_adjustments(id,group_id,admission_id,rule_key,reported_units,delta_units,window_ms,observed_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now())) ON CONFLICT DO NOTHING`,[adjustmentId,admission.group_id,admission.id,demand.key,String(actual),String(actual-previous),demand.window_ms,observedAt??null]);
 }
 return (await tx.query('SELECT * FROM provider_quota_groups WHERE id=ANY($1::text[]) ORDER BY id',[groupIds])).rows;
}

/** Acquisition calls this under its existing group lock, before issuing new permits; recovery calls it after restoring admissions, for facts still inside their windows. */
export async function applyQuotaUsage(db:SqlExecutor,store:QuotaStore,group:{id:string;recovery_epoch:string},restore=false){
 const rows=(await db.query(`SELECT * FROM quota_usage_adjustments WHERE group_id=$1
  AND observed_at>now()-interval '25 hours' AND ($2 OR applied_at IS NULL)
  AND (NOT $2 OR observed_at>now()-(window_ms+60000)*interval '1 millisecond') ORDER BY observed_at,id`,[group.id,restore])).rows;
 for(const row of rows){
  const applied=await store.applyExcess(group.recovery_epoch,row.id,{key:row.rule_key,amount:Number(row.delta_units),window_ms:row.window_ms},new Date(row.observed_at).getTime(),restore);
  if(!applied)throw new Error('quota_adjustment_not_ready');
  await db.query('UPDATE quota_usage_adjustments SET applied_at=COALESCE(applied_at,now()) WHERE id=$1',[row.id]);
 }
 const refunds=(await db.query(`SELECT * FROM quota_usage_refunds WHERE group_id=$1
  AND observed_at>now()-interval '25 hours' AND ($2 OR applied_at IS NULL)
  AND (NOT $2 OR observed_at>now()-(window_ms+60000)*interval '1 millisecond') ORDER BY observed_at,admission_id,rule_key`,[group.id,restore])).rows;
 for(const row of refunds){
  if(!await store.refund(group.recovery_epoch,row.admission_id,{key:row.rule_key,admitted:Number(row.admitted_units),actual:Number(row.actual_units)},restore))throw new Error('quota_adjustment_not_ready');
  await db.query('UPDATE quota_usage_refunds SET applied_at=COALESCE(applied_at,now()) WHERE admission_id=$1 AND rule_key=$2',[row.admission_id,row.rule_key]);
 }
}
