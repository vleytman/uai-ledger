import {distributedSchedulerTick} from '../../../packages/queue/src/scheduler.js';
import {ExecutionTransport} from '../../../packages/queue/src/transport.js';
import { loadRuntimeSecrets } from '../../../packages/runtime-config/src/index.js';
import {SchedulerWakeup} from '../../../packages/db/src/wakeup.js';
import { createPool } from '../../../packages/db/src/index.js';
import { schedulerTick } from '../../../packages/execution/src/runtime.js';
import { maintenanceRuntime } from '../../../packages/execution/src/maintenance-runtime.js';
import { id } from '../../../packages/contracts/src/index.js';
await loadRuntimeSecrets();
const pool=createPool(undefined,'scheduler'),deps=maintenanceRuntime(pool),worker=id('scheduler');let stopping=false;
process.once('SIGINT',()=>{stopping=true;});process.once('SIGTERM',()=>{stopping=true;});
const transport=process.env.UAI_EXECUTION_BACKEND==='bullmq'?new ExecutionTransport(process.env.UAI_INSTALLATION_ID??'',process.env.REDIS_URL??''):null;
const wakeup=new SchedulerWakeup(pool);
try{
 do{
  await wakeup.connect().catch(()=>{});
  try{
   let result:unknown;
   if(transport)result=await distributedSchedulerTick(pool,transport,worker);
   else result=await schedulerTick(pool,deps,undefined,worker);
   if(process.env.UAI_SCHEDULER_ONCE==='true'){console.log(JSON.stringify(result));break;}
  }catch{console.error('scheduler_iteration_failed');if(process.env.UAI_SCHEDULER_ONCE==='true')throw new Error('scheduler_iteration_failed');}
  await wakeup.wait(1000);
 }while(!stopping);
}finally{await wakeup.close();await transport?.close();await pool.end();}
