import type pg from 'pg';
import {id,systemClock,type Clock} from '../../contracts/src/index.js';
import {ExecutionTransport,deliveryId,type Delivery} from './transport.js';
const valid=(installation:string)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(installation))throw new Error('invalid_installation')};
export async function relayMaintenance(pool:pg.Pool,transport:ExecutionTransport,clock:Clock=systemClock){
 valid(transport.installation);
 await pool.query('INSERT INTO execution_maintenance_cycles(installation_id,due_at) VALUES($1,$2) ON CONFLICT DO NOTHING',[transport.installation,clock.now()]);
 const row=(await pool.query(`UPDATE execution_maintenance_cycles SET relay_after=$3 WHERE installation_id=$1
  AND due_at<=$2 AND relay_after<=$2 AND (lease_until IS NULL OR lease_until<=$2) RETURNING generation`,[transport.installation,clock.now(),new Date(clock.now().getTime()+5000)])).rows[0];
 if(!row)return false;
 const delivery:Delivery={request_id:transport.installation,generation:row.generation,purpose:'maintenance'};
 const job=await transport.queue('maintenance').getJob(deliveryId(transport.installation,delivery));
 const state=await job?.getState();
 if(job&&(state==='completed'||state==='failed'))await job.remove();
 if(!job||state==='unknown'||state==='completed'||state==='failed')await transport.publish('maintenance',delivery);
 return true;
}
/** Each maintenance action remains independently idempotent; a lease is not a financial fence. */
export async function executeMaintenance(pool:pg.Pool,installation:string,delivery:Delivery,work:()=>Promise<unknown>,clock:Clock=systemClock){
 valid(installation);
 if(delivery.purpose!=='maintenance'||delivery.request_id!==installation||!Number.isSafeInteger(delivery.generation)||delivery.generation<0)throw new Error('invalid_maintenance_delivery');
 const owner=id('maintenance');
 const lease=(await pool.query(`UPDATE execution_maintenance_cycles SET lease_owner=$3,lease_until=$4 WHERE installation_id=$1 AND generation=$2
  AND due_at<=$5 AND (lease_until IS NULL OR lease_until<=$5) RETURNING generation`,[installation,delivery.generation,owner,new Date(clock.now().getTime()+30000),clock.now()])).rows[0];
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
  const done=await pool.query(`UPDATE execution_maintenance_cycles SET generation=generation+1,due_at=$3,relay_after=$3,lease_owner=NULL,lease_until=NULL,completed_at=$4
   WHERE installation_id=$1 AND lease_owner=$2 AND lease_until>$4`,[installation,owner,new Date(clock.now().getTime()+1000),clock.now()]);
  if(!done.rowCount)throw new Error('maintenance_lease_lost');
  return {worked:true,result};
 }catch(error){
  await pool.query(`UPDATE execution_maintenance_cycles SET lease_owner=NULL,lease_until=NULL,due_at=$3,relay_after=$3 WHERE installation_id=$1 AND lease_owner=$2`,[installation,owner,new Date(clock.now().getTime()+5000)]);
  throw error;
 }finally{clearInterval(heartbeat);await renewal;}
}
