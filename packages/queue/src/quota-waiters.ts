import type {SqlExecutor} from '../../db/src/index.js';

/** A refused call comes back at least this often, even when no wake-up reaches it. */
export const QUOTA_RETRY_CEILING_MS=5000;

/**
 * Capacity of these groups may have freed (a released slot, a refund, an admission): calls waiting for them
 * retry now instead of at the time their refusal computed. Only the oldest waiters whose demands together
 * fit the rule are woken, in enqueue order, so a wake-up does not send every waiter at once.
 */
export async function wakeQuotaWaiters(db:SqlExecutor,groupIds:string[]){
 if(!groupIds.length)return 0;
 const woken=(await db.query(`WITH waiting AS (
   SELECT r.id,r.dispatch_generation,r.not_before,(r.quota_wait->>'demand')::numeric AS demand,(r.quota_wait->>'capacity')::numeric AS capacity,
    sum((r.quota_wait->>'demand')::numeric) OVER (PARTITION BY r.quota_wait->>'group_id',r.quota_wait->>'rule' ORDER BY r.enqueued_at,r.id) AS cumulative
   FROM execution_requests r
   WHERE r.execution_backend='bullmq' AND r.execution_status='waiting_retry' AND r.reason='waiting_rate_limit'
    AND r.quota_wait->>'group_id'=ANY($1::text[]) AND r.cancel_requested_at IS NULL AND r.deadline_at>now()
  ), woken AS (
   UPDATE execution_requests r SET not_before=now() FROM waiting w
   WHERE r.id=w.id AND w.not_before>now() AND (w.cumulative<=w.capacity OR w.cumulative=w.demand)
    AND r.execution_status='waiting_retry' AND r.dispatch_generation=w.dispatch_generation RETURNING r.id,r.dispatch_generation
  )
  UPDATE execution_dispatches d SET reconcile_after=now() FROM woken w WHERE d.request_id=w.id AND d.generation=w.dispatch_generation RETURNING d.request_id`,[groupIds])).rowCount??0;
 if(woken)await db.query("SELECT pg_notify('uai_scheduler','')");
 return woken;
}
