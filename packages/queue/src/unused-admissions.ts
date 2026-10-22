import type {SqlExecutor} from '../../db/src/index.js';
import {QuotaStore} from './quota.js';

/** Caller holds this group's admission lock. PostgreSQL already invalidated the old request fence. */
export async function refundUnusedAdmissions(db:SqlExecutor,store:QuotaStore,group:{id:string;recovery_epoch:string}){
 const rows=(await db.query(`SELECT id,demands FROM dispatch_admissions WHERE group_id=$1
  AND unused_at IS NOT NULL AND unused_refunded_at IS NULL ORDER BY unused_at,id`,[group.id])).rows;
 for(const row of rows){
  // ZREM/DEL are idempotent. A lost reply or SQL rollback leaves a retryable proof.
  // Provider observations are not increased: a header may already exclude this request.
  if(!await QuotaStore.discardUnsentMany([{store,epoch:group.recovery_epoch,admissionId:row.id,demands:row.demands}]))throw new Error('unused_quota_refund_not_ready');
  await db.query('UPDATE dispatch_admissions SET unused_refunded_at=COALESCE(unused_refunded_at,now()) WHERE id=$1',[row.id]);
 }
}
