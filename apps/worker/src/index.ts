import {quotaShadowEnabled} from '../../../packages/queue/src/shadow-admission.js';
import {installWorkerShutdown} from '../../../packages/queue/src/shutdown.js';
import {bullmqWorkerSettings,startBullmqWorker} from '../../../packages/queue/src/worker.js';
import { loadRuntimeSecrets } from '../../../packages/runtime-config/src/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../../../packages/db/src/index.js';
import { executeOne } from '../../../packages/execution/src/runtime.js';
import { defaultRuntime } from '../../../packages/execution/src/default-runtime.js';
import { id } from '../../../packages/contracts/src/index.js';
await loadRuntimeSecrets();
const shadowEnabled=quotaShadowEnabled(process.env);
const pool=createPool(undefined,'worker'),deps=defaultRuntime(pool),worker=id('worker');let stopping=false;
const graceMs=Number(process.env.UAI_WORKER_SHUTDOWN_GRACE_MS??30000);
let pause:()=>Promise<void>=async()=>{};
const shutdown=installWorkerShutdown(graceMs,async()=>{stopping=true;await pause()});
if(process.env.UAI_WORKER_BACKEND==='bullmq'){
 const running=startBullmqWorker({pool,installation:process.env.UAI_INSTALLATION_ID!,redisUrl:process.env.REDIS_URL!,deps,name:worker,...bullmqWorkerSettings(process.env),
  ...(shadowEnabled?{shadow:sample=>console.log(JSON.stringify(sample))}:{})});
 pause=running.pause;
 try{while(!stopping)await delay(250)}finally{await running.close();await pool.end();shutdown.dispose()}
}else {
try{do{try{const result=await executeOne(pool,deps,undefined,worker);if(process.env.UAI_WORKER_ONCE==='true'){console.log(JSON.stringify(result));break;}if(!result.worked)await delay(500);}catch{console.error('worker_iteration_failed');if(process.env.UAI_WORKER_ONCE==='true')throw new Error('worker_iteration_failed');await delay(1000);}}while(!stopping);}finally{await pool.end();shutdown.dispose()}

}
