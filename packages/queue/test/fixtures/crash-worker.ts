import {createPool} from '../../../db/src/index.js';
import {defaultRuntime} from '../../../execution/src/default-runtime.js';
import {executeRequest} from '../../../execution/src/runtime.js';
import {ExecutionTransport} from '../../src/transport.js';
import {providerAdmission} from '../../src/provider-admission.js';
import {QuotaStore} from '../../src/quota.js';

if(process.env.UAI_CRASH_TEST_ONLY!=='1'||!process.send||!process.env.UAI_INSTALLATION_ID?.startsWith('crash_'))throw new Error('crash_test_only');
process.env.UAI_ALLOW_REAL_PROVIDERS='false';
const pool=createPool(undefined,'worker');
const transport=new ExecutionTransport(process.env.UAI_INSTALLATION_ID,process.env.REDIS_URL!);
const broker=providerAdmission(pool,process.env.REDIS_URL!,process.env.UAI_INSTALLATION_ID);
const boundary=process.env.UAI_CRASH_BOUNDARY;
if(!['intent','redis-admitted','admitted','before-provider','http-accepted','http-body','submitted','result','settled'].includes(boundary??''))throw new Error('invalid_crash_boundary');
if(boundary==='intent'||boundary==='redis-admitted'){
 const acquire=QuotaStore.acquireMany;
 QuotaStore.acquireMany=async inputs=>{
  if(boundary==='intent'){process.send!({type:'intent'});await new Promise(()=>{})}
  const result=await acquire(inputs);
  if(result.allowed){process.send!({type:'redis-admitted'});await new Promise(()=>{})}
  return result;
 };
}
const deps=defaultRuntime(pool),adapter=deps.adapter;
deps.onDelta=undefined;
deps.adapter=async(...args)=>{
 const base=await adapter(...args),execute=base.execute.bind(base);
  base.execute=async(input,context)=>{
  if(boundary==='before-provider'){
   // prepareDispatch has committed, but the delegate has not started any provider work.
   process.send!({type:'before-provider',attempt_id:context.attempt_id});
   return new Promise(()=>{});
  }
  process.send!({type:'provider-called',attempt_id:context.attempt_id});
  if(boundary==='http-body'||boundary==='http-accepted'){
   const endpoint=new URL(process.env.UAI_CRASH_HTTP_ENDPOINT??'');
   if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/synthetic'||endpoint.username||endpoint.password)throw new Error('loopback_test_endpoint_required');
   const response=await fetch(endpoint,{method:'POST',body:JSON.stringify({attempt_id:context.attempt_id}),signal:context.signal});
   process.send!({type:'http-body',attempt_id:context.attempt_id,status:response.status});
   await response.text();
   throw new Error('partial_response_must_not_complete');
  }
  if(boundary!=='submitted')return execute(input,context);
  // The durable submission intent exists before the provider adapter is called.
  process.send!({type:'submitted',attempt_id:context.attempt_id});
  return new Promise(()=>{});
 };
 return base;
};
Object.assign(deps,{admit:broker.admit,onRateLimits:broker.onRateLimits,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission});
deps.admit=async(...args)=>{
 const admission=await broker.admit(...args);
 if(boundary==='admitted'&&admission.allowed){process.send!({type:'admitted',admission_id:admission.admission_id});await new Promise(()=>{})}
 return admission;
};
deps.onProviderResult=async(...args)=>{
 await broker.onProviderResult(...args);
 if(boundary==='result'){process.send!({type:'result',attempt_id:args[2].id});await new Promise(()=>{})}
};
const worker=transport.consume('image',1,async delivery=>{
 const result=await executeRequest(pool,{...deps,limits:{backend:'bullmq',generation:delivery.generation}},delivery.request_id);
 if(boundary==='settled'){process.send!({type:'settled',state:result.state});await new Promise(()=>{})}
 return result;
},error=>process.send?.({type:'fault',message:error.message}));
await worker.waitUntilReady();
process.send({type:'ready'});
