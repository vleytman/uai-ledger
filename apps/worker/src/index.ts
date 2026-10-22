import {WorkerPriorityGate} from '../../../packages/queue/src/worker-priority.js';
import {quotaShadowEnabled,shadowAdmission} from '../../../packages/queue/src/shadow-admission.js';
import {createWorkerTelemetry} from '../../../packages/queue/src/worker-telemetry.js';
import {startWorkerHeartbeat} from '../../../packages/queue/src/worker-heartbeat.js';
import {replayQuotaFeedback} from '../../../packages/execution/src/quota-feedback.js';
import {executeMaintenance} from '../../../packages/queue/src/maintenance.js';
import {maintenanceRuntime} from '../../../packages/execution/src/maintenance-runtime.js';
import {installWorkerShutdown} from '../../../packages/queue/src/shutdown.js';
import {providerAdmission} from '../../../packages/queue/src/provider-admission.js';
import { loadRuntimeSecrets } from '../../../packages/runtime-config/src/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../../../packages/db/src/index.js';
import {ExecutionTransport,type QueueKind} from '../../../packages/queue/src/transport.js';
import { executeOne,executeRequest,observeNativeRequest,schedulerTick } from '../../../packages/execution/src/runtime.js';
import { defaultRuntime } from '../../../packages/execution/src/default-runtime.js';
import { id } from '../../../packages/contracts/src/index.js';
await loadRuntimeSecrets();
const shadowEnabled=quotaShadowEnabled(process.env);
const pool=createPool(undefined,'worker'),deps=defaultRuntime(pool),worker=id('worker');let stopping=false;
const graceMs=Number(process.env.UAI_WORKER_SHUTDOWN_GRACE_MS??30000);
let pause:()=>Promise<void>=async()=>{};
const shutdown=installWorkerShutdown(graceMs,async()=>{stopping=true;await pause()});
if(process.env.UAI_WORKER_BACKEND==='bullmq'){
 const redis=process.env.REDIS_URL,installation=process.env.UAI_INSTALLATION_ID;
 if(!redis||!installation)throw new Error('redis_and_installation_required');
 const transport=new ExecutionTransport(installation,redis);
 const quota=providerAdmission(pool,redis,installation);
 const kinds=(process.env.UAI_WORKER_QUEUES??'text,image,audio,tools,observe,maintenance').split(',') as QueueKind[];
 if(kinds.some(kind=>!['text','image','audio','tools','observe','maintenance'].includes(kind)))throw new Error('invalid_execution_queue');
 const concurrency=Number(process.env.UAI_WORKER_CONCURRENCY??4);
 if(!Number.isSafeInteger(concurrency)||concurrency<1)throw new Error('invalid_worker_concurrency');
 const priorityGates=new Map(kinds.map(kind=>[kind,new WorkerPriorityGate(concurrency,Number(process.env.UAI_WORKER_INTERACTIVE_RESERVE??1))]));
 const activity=[...new Set(kinds)].map(queue_kind=>({queue_kind,concurrency,active_jobs:0}));
 const metrics=createWorkerTelemetry(pool,redis,installation);
 const heartbeat=startWorkerHeartbeat(pool,installation,worker,()=>activity.map(row=>({...row,telemetry:metrics.telemetry.snapshot(row.queue_kind)})),10000,()=>metrics.telemetry.probe());
 pause=async()=>{await transport.pause();await heartbeat.drain()};
 for(const item of activity){const kind=item.queue_kind;
 const measuredAdmission:NonNullable<typeof deps.admit>=(...args)=>metrics.telemetry.admit(kind,()=>quota.admit(...args));
 const admit=shadowEnabled?shadowAdmission(measuredAdmission,quota.preview,sample=>console.log(JSON.stringify({...sample,worker_id:worker,queue_kind:kind}))):measuredAdmission;
 transport.consume(kind,concurrency,async delivery=>{
  item.active_jobs++;try{
  if(kind==='maintenance')return await executeMaintenance(pool,installation,delivery,async()=>{await replayQuotaFeedback(pool,quota.onProviderResult);await quota.replayObservations();await quota.replayCooldowns();return schedulerTick(pool,{...maintenanceRuntime(pool,deps),limits:{...deps.limits,backend:'legacy'}},undefined,`${worker}-maintenance`)});
  if(kind==='observe'){
   if(delivery.purpose!=='observe'||!Number.isSafeInteger(delivery.poll_count))throw new Error('unexpected_observation_delivery');
   return await observeNativeRequest(pool,{...deps,onRateLimits:quota.onRateLimits,onProviderResult:quota.onProviderResult,onNativePending:quota.onNativePending},{request_id:delivery.request_id,generation:delivery.generation,poll_count:delivery.poll_count!},undefined,`${worker}-observe`);
  }
  if(delivery.purpose!=='execute')throw new Error('unexpected_delivery_purpose');
  const queued=(await pool.query('SELECT priority FROM execution_requests WHERE id=$1',[delivery.request_id])).rows[0];
  return await priorityGates.get(kind)!.run(queued?.priority??0,()=>executeRequest(pool,{...deps,admit,onRateLimits:quota.onRateLimits,onProviderResult:quota.onProviderResult,renewAdmission:quota.renewAdmission,onNativePending:quota.onNativePending,limits:{...deps.limits,backend:'bullmq',generation:delivery.generation}},delivery.request_id,undefined,`${worker}-${kind}`));
  }finally{item.active_jobs--}
 },()=>console.error('queue_transport_error'));}
 try{while(!stopping)await delay(250)}finally{await transport.close();await heartbeat.close();metrics.close();await quota.close();await pool.end();shutdown.dispose()}
}else {
try{do{try{const result=await executeOne(pool,deps,undefined,worker);if(process.env.UAI_WORKER_ONCE==='true'){console.log(JSON.stringify(result));break;}if(!result.worked)await delay(500);}catch{console.error('worker_iteration_failed');if(process.env.UAI_WORKER_ONCE==='true')throw new Error('worker_iteration_failed');await delay(1000);}}while(!stopping);}finally{await pool.end();shutdown.dispose()}

}
