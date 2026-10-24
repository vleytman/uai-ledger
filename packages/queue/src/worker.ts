import type pg from 'pg';
import {id} from '../../contracts/src/index.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {maintenanceRuntime} from '../../execution/src/maintenance-runtime.js';
import {replayQuotaFeedback} from '../../execution/src/quota-feedback.js';
import {executeRequest,observeNativeRequest,schedulerTick,type WorkerDependencies} from '../../execution/src/runtime.js';
import {executeMaintenance,maintenanceIntervals,type MaintenanceIntervals} from './maintenance.js';
import {providerAdmission} from './provider-admission.js';
import {shadowAdmission} from './shadow-admission.js';
import {ExecutionTransport,queueKinds,type QueueKind} from './transport.js';
import {startWorkerHeartbeat} from './worker-heartbeat.js';
import {WorkerPriorityGate} from './worker-priority.js';
import {createWorkerTelemetry} from './worker-telemetry.js';

export interface BullmqWorkerSettings {queues:QueueKind[];concurrency:number;interactive_reserve:number}
/** Worker settings from UAI_WORKER_QUEUES, UAI_WORKER_CONCURRENCY and UAI_WORKER_INTERACTIVE_RESERVE. */
export function bullmqWorkerSettings(env:NodeJS.ProcessEnv=process.env,defaults:Partial<BullmqWorkerSettings>={}):BullmqWorkerSettings{
 const queues=env.UAI_WORKER_QUEUES!==undefined?env.UAI_WORKER_QUEUES.split(',').map(kind=>kind.trim()) as QueueKind[]:defaults.queues??[...queueKinds];
 if(!queues.length||queues.some(kind=>!queueKinds.includes(kind)))throw new Error('invalid_execution_queue');
 const concurrency=env.UAI_WORKER_CONCURRENCY!==undefined?Number(env.UAI_WORKER_CONCURRENCY):defaults.concurrency??4;
 if(!Number.isSafeInteger(concurrency)||concurrency<1)throw new Error('invalid_worker_concurrency');
 const interactive_reserve=env.UAI_WORKER_INTERACTIVE_RESERVE!==undefined?Number(env.UAI_WORKER_INTERACTIVE_RESERVE):defaults.interactive_reserve??1;
 return {queues,concurrency,interactive_reserve};
}

export interface BullmqWorkerOptions extends Partial<BullmqWorkerSettings> {
 pool:pg.Pool;installation:string;redisUrl:string;
 /** Execution dependencies; defaults to defaultRuntime(pool). Replace `adapter` here to substitute a provider. */
 deps?:WorkerDependencies;
 /** Heartbeat worker_id and lease owner prefix. */
 name?:string;
 /** Log a quota shadow sample per admission (UAI_QUOTA_SHADOW). */
 shadow?:(sample:Record<string,unknown>)=>void;
 heartbeatMs?:number;
 /** Maintenance cycle spacing; defaults to UAI_MAINTENANCE_INTERVAL_MS and UAI_MAINTENANCE_IDLE_INTERVAL_MS. */
 maintenance?:MaintenanceIntervals;
 onTransportError?:(error:Error)=>void;
}
export interface BullmqWorker {
 readonly name:string;readonly queues:QueueKind[];
 /** Stops taking jobs; jobs in hand finish. The heartbeat reports `draining`. */
 pause():Promise<void>;
 /** Pauses, waits for jobs in hand and releases Redis and the heartbeat. The pool stays the caller's. */
 close():Promise<void>;
}

/** One BullMQ worker process: quota admission, priority gates, telemetry, heartbeat, maintenance and observation. */
export function startBullmqWorker(options:BullmqWorkerOptions):BullmqWorker{
 const {pool,installation,redisUrl}=options;
 if(!redisUrl||!installation)throw new Error('redis_and_installation_required');
 const settings=bullmqWorkerSettings({},options),name=options.name??id('worker'),deps=options.deps??defaultRuntime(pool),intervals=options.maintenance??maintenanceIntervals();
 const transport=new ExecutionTransport(installation,redisUrl),quota=providerAdmission(pool,redisUrl,installation);
 const gates=new Map(settings.queues.map(kind=>[kind,new WorkerPriorityGate(settings.concurrency,settings.interactive_reserve)]));
 const activity=[...new Set(settings.queues)].map(queue_kind=>({queue_kind,concurrency:settings.concurrency,active_jobs:0}));
 const metrics=createWorkerTelemetry(pool,redisUrl,installation);
 const heartbeat=startWorkerHeartbeat(pool,installation,name,()=>activity.map(row=>({...row,telemetry:metrics.telemetry.snapshot(row.queue_kind)})),options.heartbeatMs??10000,()=>metrics.telemetry.probe());
 const hooks={onRateLimits:quota.onRateLimits,onProviderResult:quota.onProviderResult,onNativePending:quota.onNativePending};
 for(const item of activity){
  const kind=item.queue_kind,shadow=options.shadow;
  const measured:NonNullable<WorkerDependencies['admit']>=(...args)=>metrics.telemetry.admit(kind,()=>quota.admit(...args));
  const admit=shadow?shadowAdmission(measured,quota.preview,sample=>shadow({...sample,worker_id:name,queue_kind:kind})):measured;
  transport.consume(kind,settings.concurrency,async delivery=>{
   item.active_jobs++;
   try{
    if(kind==='maintenance')return await executeMaintenance(pool,installation,delivery,async()=>{
     const replayed={quota_feedback:await replayQuotaFeedback(pool,quota.onProviderResult),quota_observations:await quota.replayObservations(),quota_cooldowns:await quota.replayCooldowns()};
     return {...replayed,...await schedulerTick(pool,{...maintenanceRuntime(pool,deps),limits:{...deps.limits,backend:'legacy'}},undefined,`${name}-maintenance`)};
    },undefined,intervals);
    if(kind==='observe'){
     if(delivery.purpose!=='observe'||!Number.isSafeInteger(delivery.poll_count))throw new Error('unexpected_observation_delivery');
     return await observeNativeRequest(pool,{...deps,...hooks},{request_id:delivery.request_id,generation:delivery.generation,poll_count:delivery.poll_count!},undefined,`${name}-observe`);
    }
    if(delivery.purpose!=='execute')throw new Error('unexpected_delivery_purpose');
    const queued=(await pool.query('SELECT priority FROM execution_requests WHERE id=$1',[delivery.request_id])).rows[0];
    return await gates.get(kind)!.run(queued?.priority??0,()=>executeRequest(pool,{...deps,...hooks,admit,renewAdmission:quota.renewAdmission,limits:{...deps.limits,backend:'bullmq',generation:delivery.generation}},delivery.request_id,undefined,`${name}-${kind}`));
   }finally{item.active_jobs--}
  },options.onTransportError??(()=>console.error('queue_transport_error')));
 }
 let paused:Promise<void>|undefined,closed:Promise<void>|undefined;
 const pause=()=>paused??=(async()=>{await transport.pause();await heartbeat.drain()})();
 return {name,queues:settings.queues,pause,
  close:()=>closed??=(async()=>{await pause();await transport.close();await heartbeat.close();metrics.close();await quota.close()})()};
}
