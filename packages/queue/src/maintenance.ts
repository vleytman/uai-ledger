import type pg from 'pg';
import {id,systemClock,type Clock} from '../../contracts/src/index.js';
import {ExecutionTransport,deliveryId,type Delivery} from './transport.js';
const valid=(installation:string)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(installation))throw new Error('invalid_installation')};
export interface MaintenanceIntervals {interval_ms:number;idle_interval_ms:number}
/** UAI_MAINTENANCE_INTERVAL_MS follows a cycle with work; UAI_MAINTENANCE_IDLE_INTERVAL_MS (the same by default) an idle one. */
export function maintenanceIntervals(env:NodeJS.ProcessEnv=process.env):MaintenanceIntervals{
 const interval_ms=Number(env.UAI_MAINTENANCE_INTERVAL_MS??1000),idle_interval_ms=Number(env.UAI_MAINTENANCE_IDLE_INTERVAL_MS??interval_ms);
 if(!Number.isSafeInteger(interval_ms)||interval_ms<100||interval_ms>60000)throw new Error('invalid_maintenance_interval');
 if(!Number.isSafeInteger(idle_interval_ms)||idle_interval_ms<interval_ms||idle_interval_ms>3600000)throw new Error('invalid_maintenance_idle_interval');
 return {interval_ms,idle_interval_ms};
}
/** Open requests and operations keep maintenance at its interval: deadlines, leases and settlement are theirs. */
const openWork=`(EXISTS(SELECT 1 FROM execution_requests WHERE financial_closed_at IS NULL) OR EXISTS(SELECT 1 FROM operations WHERE admission_status='open'))`;
/** Anything a cycle would act on now. Each probe reads a partial index; $2 is the clock. */
const workDue=`(${openWork}
 OR EXISTS(SELECT 1 FROM notification_deliveries WHERE (status='pending' AND next_attempt_at<=$2) OR (status='sending' AND lease_expires_at<=$2))
 OR EXISTS(SELECT 1 FROM grant_revocations r WHERE r.status='prepared' AND r.reconcile_after<=$2 AND NOT EXISTS(SELECT 1 FROM revocation_incidents i WHERE i.revocation_id=r.id))
 OR EXISTS(SELECT 1 FROM quota_result_feedback WHERE applied_at IS NULL AND retry_at<=$2)
 OR EXISTS(SELECT 1 FROM quota_observations WHERE applied_at IS NULL AND retry_at<=$2)
 OR EXISTS(SELECT 1 FROM provider_quota_groups WHERE blocked_until IS NOT NULL AND cooldown_retry_at<=$2 AND blocked_until>$2 AND (cooldown_applied_until IS NULL OR cooldown_applied_until<blocked_until))
 OR EXISTS(SELECT 1 FROM storage_inputs WHERE status='available' AND expires_at<=$2)
 OR EXISTS(SELECT 1 FROM storage_assets WHERE status='available' AND expires_at<=$2)
 OR EXISTS(SELECT 1 FROM storage_manifests WHERE status='available' AND content_expires_at<=$2)
 OR EXISTS(SELECT 1 FROM storage_purge_jobs WHERE status='pending' OR (status='running' AND lease_expires_at<=$2))
 OR EXISTS(SELECT 1 FROM storage_tombstones WHERE status='purging')
 OR EXISTS(SELECT 1 FROM notification_rules n WHERE n.enabled AND NOT EXISTS(SELECT 1 FROM runtime_monitor_runs m
  WHERE m.monitor_key='numeric:'||n.organization_id||':'||n.application_id AND m.last_completed_at>$2::timestamptz-interval '60 seconds')))`;
/** A cycle is due at due_at, or from wake_after once there is work for it. */
const cycleDue=`(due_at<=$2 OR (wake_after<=$2 AND ${workDue}))`;
export async function relayMaintenance(pool:pg.Pool,transport:ExecutionTransport,clock:Clock=systemClock){
 valid(transport.installation);
 await pool.query('INSERT INTO execution_maintenance_cycles(installation_id,due_at) VALUES($1,$2) ON CONFLICT DO NOTHING',[transport.installation,clock.now()]);
 const row=(await pool.query(`UPDATE execution_maintenance_cycles SET relay_after=$3 WHERE installation_id=$1
  AND ${cycleDue} AND relay_after<=$2 AND (lease_until IS NULL OR lease_until<=$2) RETURNING generation`,[transport.installation,clock.now(),new Date(clock.now().getTime()+5000)])).rows[0];
 if(!row)return false;
 const delivery:Delivery={request_id:transport.installation,generation:row.generation,purpose:'maintenance'};
 const job=await transport.queue('maintenance').getJob(deliveryId(transport.installation,delivery));
 const state=await job?.getState();
 if(job&&(state==='completed'||state==='failed'))await job.remove();
 if(!job||state==='unknown'||state==='completed'||state==='failed')await transport.publish('maintenance',delivery);
 return true;
}
/** Whether a cycle result reports any work: a positive count, true, a status, a non-empty list. */
export function maintenanceWorked(value:unknown):boolean{
 if(typeof value==='number')return value>0;
 if(typeof value==='boolean')return value;
 if(typeof value==='string')return true;
 if(Array.isArray(value))return value.length>0;
 if(value&&typeof value==='object')return Object.values(value).some(maintenanceWorked);
 return false;
}
/**
 * Each maintenance action remains independently idempotent; a lease is not a financial fence.
 * After a cycle that found open requests or operations, or did any work, the next is due after interval_ms.
 * Otherwise it is due after idle_interval_ms, and the relay starts it sooner once work is due.
 */
export async function executeMaintenance(pool:pg.Pool,installation:string,delivery:Delivery,work:()=>Promise<unknown>,clock:Clock=systemClock,intervals:MaintenanceIntervals=maintenanceIntervals()){
 valid(installation);
 if(delivery.purpose!=='maintenance'||delivery.request_id!==installation||!Number.isSafeInteger(delivery.generation)||delivery.generation<0)throw new Error('invalid_maintenance_delivery');
 const owner=id('maintenance');
 const lease=(await pool.query(`UPDATE execution_maintenance_cycles SET lease_owner=$3,lease_until=$4 WHERE installation_id=$1 AND generation=$5
  AND ${cycleDue} AND (lease_until IS NULL OR lease_until<=$2) RETURNING generation,${openWork} AS open_work`,[installation,clock.now(),owner,new Date(clock.now().getTime()+30000),delivery.generation])).rows[0];
 if(!lease)return {worked:false};
 let renewal:Promise<void>|undefined,lost=false;
 const heartbeat=setInterval(()=>{
  if(renewal)return;
  renewal=pool.query(`UPDATE execution_maintenance_cycles SET lease_until=$3 WHERE installation_id=$1 AND lease_owner=$2 AND lease_until>$4`,[installation,owner,new Date(clock.now().getTime()+30000),clock.now()])
   .then(result=>{if(!result.rowCount)lost=true}).catch(()=>{lost=true}).finally(()=>{renewal=undefined});
 },5000);heartbeat.unref();
 try{
  const result=await work();clearInterval(heartbeat);await renewal;
  if(lost)throw new Error('maintenance_lease_lost');
  // Open work is read when the lease is taken: work that closes during the cycle may still leave events to consume.
  const idle=!lease.open_work&&!maintenanceWorked(result),at=clock.now().getTime(),next=new Date(at+intervals.interval_ms);
  const done=await pool.query(`UPDATE execution_maintenance_cycles SET generation=generation+1,due_at=$3,wake_after=$5,relay_after=$6,lease_owner=NULL,lease_until=NULL,completed_at=$4
   WHERE installation_id=$1 AND lease_owner=$2 AND lease_until>$4`,[installation,owner,idle?new Date(at+intervals.idle_interval_ms):next,clock.now(),idle?next:null,next]);
  if(!done.rowCount)throw new Error('maintenance_lease_lost');
  return {worked:true,idle,result};
 }catch(error){
  await pool.query(`UPDATE execution_maintenance_cycles SET lease_owner=NULL,lease_until=NULL,due_at=$3,relay_after=$3,wake_after=NULL WHERE installation_id=$1 AND lease_owner=$2`,[installation,owner,new Date(clock.now().getTime()+5000)]);
  throw error;
 }finally{clearInterval(heartbeat);await renewal;}
}
