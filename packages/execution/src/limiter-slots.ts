import type {SqlExecutor} from '../../db/src/index.js';
import {unknownSlotHeld} from './index.js';

export interface LimiterSlotUsage {limiter_key:string;concurrency_limit:number;held_slots:number;unknown_held_slots:number;oldest_unknown_held_seconds:number}
/** Concurrency slots of legacy limiters as permitLimit counts them, including slots held by unknown outcomes.
 * Limiters are organization-wide; this lists those the application's published routes or active attempts use. */
export async function limiterSlotUsage(tx:SqlExecutor,scope:{organization_id:string;application_id:string},now:Date):Promise<LimiterSlotUsage[]>{
 return (await tx.query(`SELECT l.limiter_key,l.concurrency_limit,
   count(s.id) FILTER(WHERE s.status IN ('submitting','running') OR s.unknown_held)::int AS held_slots,
   count(s.id) FILTER(WHERE s.unknown_held)::int AS unknown_held_slots,
   COALESCE(GREATEST(0,extract(epoch FROM ($3-min(s.unknown_since) FILTER(WHERE s.unknown_held)))),0)::float8 AS oldest_unknown_held_seconds
  FROM execution_limiters l
  LEFT JOIN LATERAL (
   SELECT a.id,a.status,${unknownSlotHeld('a','q','$3')} AS unknown_held,COALESCE(q.unresolved_at,a.created_at) AS unknown_since
   FROM execution_attempts a JOIN execution_requests q ON q.id=a.request_id
   WHERE q.organization_id=l.organization_id AND a.variant->>'limiter_key'=l.limiter_key AND a.status IN ('submitting','running','outcome_unknown')
  ) s ON true
  WHERE l.organization_id=$1 AND (
   EXISTS(SELECT 1 FROM configuration_versions c WHERE c.organization_id=$1 AND c.application_id=$2 AND c.kind='route' AND c.status='published' AND (c.payload->'primary'->>'limiter_key'=l.limiter_key OR c.payload->'fallback'->>'limiter_key'=l.limiter_key))
   OR EXISTS(SELECT 1 FROM execution_attempts a JOIN execution_requests q ON q.id=a.request_id WHERE q.organization_id=$1 AND q.application_id=$2 AND a.variant->>'limiter_key'=l.limiter_key AND a.status IN ('submitting','running','outcome_unknown')))
  GROUP BY l.limiter_key,l.concurrency_limit ORDER BY l.limiter_key`,[scope.organization_id,scope.application_id,now])).rows;
}
