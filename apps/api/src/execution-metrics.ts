import {authenticateRequest} from './request-principal.js';
import {executionNotificationEventTypes} from '../../../packages/notifications/src/index.js';
import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {transaction} from '../../../packages/db/src/index.js';
import {requireScopes} from '../../../packages/auth/src/index.js';
import {DomainError,type Clock} from '../../../packages/contracts/src/index.js';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {limiterSlotUsage} from '../../../packages/execution/src/limiter-slots.js';

export function registerExecutionMetrics(app:FastifyInstance,pool:pg.Pool,clock:Clock){
 app.get('/v1/admin/execution-metrics',request=>transaction(pool,async tx=>{
  const p=await authenticateRequest(tx,request);requireScopes(p,'operations:admin');
  if(p.account_ids)throw new DomainError('scope_denied','Application administrator required',403);
  const now=clock.now(),since=new Date(now.getTime()-86400000);
  const {rows}=await tx.query(`WITH selected AS MATERIALIZED (
   SELECT r.*,a.remote_job_id FROM execution_requests r
   LEFT JOIN execution_attempts a ON a.request_id=r.id AND a.number=r.attempt_count
   WHERE r.organization_id=$1 AND r.application_id=$2
    AND (r.execution_status IN ('queued','leased','submitting','running','waiting_retry','waiting_recovery','outcome_unknown','paused')
      OR (r.execution_status IN ('succeeded','failed','canceled','refused') AND r.financial_closed_at IS NULL AND r.settlement_status IN ('open','pending','unresolved'))
      OR r.first_dispatched_at>=$4 OR r.financial_closed_at>=$4)
  ), stats AS (
   SELECT queue_kind,
    count(*) FILTER(WHERE execution_status IN ('queued','waiting_retry','waiting_recovery'))::int AS waiting,
    count(*) FILTER(WHERE execution_status IN ('leased','submitting','running') AND lease_expires_at>$3)::int AS active_leases,
    count(*) FILTER(WHERE execution_status IN ('submitting','running'))::int AS running,
    count(*) FILTER(WHERE remote_job_id IS NOT NULL AND execution_status IN ('running','outcome_unknown'))::int AS remote_pending,
    count(*) FILTER(WHERE execution_status IN ('succeeded','failed','canceled','refused') AND financial_closed_at IS NULL AND settlement_status IN ('open','pending','unresolved'))::int AS unsettled_terminal,
    count(*) FILTER(WHERE execution_status='paused')::int AS paused,
    count(*) FILTER(WHERE execution_status='outcome_unknown')::int AS unknown,
    count(*) FILTER(WHERE execution_status IN ('queued','waiting_retry','waiting_recovery') AND reason='waiting_rate_limit')::int AS waiting_rate_limit,
    COALESCE(GREATEST(0,extract(epoch FROM ($3-min(enqueued_at) FILTER(WHERE execution_status IN ('queued','waiting_retry','waiting_recovery'))))),0)::float8 AS oldest_wait_seconds,
    COALESCE(GREATEST(0,extract(epoch FROM ($3-min(COALESCE(unresolved_at,created_at)) FILTER(WHERE execution_status='outcome_unknown')))),0)::float8 AS oldest_unknown_seconds,
    count(*) FILTER(WHERE first_dispatched_at>=$4)::int AS dispatch_samples_24h,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY GREATEST(0,extract(epoch FROM (first_dispatched_at-enqueued_at))*1000)) FILTER(WHERE first_dispatched_at>=$4)::float8 AS first_dispatch_wait_p50_ms,
    percentile_cont(0.95) WITHIN GROUP(ORDER BY GREATEST(0,extract(epoch FROM (first_dispatched_at-enqueued_at))*1000)) FILTER(WHERE first_dispatched_at>=$4)::float8 AS first_dispatch_wait_p95_ms,
    count(*) FILTER(WHERE execution_status='failed' AND financial_closed_at>=$4)::int AS failed_24h,
    count(*) FILTER(WHERE execution_status='canceled' AND reason='rate_limit_starved' AND financial_closed_at>=$4)::int AS rate_limit_starved_24h,
    count(*) FILTER(WHERE execution_status='canceled' AND reason='admission_timeout' AND financial_closed_at>=$4)::int AS admission_timeout_24h
   FROM selected GROUP BY queue_kind
  ), queue_latency AS (
   SELECT r.queue_kind,count(*)::int AS queue_wait_samples_24h,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY GREATEST(0,extract(epoch FROM (d.first_leased_at-d.due_at))*1000))::float8 AS ready_queue_wait_p50_ms,
    percentile_cont(0.95) WITHIN GROUP(ORDER BY GREATEST(0,extract(epoch FROM (d.first_leased_at-d.due_at))*1000))::float8 AS ready_queue_wait_p95_ms
   FROM execution_dispatches d JOIN execution_requests r ON r.id=d.request_id
   WHERE r.organization_id=$1 AND r.application_id=$2 AND d.first_leased_at>=$4 AND d.first_leased_at<=$3
   GROUP BY r.queue_kind
  ), http_stats AS (
   SELECT r.queue_kind,count(*)::int AS http_observations_24h,
    count(*) FILTER(WHERE h.status=429)::int AS http_429_observations_24h
   FROM provider_http_observations h JOIN execution_attempts a ON a.id=h.attempt_id JOIN execution_requests r ON r.id=a.request_id
   WHERE r.organization_id=$1 AND r.application_id=$2 AND h.received_at>=$4 AND h.received_at<=$3 GROUP BY r.queue_kind
  ), recovered AS (
   SELECT r.queue_kind,count(*)::int AS recovered_execute_deliveries_24h
   FROM execution_dispatches d JOIN execution_requests r ON r.id=d.request_id
   WHERE r.organization_id=$1 AND r.application_id=$2 AND d.recovered_at>=$4 AND d.recovered_at<=$3 GROUP BY r.queue_kind
  ), timeouts AS (
   SELECT r.queue_kind,count(*)::int AS attempt_timeouts_24h
   FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id
   WHERE r.organization_id=$1 AND r.application_id=$2 AND a.timed_out_at>=$4 AND a.timed_out_at<=$3 GROUP BY r.queue_kind
  ), unpublished AS (
   SELECT r.queue_kind,count(*)::int AS unpublished_due,
    GREATEST(0,extract(epoch FROM ($3-min(d.due_at))))::float8 AS oldest_unpublished_seconds
   FROM selected r JOIN execution_dispatches d ON d.request_id=r.id AND d.generation=r.dispatch_generation
   WHERE r.execution_backend='bullmq' AND r.execution_status IN ('queued','waiting_retry','waiting_recovery')
    AND d.published_at IS NULL AND d.due_at<=$3 GROUP BY r.queue_kind
  ) SELECT k.queue_kind,COALESCE(s.waiting,0) waiting,COALESCE(s.active_leases,0) active_leases,
   COALESCE(s.running,0) running,COALESCE(s.remote_pending,0) remote_pending,COALESCE(s.paused,0) paused,
   COALESCE(s.unsettled_terminal,0) unsettled_terminal,COALESCE(s.unknown,0) unknown,COALESCE(s.waiting_rate_limit,0) waiting_rate_limit,
   COALESCE(s.oldest_wait_seconds,0) oldest_wait_seconds,COALESCE(s.oldest_unknown_seconds,0) oldest_unknown_seconds,
   COALESCE(s.dispatch_samples_24h,0) dispatch_samples_24h,s.first_dispatch_wait_p50_ms,s.first_dispatch_wait_p95_ms,
   COALESCE(q.queue_wait_samples_24h,0) queue_wait_samples_24h,q.ready_queue_wait_p50_ms,q.ready_queue_wait_p95_ms,
   COALESCE(h.http_observations_24h,0) http_observations_24h,COALESCE(h.http_429_observations_24h,0) http_429_observations_24h,
   COALESCE(rec.recovered_execute_deliveries_24h,0) recovered_execute_deliveries_24h,COALESCE(s.failed_24h,0) failed_24h,COALESCE(s.rate_limit_starved_24h,0) rate_limit_starved_24h,COALESCE(s.admission_timeout_24h,0) admission_timeout_24h,COALESCE(t.attempt_timeouts_24h,0) attempt_timeouts_24h,COALESCE(u.unpublished_due,0) unpublished_due,
   COALESCE(u.oldest_unpublished_seconds,0) oldest_unpublished_seconds
  FROM unnest(ARRAY['text','image','audio','tools']) k(queue_kind)
  LEFT JOIN stats s USING(queue_kind) LEFT JOIN queue_latency q USING(queue_kind) LEFT JOIN http_stats h USING(queue_kind) LEFT JOIN recovered rec USING(queue_kind) LEFT JOIN timeouts t USING(queue_kind) LEFT JOIN unpublished u USING(queue_kind)`,[p.organization_id,p.application_id,now,since]);
  const notificationOutbox=(await tx.query(`SELECT count(*)::int AS pending,
   COALESCE(GREATEST(0,extract(epoch FROM ($3-min(e.occurred_at)))),0)::float8 AS oldest_pending_seconds
   FROM outbox_events e LEFT JOIN notification_event_consumption c ON c.event_id=e.id
   WHERE e.organization_id=$1 AND e.application_id=$2 AND e.type=ANY($4::text[])
    AND c.event_id IS NULL AND e.occurred_at<=$3`,[p.organization_id,p.application_id,now,executionNotificationEventTypes])).rows[0];
  const settlementErrors=(await tx.query(`SELECT count(*)::int AS total_24h,
   count(*) FILTER(WHERE error_kind='domain')::int AS domain_24h,
   count(*) FILTER(WHERE error_kind='infrastructure')::int AS infrastructure_24h
   FROM execution_settlement_errors WHERE organization_id=$1 AND application_id=$2
    AND occurred_at>=$3 AND occurred_at<=$4`,[p.organization_id,p.application_id,since,now])).rows[0];
  const installation=process.env.UAI_INSTALLATION_ID;
  const workerSample=installation?(await tx.query('SELECT clock_timestamp() AS sampled_at')).rows[0].sampled_at as Date:null;
  const workers=installation?{scope:'installation',sampled_at:workerSample!.toISOString(),freshness_seconds:45,data:(await tx.query(`
   WITH live AS MATERIALIZED (
    SELECT * FROM execution_worker_heartbeats WHERE installation_id=$1 AND heartbeat_at>$2::timestamptz-interval '45 seconds' AND heartbeat_at<=$2 AND state<>'stopped'
   ), admission_latency AS (
    SELECT queue_kind,count(*)::int AS samples,
     percentile_cont(0.5) WITHIN GROUP(ORDER BY value::float8)::float8 AS p50_ms,
     percentile_cont(0.95) WITHIN GROUP(ORDER BY value::float8)::float8 AS p95_ms
    FROM live CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(telemetry->'admission_ms','[]'::jsonb)) GROUP BY queue_kind
   )
   SELECT k.queue_kind,
    COALESCE(max(a.samples),0)::int AS admission_samples,max(a.p50_ms) AS admission_p50_ms,max(a.p95_ms) AS admission_p95_ms,
    COALESCE(sum((w.telemetry->>'admission_denied')::int) FILTER(WHERE (w.worker_id,w.queue_kind) IN (SELECT worker_id,queue_kind FROM live)),0)::int AS admission_denied,
    COALESCE(sum((w.telemetry->>'admission_errors')::int) FILTER(WHERE (w.worker_id,w.queue_kind) IN (SELECT worker_id,queue_kind FROM live)),0)::int AS admission_errors,
    percentile_cont(0.95) WITHIN GROUP(ORDER BY (w.telemetry->'db'->>'ms')::float8) FILTER(WHERE (w.worker_id,w.queue_kind) IN (SELECT worker_id,queue_kind FROM live) AND w.telemetry->'db'->>'state'='ok')::float8 AS db_probe_p95_ms,
    percentile_cont(0.95) WITHIN GROUP(ORDER BY (w.telemetry->'redis'->>'ms')::float8) FILTER(WHERE (w.worker_id,w.queue_kind) IN (SELECT worker_id,queue_kind FROM live) AND w.telemetry->'redis'->>'state'='ok')::float8 AS redis_probe_p95_ms,
    count(*) FILTER(WHERE (w.worker_id,w.queue_kind) IN (SELECT worker_id,queue_kind FROM live) AND w.telemetry->'db'->>'state'='failed')::int AS db_probe_failures,
    count(*) FILTER(WHERE (w.worker_id,w.queue_kind) IN (SELECT worker_id,queue_kind FROM live) AND w.telemetry->'redis'->>'state'='failed')::int AS redis_probe_failures,
    count(w.worker_id) FILTER(WHERE w.heartbeat_at>$2::timestamptz-interval '45 seconds' AND w.state<>'stopped')::int AS alive_workers,
    count(w.worker_id) FILTER(WHERE w.heartbeat_at>$2::timestamptz-interval '45 seconds' AND w.state='draining')::int AS draining_workers,
    count(w.worker_id) FILTER(WHERE w.heartbeat_at<=$2::timestamptz-interval '45 seconds' AND w.state<>'stopped')::int AS stale_workers,
    COALESCE(sum(w.concurrency) FILTER(WHERE w.heartbeat_at>$2::timestamptz-interval '45 seconds' AND w.state='running'),0)::int AS configured_concurrency,
    COALESCE(sum(w.active_jobs) FILTER(WHERE w.heartbeat_at>$2::timestamptz-interval '45 seconds' AND w.state<>'stopped'),0)::int AS active_jobs
   FROM unnest(ARRAY['text','image','audio','tools','observe','maintenance']) k(queue_kind)
   LEFT JOIN execution_worker_heartbeats w ON w.queue_kind=k.queue_kind AND w.installation_id=$1
    AND w.heartbeat_at>=$2::timestamptz-interval '24 hours' AND w.heartbeat_at<=$2
   LEFT JOIN admission_latency a ON a.queue_kind=k.queue_kind
   GROUP BY k.queue_kind ORDER BY k.queue_kind`,[installation,workerSample])).rows}:null;
  const limiters=await limiterSlotUsage(tx,p,now);
  return apiSchemas.ExecutionMetricsResponse.parse({sampled_at:now.toISOString(),window_start:since.toISOString(),data:rows,limiters,workers,notification_outbox:notificationOutbox,settlement_errors:settlementErrors});
 }));
}
