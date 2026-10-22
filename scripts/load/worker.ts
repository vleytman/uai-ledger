/** Dedicated synthetic load worker. Never run against an application database. */
import {setTimeout as delay} from 'node:timers/promises';
import {injectMockFailure} from './inject.js';
import {createPool} from '../../packages/db/src/index.js';
import {defaultRuntime} from '../../packages/execution/src/default-runtime.js';
import {executeRequest,schedulerTick} from '../../packages/execution/src/runtime.js';
import {maintenanceRuntime} from '../../packages/execution/src/maintenance-runtime.js';
import {replayQuotaFeedback} from '../../packages/execution/src/quota-feedback.js';
import {executeMaintenance} from '../../packages/queue/src/maintenance.js';
import {ExecutionTransport} from '../../packages/queue/src/transport.js';
import {providerAdmission} from '../../packages/queue/src/provider-admission.js';

if(process.env.UAI_LOAD_TEST_ONLY!=='1'||!process.env.DATABASE_URL||!new URL(process.env.DATABASE_URL).pathname.startsWith('/uai_load_')||!process.env.REDIS_URL||!process.env.UAI_INSTALLATION_ID||!process.send)throw new Error('isolated_load_worker_required');
process.env.UAI_ALLOW_REAL_PROVIDERS='false';
const rateLimitEvery=Number(process.env.LOAD_429_EVERY??0),unknownEvery=Number(process.env.LOAD_UNKNOWN_EVERY??0);
if(!Number.isInteger(unknownEvery)||unknownEvery<0||unknownEvery>10000)throw new Error('invalid_unknown_interval');
if(!Number.isInteger(rateLimitEvery)||rateLimitEvery<0||rateLimitEvery>10000)throw new Error('invalid_429_interval');
const scale=Number(process.env.LOAD_DELAY_SCALE??1);
if(!Number.isFinite(scale)||scale<0.001||scale>10)throw new Error('invalid_delay_scale');
const pool=createPool(undefined,'worker');
const transport=new ExecutionTransport(process.env.UAI_INSTALLATION_ID,process.env.REDIS_URL);
const quota=providerAdmission(pool,process.env.REDIS_URL,process.env.UAI_INSTALLATION_ID);
const deps=defaultRuntime(pool),adapter=deps.adapter;
let active=0,submitted=0,stopping=false;
function report(){if(process.connected)process.send?.({type:'stats',role:'worker',pid:process.pid,active,submitted,rss:process.memoryUsage().rss,db_clients:pool.totalCount})}
deps.onDelta=undefined;
deps.adapter=async(...args)=>{
 const base=await adapter(...args),execute=base.execute.bind(base);
 base.execute=async(input,context)=>{
  submitted++;active++;report();
  const seconds=input.capability==='text.generate'?2+(submitted%9):30+(submitted%61);
  try{const injected=await injectMockFailure(pool,{rateLimitEvery,unknownEvery},input,context);if(injected)return injected;await delay(seconds*1000*scale,undefined,{signal:context.signal});return await execute(input,context)}finally{active--;report()}
 };
 return base;
};
Object.assign(deps,{admit:quota.admit,onRateLimits:quota.onRateLimits,onProviderResult:quota.onProviderResult,renewAdmission:quota.renewAdmission,onNativePending:quota.onNativePending});
const workers=['text','image'].map(kind=>transport.consume(kind as 'text'|'image',8,
 delivery=>executeRequest(pool,{...deps,limits:{backend:'bullmq',generation:delivery.generation}},delivery.request_id,undefined,`load-${process.pid}-${kind}`),
 error=>process.send?.({type:'fault',message:error.message})));
if(process.env.LOAD_SPLIT_SERVICES==='1')workers.push(transport.consume('maintenance',1,delivery=>executeMaintenance(pool,process.env.UAI_INSTALLATION_ID!,delivery,async()=>{
 await replayQuotaFeedback(pool,quota.onProviderResult);await quota.replayObservations();await quota.replayCooldowns();
 return schedulerTick(pool,{...maintenanceRuntime(pool,deps),limits:{...deps.limits,backend:'legacy'}},undefined,`load-${process.pid}-maintenance`);
}),error=>process.send?.({type:'fault',message:error.message})));
process.on('message',message=>{if((message as {type?:string})?.type==='stop')stopping=true});
process.on('SIGTERM',()=>{stopping=true});
process.on('disconnect',()=>{stopping=true});
const heartbeat=setInterval(report,1000);
try{
 await Promise.all(workers.map(worker=>worker.waitUntilReady()));
 process.send({type:'ready',pid:process.pid});
 while(!stopping)await delay(100);
}finally{
 clearInterval(heartbeat);
 await transport.close();await quota.close();await pool.end();
 report();process.disconnect?.();
}
