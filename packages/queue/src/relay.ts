import type pg from 'pg';
import {transaction} from '../../db/src/index.js';
import {id} from '../../contracts/src/index.js';
import {ExecutionTransport,type QueueKind} from './transport.js';

/** Shared with the mock backlog profiler so EXPLAIN covers the actual selection query. */
export const dispatchCandidateSql=`WITH outstanding AS MATERIALIZED (
    SELECT r.organization_id,r.application_id,r.account_id FROM execution_dispatches d
    JOIN execution_requests r ON r.id=d.request_id AND r.dispatch_generation=d.generation
    WHERE d.queue_kind=$1 AND d.selected_at IS NOT NULL AND r.execution_backend='bullmq'
     AND r.execution_status IN ('queued','waiting_retry','waiting_recovery','leased','submitting','running')
   ), account_counts AS (
    SELECT organization_id,application_id,account_id,count(*) AS n FROM outstanding GROUP BY organization_id,application_id,account_id
   ), application_counts AS (
    SELECT organization_id,application_id,count(*) AS n FROM outstanding GROUP BY organization_id,application_id
   )
   , replayable AS MATERIALIZED (
    SELECT * FROM execution_dispatches WHERE queue_kind=$1 AND selected_at IS NOT NULL AND published_at IS NULL
     AND (lease_until IS NULL OR lease_until<now()) AND due_at<=now()
   ), replay_accounts AS (
    SELECT DISTINCT r.organization_id,r.application_id,r.account_id FROM replayable d
    JOIN execution_requests r ON r.id=d.request_id AND r.dispatch_generation=d.generation
    WHERE r.execution_backend='bullmq' AND r.execution_status IN ('queued','waiting_retry','waiting_recovery')
     AND r.not_before<=now() AND r.deadline_at>now() AND r.cancel_requested_at IS NULL
   )
   SELECT f.*,COALESCE(ac.n,0)<$2 AND COALESCE(ap.n,0)<$3 AND (SELECT count(*) FROM outstanding)<$4 AS allow_new
   FROM execution_dispatch_fairness f
   LEFT JOIN account_counts ac USING(organization_id,application_id,account_id)
   LEFT JOIN application_counts ap USING(organization_id,application_id)
   LEFT JOIN replay_accounts ra USING(organization_id,application_id,account_id)
   WHERE f.queue_kind=$1 AND (ra.account_id IS NOT NULL OR (
    COALESCE(ac.n,0)<$2 AND COALESCE(ap.n,0)<$3 AND (SELECT count(*) FROM outstanding)<$4
    AND EXISTS(SELECT 1 FROM execution_requests r WHERE r.queue_kind=$1
     AND r.organization_id=f.organization_id AND r.application_id=f.application_id AND r.account_id=f.account_id
     AND r.execution_backend='bullmq' AND r.execution_status IN ('queued','waiting_retry','waiting_recovery')
     AND r.not_before<=now() AND r.deadline_at>now() AND r.cancel_requested_at IS NULL)
   )) ORDER BY f.last_served_at,f.organization_id,f.application_id,f.account_id`;

/** Concrete scope parameters let PostgreSQL plan the ordered lookup using account statistics. */
export const dispatchRequestSql=`SELECT d.*,r.organization_id,r.application_id,r.account_id
 FROM execution_requests r JOIN execution_dispatches d ON d.request_id=r.id AND d.generation=r.dispatch_generation
 WHERE r.queue_kind=$1 AND r.organization_id=$2 AND r.application_id=$3 AND r.account_id=$4
 AND r.execution_backend='bullmq' AND r.execution_status IN ('queued','waiting_retry','waiting_recovery')
 AND r.not_before<=now() AND r.deadline_at>now() AND r.cancel_requested_at IS NULL
 AND d.published_at IS NULL AND (d.lease_until IS NULL OR d.lease_until<now()) AND d.due_at<=now()
 AND ($5::boolean OR d.selected_at IS NOT NULL)
 AND (r.priority<>0 OR d.selected_at IS NOT NULL OR EXISTS (
  SELECT 1 FROM execution_dispatch_policies p WHERE p.queue_kind=$1 AND (
   SELECT count(*) FROM execution_dispatches held JOIN execution_requests q ON q.id=held.request_id AND q.dispatch_generation=held.generation
   WHERE held.queue_kind=$1 AND held.selected_at IS NOT NULL AND q.priority=0 AND q.execution_backend='bullmq'
    AND q.execution_status IN ('queued','waiting_retry','waiting_recovery','leased','submitting','running')
  )<GREATEST(1,p.queue_limit-p.interactive_reserve) AND (
   SELECT count(*) FROM execution_dispatches held JOIN execution_requests q ON q.id=held.request_id AND q.dispatch_generation=held.generation
   WHERE held.queue_kind=$1 AND held.selected_at IS NOT NULL AND q.priority=0 AND q.execution_backend='bullmq'
    AND q.organization_id=$2 AND q.application_id=$3
    AND q.execution_status IN ('queued','waiting_retry','waiting_recovery','leased','submitting','running')
  )<GREATEST(1,p.application_limit-p.interactive_reserve) AND (
   SELECT count(*) FROM execution_dispatches held JOIN execution_requests q ON q.id=held.request_id AND q.dispatch_generation=held.generation
   WHERE held.queue_kind=$1 AND held.selected_at IS NOT NULL AND q.priority=0 AND q.execution_backend='bullmq'
    AND q.organization_id=$2 AND q.application_id=$3 AND q.account_id=$4
    AND q.execution_status IN ('queued','waiting_retry','waiting_recovery','leased','submitting','running')
  )<GREATEST(1,p.account_limit-p.interactive_reserve)
 ))
 ORDER BY (r.priority::numeric*60)-EXTRACT(EPOCH FROM (r.enqueued_at AT TIME ZONE 'UTC')) DESC,r.enqueued_at,r.id
 LIMIT 1 FOR UPDATE OF d SKIP LOCKED`;

/** Database intent and Redis acknowledgement deliberately have independent commits. */
export async function relayOne(pool:pg.Pool,transport:ExecutionTransport,owner=id('relay')){
 const kinds=(await pool.query("SELECT queue_kind FROM execution_dispatch_policies WHERE queue_kind IN ('text','image','audio','tools') ORDER BY last_served_at NULLS FIRST,queue_kind")).rows;
 let dispatch:any=null;
 for(const {queue_kind} of kinds){
  dispatch=await transaction(pool,async tx=>{
   // Short capability-local transaction. Network publication happens after commit.
   const policy=(await tx.query('SELECT * FROM execution_dispatch_policies WHERE queue_kind=$1 FOR UPDATE SKIP LOCKED',[queue_kind])).rows[0];
   if(!policy)return null;
   const accounts=(await tx.query(dispatchCandidateSql,[queue_kind,policy.account_limit,policy.application_limit,policy.queue_limit])).rows;
   let row:any;
   for(const account of accounts){
    row=(await tx.query(dispatchRequestSql,[queue_kind,account.organization_id,account.application_id,account.account_id,account.allow_new])).rows[0];
    if(row)break;
   }
   if(!row)return null;
   await tx.query("UPDATE execution_dispatches SET selected_at=COALESCE(selected_at,now()),lease_owner=$3,lease_until=now()+interval '30 seconds' WHERE request_id=$1 AND generation=$2",[row.request_id,row.generation,owner]);
   await tx.query(`INSERT INTO execution_dispatch_fairness VALUES($1,$2,$3,$4,clock_timestamp())
    ON CONFLICT(queue_kind,organization_id,application_id,account_id) DO UPDATE SET last_served_at=EXCLUDED.last_served_at`,[queue_kind,row.organization_id,row.application_id,row.account_id]);
   await tx.query('UPDATE execution_dispatch_policies SET last_served_at=clock_timestamp() WHERE queue_kind=$1',[queue_kind]);
   return row;
  });
  if(dispatch)break;
 }
 if(!dispatch)return false;
 try{
  await transport.publish(dispatch.queue_kind as QueueKind,{request_id:dispatch.request_id,generation:dispatch.generation,purpose:'execute'},new Date(dispatch.due_at));
  await pool.query('UPDATE execution_dispatches SET published_at=now(),delivery_count=delivery_count+1,lease_owner=NULL,lease_until=NULL WHERE request_id=$1 AND generation=$2 AND lease_owner=$3',[dispatch.request_id,dispatch.generation,owner]);
 }catch(error){await pool.query('UPDATE execution_dispatches SET lease_owner=NULL,lease_until=NULL WHERE request_id=$1 AND generation=$2 AND lease_owner=$3',[dispatch.request_id,dispatch.generation,owner]);throw error}
 return true;
}
/** Rebuild only unsent/waiting work; never turn an unknown or running attempt into a generation. */
export async function reconcileDeliveries(pool:pg.Pool,transport:ExecutionTransport,limit=100){
 if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('invalid_reconcile_batch');
 // Claim the next slice before network I/O. Healthy early jobs cannot hide a lost later job.
 // A crashed reconciler only postpones this slice briefly; request fencing still decides recovery.
 const rows=await transaction(pool,async tx=>{
  const claimed=(await tx.query(`SELECT d.*,r.not_before FROM execution_dispatches d JOIN execution_requests r ON r.id=d.request_id
   WHERE r.execution_backend='bullmq' AND r.dispatch_generation=d.generation AND d.published_at IS NOT NULL
   AND d.reconcile_after<=now() AND r.execution_status IN ('queued','waiting_retry','waiting_recovery') AND r.not_before<=now()
   ORDER BY d.reconcile_after,r.not_before,r.id LIMIT $1 FOR UPDATE OF d SKIP LOCKED`,[limit])).rows;
  if(claimed.length)await tx.query("UPDATE execution_dispatches d SET reconcile_after=now()+interval '5 seconds' FROM unnest($1::text[],$2::integer[]) AS c(request_id,generation) WHERE d.request_id=c.request_id AND d.generation=c.generation",[claimed.map(row=>row.request_id),claimed.map(row=>row.generation)]);
  return claimed;
 });
 let recovered=0;
 for(const row of rows){
  const {deliveryId}=await import('./transport.js');
  const job=await transport.queue(row.queue_kind).getJob(deliveryId(transport.installation,{request_id:row.request_id,generation:row.generation,purpose:'execute'}));
  if(job&&!['completed','failed','unknown'].includes(await job.getState()))continue;
  recovered+=await transaction(pool,async tx=>{
   const request=(await tx.query('SELECT * FROM execution_requests WHERE id=$1 FOR UPDATE',[row.request_id])).rows[0];
   if(request.execution_backend!=='bullmq'||request.dispatch_generation!==row.generation||!['queued','waiting_retry','waiting_recovery'].includes(request.execution_status))return 0;
   const generation=request.dispatch_generation+1;
   await tx.query('UPDATE execution_requests SET dispatch_generation=$2 WHERE id=$1',[request.id,generation]);
   await tx.query('INSERT INTO execution_dispatches(request_id,generation,queue_kind,due_at,recovered_at) VALUES($1,$2,$3,$4,now())',[request.id,generation,request.queue_kind,request.not_before]);return 1;
  });
 }
 return recovered;
}
