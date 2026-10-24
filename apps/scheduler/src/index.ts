import {startScheduler} from '../../../packages/queue/src/scheduler-loop.js';
import { loadRuntimeSecrets } from '../../../packages/runtime-config/src/index.js';
import { createPool } from '../../../packages/db/src/index.js';
await loadRuntimeSecrets();
const pool=createPool(undefined,'scheduler'),once=process.env.UAI_SCHEDULER_ONCE==='true';
const scheduler=startScheduler({pool,backend:process.env.UAI_EXECUTION_BACKEND==='bullmq'?'bullmq':'legacy',installation:process.env.UAI_INSTALLATION_ID,redisUrl:process.env.REDIS_URL,once});
if(!once){process.once('SIGINT',()=>void scheduler.stop());process.once('SIGTERM',()=>void scheduler.stop());}
try{const result=await scheduler.done;if(once)console.log(JSON.stringify(result));}
catch{console.error('scheduler_iteration_failed');throw new Error('scheduler_iteration_failed');}
finally{await pool.end();}
