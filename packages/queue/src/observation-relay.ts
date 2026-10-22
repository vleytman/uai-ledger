import type pg from 'pg';
import {transaction} from '../../db/src/index.js';
import {id,systemClock,type Clock,type Scope} from '../../contracts/src/index.js';
import {ExecutionTransport,deliveryId,type Delivery} from './transport.js';

const observationDueSql=`a.observation_organization_id=f.organization_id
 AND a.observation_application_id=f.application_id AND a.observation_account_id=f.account_id
 AND r.execution_backend='bullmq' AND a.remote_job_id IS NOT NULL
    AND (r.execution_status IN ('running','outcome_unknown') OR (r.execution_status IN ('succeeded','canceled','refused') AND a.cost_units IS NULL))
    AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=$1)
    AND r.deadline_at+INTERVAL '1 hour'>$1 AND (a.next_poll_at IS NULL OR a.next_poll_at<=$1)
    AND a.observation_relay_after<=$1 AND (a.observation_relay_until IS NULL OR a.observation_relay_until<=$1)
    AND (a.observation_selected_poll=a.poll_count OR ($6::boolean
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($7::jsonb) b WHERE b->>0=r.organization_id AND b->>1=r.application_id AND b->>2=r.account_id)
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($8::jsonb) b WHERE b->>0=r.organization_id AND b->>1=r.application_id)))
`;
/** Shared with the mock profiler so measurements use the production query. */
export const observationCandidateSql=`WITH account_slice AS MATERIALIZED (
 SELECT f.* FROM execution_dispatch_fairness f WHERE f.queue_kind='observe'
 AND ($3::text IS NULL OR (f.organization_id=$3 AND f.application_id=$4 AND f.account_id=$5))
 AND EXISTS(SELECT 1 FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id AND r.attempt_count=a.number WHERE ${observationDueSql})
 ORDER BY f.last_served_at,f.organization_id,f.application_id,f.account_id LIMIT $2
), eligible AS (
 SELECT c.*,f.last_served_at AS account_served,
 row_number() OVER(PARTITION BY f.organization_id,f.application_id,f.account_id ORDER BY c.observation_relay_after,c.next_poll_at NULLS FIRST,c.id) AS account_rank
 FROM account_slice f CROSS JOIN LATERAL (
  SELECT a.id,a.observation_relay_after,a.next_poll_at FROM execution_attempts a
  JOIN execution_requests r ON r.id=a.request_id AND r.attempt_count=a.number
  WHERE ${observationDueSql}
  ORDER BY a.observation_relay_after,a.next_poll_at NULLS FIRST,a.id LIMIT $9
 ) c
) SELECT a.id,a.poll_count,a.observation_selected_poll,r.id AS request_id,r.dispatch_generation,r.organization_id,r.application_id,r.account_id
 FROM eligible e JOIN execution_attempts a ON a.id=e.id JOIN execution_requests r ON r.id=a.request_id
 WHERE a.observation_relay_after<=$1 AND (a.observation_relay_until IS NULL OR a.observation_relay_until<=$1)
 ORDER BY e.account_rank,e.account_served,a.observation_relay_after,a.next_poll_at NULLS FIRST,a.id LIMIT $2 FOR UPDATE OF a SKIP LOCKED`;

/** The durable remote job and poll revision are the outbox. Redis is only its delivery. */
export async function relayObservations(pool:pg.Pool,transport:ExecutionTransport,options:{batchSize?:number;scope?:Scope;clock?:Clock}={}){
 const batch=options.batchSize??32,clock=options.clock??systemClock,scope=options.scope,owner=id('observe-relay');
 if(!Number.isSafeInteger(batch)||batch<1||batch>256)throw new Error('invalid_observation_batch');
 const rows=await transaction(pool,async tx=>{
  // Serialize capacity decisions only, never Redis I/O. Selection survives a
  // missing publication acknowledgement; advancing poll_count releases its slot.
  const policy=(await tx.query("SELECT * FROM execution_dispatch_policies WHERE queue_kind='observe' FOR UPDATE")).rows[0];
  const outstanding=(await tx.query(`SELECT r.organization_id,r.application_id,r.account_id
   FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id AND r.attempt_count=a.number
   WHERE r.execution_backend='bullmq' AND a.observation_selected_poll=a.poll_count
    AND (r.execution_status IN ('running','outcome_unknown') OR (r.execution_status IN ('succeeded','canceled','refused') AND a.cost_units IS NULL))
    AND r.deadline_at+INTERVAL '1 hour'>$1`,[clock.now()])).rows;
  const accountKey=(row:any)=>JSON.stringify([row.organization_id,row.application_id,row.account_id]);
  const applicationKey=(row:any)=>JSON.stringify([row.organization_id,row.application_id]);
  const accountCounts=new Map<string,number>(),applicationCounts=new Map<string,number>();
  for(const row of outstanding){accountCounts.set(accountKey(row),(accountCounts.get(accountKey(row))??0)+1);applicationCounts.set(applicationKey(row),(applicationCounts.get(applicationKey(row))??0)+1)}
  let total=outstanding.length;
  const candidates=(await tx.query(observationCandidateSql,[clock.now(),256,scope?.organization_id??null,scope?.application_id??null,scope?.account_id??null,total<policy.queue_limit,
    JSON.stringify([...accountCounts].filter(([,n])=>n>=policy.account_limit).map(([key])=>JSON.parse(key))),
    JSON.stringify([...applicationCounts].filter(([,n])=>n>=policy.application_limit).map(([key])=>JSON.parse(key))),
    Math.min(batch,[...accountCounts.values()].reduce((max,n)=>Math.max(max,n),policy.account_limit))])).rows;
  const selected=[];
  for(const row of candidates){
   if(selected.length>=batch)break;
   if(row.observation_selected_poll!==row.poll_count){
    const account=accountKey(row),application=applicationKey(row);
    if(total>=policy.queue_limit||(accountCounts.get(account)??0)>=policy.account_limit||(applicationCounts.get(application)??0)>=policy.application_limit)continue;
    total++;accountCounts.set(account,(accountCounts.get(account)??0)+1);applicationCounts.set(application,(applicationCounts.get(application)??0)+1);
   }
   selected.push(row);
  }
  if(selected.length)await tx.query(`UPDATE execution_attempts SET observation_selected_poll=poll_count,observation_relay_owner=$2,observation_relay_until=$3 WHERE id=ANY($1::text[])`,[selected.map(row=>row.id),owner,new Date(clock.now().getTime()+30000)]);
  const accounts=new Map(selected.map(row=>[JSON.stringify([row.organization_id,row.application_id,row.account_id]),row]));
  // Concurrent relays may claim different attempts for the same accounts.
  // Lock their shared fairness rows in the same order to avoid a deadlock.
  for(const [,row] of [...accounts].sort(([a],[b])=>a<b?-1:a>b?1:0))await tx.query(`INSERT INTO execution_dispatch_fairness(queue_kind,organization_id,application_id,account_id,last_served_at)
   VALUES('observe',$1,$2,$3,$4) ON CONFLICT(queue_kind,organization_id,application_id,account_id) DO UPDATE SET last_served_at=EXCLUDED.last_served_at`,[row.organization_id,row.application_id,row.account_id,clock.now()]);
  return selected;
 });
 let published=0;
 for(const row of rows){
  let sent=false;
  try{
   const delivery:Delivery={request_id:row.request_id,generation:row.dispatch_generation,purpose:'observe',poll_count:row.poll_count};
   const job=await transport.queue('observe').getJob(deliveryId(transport.installation,delivery));
   const state=await job?.getState();
   // A completed no-op can result from a busy domain lease. It is safe to wake
   // the same poll again; PostgreSQL, never transport completion, owns progress.
   if(job&&(state==='completed'||state==='failed'))await job.remove();
   if(!job||state==='unknown'||state==='completed'||state==='failed'){
    await transport.publish('observe',delivery);sent=true;published++;
   }
  }finally{
   await pool.query(`UPDATE execution_attempts SET observation_relay_owner=NULL,observation_relay_until=NULL,
    observation_relay_after=$3,observation_delivery_count=observation_delivery_count+$4
    WHERE id=$1 AND observation_relay_owner=$2`,[row.id,owner,new Date(clock.now().getTime()+5000),sent?1:0]);
  }
 }
 return {checked:rows.length,published};
}
