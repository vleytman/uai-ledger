import type pg from 'pg';
import {id} from '../../contracts/src/index.js';
import {SchedulerWakeup} from '../../db/src/wakeup.js';
import {maintenanceRuntime} from '../../execution/src/maintenance-runtime.js';
import {schedulerTick,type WorkerDependencies} from '../../execution/src/runtime.js';
import {distributedSchedulerTick} from './scheduler.js';
import {ExecutionTransport} from './transport.js';

export interface SchedulerOptions {
 pool:pg.Pool;
 /** `bullmq` publishes due work to the installation's queues; `legacy` runs maintenance itself. */
 backend:'bullmq'|'legacy';
 installation?:string;redisUrl?:string;
 /** Legacy maintenance dependencies; defaults to maintenanceRuntime(pool). */
 deps?:WorkerDependencies;
 name?:string;
 /** Longest wait between ticks; a scheduler notification wakes it sooner. */
 intervalMs?:number;
 /** One tick, then stop; a failed tick rejects `done`. */
 once?:boolean;
 onError?:(error:unknown)=>void;
}
export interface Scheduler {
 readonly name:string;
 /** Resolves after the last tick with its result. */
 readonly done:Promise<unknown>;
 /** Finishes the tick in hand and releases the wakeup listener and Redis. The pool stays the caller's. */
 stop():Promise<void>;
}

export function startScheduler(options:SchedulerOptions):Scheduler{
 const {pool}=options,name=options.name??id('scheduler'),intervalMs=options.intervalMs??1000;
 if(!Number.isSafeInteger(intervalMs)||intervalMs<10)throw new Error('invalid_scheduler_interval');
 const transport=options.backend==='bullmq'?new ExecutionTransport(options.installation??'',options.redisUrl??''):null;
 const deps=transport?undefined:options.deps??maintenanceRuntime(pool);
 const wakeup=new SchedulerWakeup(pool),onError=options.onError??(()=>console.error('scheduler_iteration_failed'));
 let stopping=false;
 const done=(async()=>{
  let result:unknown;
  try{
   do{
    await wakeup.connect().catch(()=>{});
    try{result=transport?await distributedSchedulerTick(pool,transport,name):await schedulerTick(pool,deps!,undefined,name)}
    catch(error){if(options.once)throw error;onError(error)}
    if(options.once||stopping)break;
    await wakeup.wait(intervalMs);
   }while(!stopping);
   return result;
  }finally{await wakeup.close();await transport?.close()}
 })();
 return {name,done,async stop(){stopping=true;await wakeup.close();await done.catch(()=>{})}};
}
