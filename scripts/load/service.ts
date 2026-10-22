/** Real API/scheduler components, isolated from the arrival generator. Synthetic DB only. */
import {setTimeout as delay} from 'node:timers/promises';
import {createPool,transaction} from '../../packages/db/src/index.js';
import {systemClock} from '../../packages/contracts/src/index.js';
import {restoreContentGuard} from '../../packages/storage/src/index.js';
import {createApi} from '../../apps/api/src/server.js';
import {ExecutionTransport} from '../../packages/queue/src/transport.js';
import {distributedSchedulerTick} from '../../packages/queue/src/scheduler.js';

const role=process.env.LOAD_SERVICE_ROLE;
if(process.env.UAI_LOAD_TEST_ONLY!=='1'||!process.env.DATABASE_URL||!new URL(process.env.DATABASE_URL).pathname.startsWith('/uai_load_')||!process.env.REDIS_URL||!process.env.UAI_INSTALLATION_ID||!process.send||!['api','scheduler'].includes(role??''))throw new Error('isolated_load_service_required');
process.env.UAI_ALLOW_REAL_PROVIDERS='false';
const pool=createPool(undefined,role as 'api'|'scheduler');
const app=role==='api'?createApi(pool):null;
const transport=role==='scheduler'?new ExecutionTransport(process.env.UAI_INSTALLATION_ID,process.env.REDIS_URL):null;
let stopping=false;
process.on('SIGTERM',()=>{stopping=true});process.on('disconnect',()=>{stopping=true});
const report=()=>{if(process.connected)process.send?.({type:'stats',role,pid:process.pid,rss:process.memoryUsage().rss,db_clients:pool.totalCount})};
const heartbeat=setInterval(report,1000);
try{
 let address:string|undefined;
 if(app){await transaction(pool,tx=>restoreContentGuard(tx,systemClock));address=await app.listen({host:'127.0.0.1',port:0})}
 else await distributedSchedulerTick(pool,transport!,`load-scheduler-${process.pid}`);
 report();process.send({type:'ready',role,pid:process.pid,address});
 while(!stopping){
  await delay(1000);
  if(transport&&!stopping)try{await distributedSchedulerTick(pool,transport,`load-scheduler-${process.pid}`)}catch{process.send?.({type:'fault',message:'scheduler_iteration_failed'})}
 }
}finally{
 clearInterval(heartbeat);await app?.close();await transport?.close();await pool.end();report();process.disconnect?.();
}
