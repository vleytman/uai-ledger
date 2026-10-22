import {apiSchemas} from '../../../packages/contracts/api.js';
import {DomainError,type Clock} from '../../../packages/contracts/src/index.js';
import {accountScope,type Principal} from '../../../packages/auth/src/index.js';
import type {Tx} from '../../../packages/db/src/index.js';
export const overviewQuery=apiSchemas.AdminOverviewQuery.refine(q=>!q.period_start||!q.period_end||Date.parse(q.period_start)<Date.parse(q.period_end),{message:'period_start must precede period_end'});

/** A request-created cohort, not a provider accounting-period reconciliation report. */
export async function getAdminOverview(tx:Tx,p:Principal,clock:Clock,query:unknown,operationId?:string){
 const filters=overviewQuery.parse(query);
 if(filters.application_id&&filters.application_id!==p.application_id)throw new DomainError('scope_denied','Application filter is outside token scope',403);
 if(filters.account_id)await accountScope(tx,p,filters.account_id);
 const v=[p.organization_id,p.application_id,filters.account_id??null,filters.model??null,filters.provider??null,filters.period_start??null,filters.period_end??null,clock.now(),operationId??null];
 const result=(await tx.query(`
 WITH cohort AS MATERIALIZED (
  SELECT r.* FROM execution_requests r WHERE r.organization_id=$1 AND r.application_id=$2
   AND ($9::text IS NULL OR r.operation_id=$9)
   AND ($3::text IS NULL OR r.account_id=$3) AND ($6::timestamptz IS NULL OR r.created_at>=$6) AND ($7::timestamptz IS NULL OR r.created_at<$7)
 ), matching_attempts AS MATERIALIZED (
  SELECT a.* FROM execution_attempts a JOIN cohort r ON r.id=a.request_id
  LEFT JOIN provider_connections c ON c.id=a.variant->>'connection_id' AND c.organization_id=$1 AND c.application_id=$2
  WHERE ($4::text IS NULL OR a.variant->>'model'=$4) AND ($5::text IS NULL OR c.provider=$5)
 ), selected_requests AS MATERIALIZED (
  SELECT r.* FROM cohort r WHERE EXISTS(SELECT 1 FROM matching_attempts a WHERE a.request_id=r.id)
   OR (NOT EXISTS(SELECT 1 FROM execution_attempts a WHERE a.request_id=r.id) AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(jsonb_build_array(r.route->'primary',r.route->'fallback')) t
    LEFT JOIN provider_connections c ON c.id=t->>'connection_id' AND c.organization_id=$1 AND c.application_id=$2
    WHERE ($4::text IS NULL OR t->>'model'=$4) AND ($5::text IS NULL OR c.provider=$5)
   ))
 ), selected_operations AS MATERIALIZED (
  SELECT o.*,b.captured_units,b.max_units-b.captured_units-b.released_units remaining_units FROM operations o JOIN reservations b ON b.operation_id=o.id
  WHERE o.organization_id=$1 AND o.application_id=$2 AND ($3::text IS NULL OR o.account_id=$3)
   AND ($9::text IS NULL OR o.id=$9)
   AND (EXISTS(SELECT 1 FROM selected_requests r WHERE r.operation_id=o.id) OR (
    NOT EXISTS(SELECT 1 FROM execution_requests r WHERE r.operation_id=o.id)
    AND ($6::timestamptz IS NULL OR o.created_at>=$6) AND ($7::timestamptz IS NULL OR o.created_at<$7)
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.components) component
     CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(component->'route'->'primary',component->'route'->'fallback')) t
     LEFT JOIN provider_connections c ON c.id=t->>'connection_id' AND c.organization_id=$1 AND c.application_id=$2
     WHERE ($4::text IS NULL OR t->>'model'=$4) AND ($5::text IS NULL OR c.provider=$5))
   ))
 ), latest_costs AS MATERIALIZED (
  SELECT DISTINCT ON(c.attempt_id,c.currency) c.* FROM provider_cost_entries c JOIN matching_attempts a ON a.id=c.attempt_id
  LEFT JOIN provider_usage_observations u ON u.id=c.observation_id AND u.organization_id=$1 AND u.application_id=$2
  WHERE c.organization_id=$1 AND c.application_id=$2 AND c.entry_type='original' ORDER BY c.attempt_id,c.currency,c.priced_at DESC,u.revision DESC NULLS LAST,CASE c.state WHEN 'unknown' THEN 2 WHEN 'provisional' THEN 1 ELSE 0 END,c.id DESC
 ), cost_rows AS MATERIALIZED (
  SELECT c.attempt_id,c.currency,c.rounded_units,c.state FROM latest_costs c
  UNION ALL SELECT c.attempt_id,d.currency,d.rounded_units,d.state FROM provider_cost_entries d JOIN latest_costs c ON c.id=d.correction_of
   WHERE d.organization_id=$1 AND d.application_id=$2 AND d.account_id=c.account_id AND d.entry_type='adjustment'
  UNION ALL SELECT a.id,'USD',a.cost_units,CASE WHEN a.cost_units IS NULL THEN 'unknown' ELSE 'calculated' END FROM matching_attempts a
   WHERE NOT EXISTS(SELECT 1 FROM latest_costs c WHERE c.attempt_id=a.id)
 ), currency_totals AS (
  SELECT currency,COALESCE(sum(rounded_units),0)::text known_units,count(*) FILTER(WHERE state='unknown')::int unknown_count,
   count(*) FILTER(WHERE state='provisional')::int provisional_count FROM cost_rows GROUP BY currency
 ), operation_rows AS (
  SELECT o.id,o.account_id,o.created_at,o.admission_status,o.settlement_status,o.captured_units::text captured_units,o.remaining_units::text reserved_units,
   CASE WHEN EXISTS(SELECT 1 FROM execution_requests r WHERE r.operation_id=o.id AND r.execution_status NOT IN('succeeded','failed','canceled','refused')) THEN 'running'
    WHEN o.admission_status='open' THEN 'accepted' WHEN o.closed_reason='cancel' THEN 'canceled'
    WHEN EXISTS(SELECT 1 FROM execution_requests r WHERE r.operation_id=o.id AND r.execution_status='succeeded') AND EXISTS(SELECT 1 FROM execution_requests r WHERE r.operation_id=o.id AND r.execution_status<>'succeeded') THEN 'partial'
    WHEN EXISTS(SELECT 1 FROM execution_requests r WHERE r.operation_id=o.id AND r.execution_status='failed') THEN 'failed'
    WHEN EXISTS(SELECT 1 FROM execution_requests r WHERE r.operation_id=o.id AND r.execution_status='canceled') THEN 'canceled'
    ELSE 'completed' END execution_status
  FROM selected_operations o ORDER BY o.created_at DESC,o.id LIMIT 20
 ), related_resources AS (
  SELECT id FROM selected_requests UNION SELECT id FROM selected_operations UNION SELECT id FROM matching_attempts UNION SELECT variant->>'connection_id' FROM matching_attempts
 ), incident_rows AS (
  SELECT n.id,n.signal,n.state,n.severity,n.resource_id,n.first_seen,n.last_seen FROM notification_incidents n
  WHERE n.organization_id=$1 AND n.application_id=$2 AND ($6::timestamptz IS NULL OR n.first_seen>=$6) AND ($7::timestamptz IS NULL OR n.first_seen<$7)
   AND (($3::text IS NULL AND $4::text IS NULL AND $5::text IS NULL) OR n.resource_id IN(SELECT id FROM related_resources))
  ORDER BY n.last_seen DESC,n.id LIMIT 20
 )
 SELECT COALESCE((SELECT known_units FROM currency_totals WHERE currency='USD'),'0') known_units,
  (SELECT count(*) FILTER(WHERE state='unknown')::int FROM cost_rows) unknown_count,
  (SELECT count(*) FILTER(WHERE state='provisional')::int FROM cost_rows) provisional_count,
  (SELECT count(*)::int FROM request_budget_claims c JOIN selected_requests r ON r.id=c.request_id WHERE c.status='open') unsettled_request_count,
  (SELECT COALESCE(sum(c.charged_units),0)::text FROM request_budget_claims c JOIN selected_requests r ON r.id=c.request_id) charged_units,
  (SELECT COALESCE(sum(c.rounded_units),0)::text FROM cost_rows c JOIN matching_attempts a ON a.id=c.attempt_id WHERE c.currency='USD' AND a.charged_units=0) platform_funded_units,
  (SELECT COALESCE(sum(e.reserved_units),0)::text FROM execution_exposures e JOIN matching_attempts a ON a.id=e.attempt_id WHERE e.kind='provider' AND e.state='open') unresolved_exposure_units,
  (SELECT COALESCE(sum(remaining_units),0)::text FROM selected_operations) active_reserved_units,
  (SELECT COALESCE(sum(c.max_units),0)::text FROM request_budget_claims c JOIN selected_requests r ON r.id=c.request_id WHERE c.status='open') active_request_claim_units,
  (SELECT jsonb_build_object('total',count(*)::int,'queued',count(*) FILTER(WHERE execution_status IN('queued','leased','waiting_retry','waiting_recovery'))::int,
   'unknown',count(*) FILTER(WHERE execution_status='outcome_unknown')::int,'paused',count(*) FILTER(WHERE execution_status='paused')::int,
   'active',count(*) FILTER(WHERE execution_status IN('submitting','running'))::int,'failed',count(*) FILTER(WHERE execution_status='failed')::int,
   'succeeded',count(*) FILTER(WHERE execution_status='succeeded')::int) FROM selected_requests) counts,
  (SELECT COALESCE(GREATEST(0,EXTRACT(EPOCH FROM ($8::timestamptz-min(enqueued_at)))),0)::double precision FROM selected_requests WHERE execution_status IN('queued','leased','waiting_retry','waiting_recovery')) queue_oldest_age_seconds,
  (SELECT jsonb_build_object('total',count(*)::int,'open',count(*) FILTER(WHERE admission_status='open')::int,'settled',count(*) FILTER(WHERE settlement_status='settled')::int) FROM selected_operations) operations,
  COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY currency) FROM currency_totals c),'[]'::jsonb) provider_cost_totals,
  COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY created_at DESC,id) FROM operation_rows o),'[]'::jsonb) recent_operations,
  COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY last_seen DESC,id) FROM incident_rows i),'[]'::jsonb) recent_incidents
 `,v)).rows[0];
 return {...result,filters:{...filters,application_id:p.application_id},currency:'USD',period_basis:'request_created_at',cost_basis:'matching_attempts_latest_cost',charge_basis:'selected_requests_once',reservation_basis:'selected_operations_full_reserve',incident_period_basis:'first_seen',cost_precision:result.unknown_count?'partial':result.provisional_count?'provisional':'known',customer_charge_precision:result.unsettled_request_count?'partial':'settled',platform_funded_precision:result.unknown_count||result.unsettled_request_count?'partial':'known'};
}
