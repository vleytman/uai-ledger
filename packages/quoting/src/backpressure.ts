import {defaultAdmissionLimits} from './admission-policy.js';
import {DomainError,type Clock,type Scope} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';

/** Called inside admission's transaction, before any reserve or reserve increase. */
export async function checkAdmissionBackpressure(tx:Tx,scope:Scope,clock:Clock,additionalCalls:number){
 if(additionalCalls<=0)return;
 // Approved initial policy, created only when the distributed backend is enabled.
 if(process.env.UAI_EXECUTION_BACKEND==='bullmq')await tx.query(`INSERT INTO execution_admission_policies(organization_id,application_id,account_limit,application_limit,max_queue_age_ms)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[scope.organization_id,scope.application_id,defaultAdmissionLimits.account_limit,defaultAdmissionLimits.application_limit,defaultAdmissionLimits.max_queue_age_ms]);
 // Legacy applications without an explicit policy retain their admission behavior.
 // Serialize admissions across accounts in this application, not the installation.
 const policy=(await tx.query('SELECT * FROM execution_admission_policies WHERE organization_id=$1 AND application_id=$2 FOR UPDATE',[scope.organization_id,scope.application_id])).rows[0];
 if(!policy)return;
 const rows=(await tx.query(`WITH queued AS (
  SELECT account_id,count(*)::bigint AS waiting,min(enqueued_at) AS oldest
  FROM execution_requests WHERE organization_id=$1 AND application_id=$2
   AND execution_status IN ('queued','waiting_retry','waiting_recovery') GROUP BY account_id
 ), authorized AS (
  SELECT o.account_id,sum(GREATEST((SELECT sum((c->>'count_resolved')::bigint) FROM jsonb_array_elements(o.components) c)
   -(SELECT count(*) FROM execution_requests r WHERE r.operation_id=o.id),0)) AS waiting
  FROM operations o WHERE o.organization_id=$1 AND o.application_id=$2
   AND o.admission_status='open' AND o.deadline_at>$3 GROUP BY o.account_id
 ) SELECT COALESCE(q.account_id,a.account_id) AS account_id,COALESCE(q.waiting,0)+COALESCE(a.waiting,0) AS waiting,q.oldest
 FROM queued q FULL JOIN authorized a ON q.account_id=a.account_id`,[scope.organization_id,scope.application_id,clock.now()])).rows;
 const own=rows.find(row=>row.account_id===scope.account_id),account=Number(own?.waiting??0);
 const application=rows.reduce((sum,row)=>sum+Number(row.waiting),0);
 const oldest=rows.reduce((min,row)=>row.oldest?Math.min(min,new Date(row.oldest).getTime()):min,Infinity);
 const reason=account+additionalCalls>policy.account_limit?'account_backlog':application+additionalCalls>policy.application_limit?'application_backlog':clock.now().getTime()-oldest>=policy.max_queue_age_ms?'queue_age':null;
 if(reason)throw new DomainError('queue_backpressure','Queue is busy; retry this operation later',429,{reason,account_waiting:account,application_waiting:application,requested_calls:additionalCalls,retry_after_seconds:5});
}
