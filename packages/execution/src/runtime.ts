import {NativeSubmissionFailure} from '../../providers/src/replicate.js';
import {validateEmbeddingOutput} from '../../providers/src/embeddings.js';
import {observePrefix} from '../../quoting/src/cache.js';
import {JsonFieldParser} from '../../contracts/json-fields.js';
import type {z} from 'zod';
import type {AttemptEvent,DeltaEvent,ExecutionPolicy} from '../../contracts/invocation.js';
import {validateToolCalls} from '../../providers/src/text-input.js';
import {validateStructured} from '../../contracts/schema.js';
export {validateStructured} from '../../contracts/schema.js';
import {selectedVariant} from './index.js';
import {settleApiMeasurements,apiItems,priceApi,validateApiOutput,type ServiceOperation} from '../../api-services/src/index.js';
import {observeAttemptAllowance,allowanceCost} from '../../allowance/src/execution.js';
import {financialMaintenance} from './financial-maintenance.js';
import {lockExecutionAccount,tryLockExecutionAccount,lockLegacyCapacity} from '../../db/src/execution-lock.js';
import {deliverQuotaFeedback} from './quota-feedback.js';
import {Rational} from '../../model-pricing/src/index.js';
import { runOperationalMonitors } from '../../runtime-operations/src/index.js';
import { consumeExecutionEvents, dispatchOne, type WebhookSender } from '../../notifications/src/index.js';
import sharp from 'sharp';
import { validateAudio } from './audio-validation.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type pg from 'pg';
import { DomainError, id, systemClock, type Clock, type Scope, type QuotaWaitDetails } from '../../contracts/src/index.js';
import { transaction,emit, type Tx } from '../../db/src/index.js';
import { persistObservation, persistCost, customerRating, rateMaximum, type RateCard } from '../../pricing/src/index.js';
import type { ProviderAdapter, ProviderInput, ProviderResult, AdapterContext } from '../../providers/src/contracts.js';
import { createManifest, registerAsset, getAsset, contentHash, type BlobStore, expireContent, leasePurge, purgeBlob, completePurge, finalizeDeletions } from '../../storage/src/index.js';
import { getRequest, closeUnsentIfRequired, leaseNext, prepareDispatch, renewLease, recordRemoteJob, leaseObservation, observeAttempt, recoverExpiredLeases, type RouteVariant, type Settlement, type LeaseLimits } from './index.js';
export interface WorkContext { api_snapshot?:{definition:ServiceOperation;measurements:Record<string,string>}; limit_usage_estimate?:import('../../providers/src/contracts.js').LimitUsage; expected_output_tokens?:number; input:ProviderInput; accepted_rate_card:RateCard; current_rate_card:RateCard; accepted_at:string; maximum_items?:any[]; price_increase_allowed?:boolean; conditions?:Record<string,string> }
export interface WorkerDependencies {
 renewAdmission?(request:any,attempt:any):Promise<void>;
 onNativePending?(request:any,attempt:any):Promise<void>;
 onProviderResult?(scope:Scope,request:any,attempt:any,result:ProviderResult):Promise<void>;
 admit?(scope:Scope,request:any,variant:RouteVariant,context:WorkContext,adapter:ProviderAdapter):Promise<{allowed:true;admission_id:string}|{allowed:false;reason:string;retry_at?:Date;quota_wait?:QuotaWaitDetails}>;
 onRateLimits?(scope:Scope,request:any,attempt:any,observation:import('../../providers/src/contracts.js').RateLimitObservation):Promise<void>;
 blobStore:BlobStore;
 context(scope:Scope,request:any,variant:RouteVariant):Promise<WorkContext>;
 adapter(scope:Scope,variant:RouteVariant,context:WorkContext):Promise<ProviderAdapter>;
 observationContext?(scope:Scope,request:any,attempt:any):Promise<WorkContext>;
 settle:Settlement;
 onAttempt?:(scope:Scope,event:z.infer<typeof AttemptEvent>)=>Promise<void>;
 onDelta?:(scope:Scope,requestId:string,delta:string,event:z.infer<typeof DeltaEvent>)=>Promise<void>;
 limits?:LeaseLimits;
 variantAvailable?:(tx:Tx,scope:Scope,variant:RouteVariant)=>Promise<boolean>;
 onConnectionFailure?:(scope:Scope,variant:RouteVariant,kind:'auth'|'quota')=>Promise<void>;
}
const scopeOf=(r:any):Scope=>({organization_id:r.organization_id,application_id:r.application_id,account_id:r.account_id});
/** Conservative local checks; provider-specific validation remains in its adapter. */
export async function validateOutput(output:{content_type:string;text?:string;bytes?:Uint8Array},schema?:Record<string,unknown>,imageSize?:string){
 const fail=()=>{throw new DomainError('result_defect');};
 if(output.content_type.startsWith('image/')){
  const bytes=output.bytes??(output.text?Buffer.from(output.text):undefined);if(!bytes?.length)return fail();
  if(output.content_type==='image/svg+xml'){
   const xml=Buffer.from(bytes).toString('utf8');if(/<\?(?!xml\s)|<!DOCTYPE|<!ENTITY|<(?:[\w-]+:)?(?:script|foreignObject|style|animate|animateMotion|animateTransform|set|discard)\b/i.test(xml)||XMLValidator.validate(xml)!==true)return fail();
   const parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',processEntities:false}).parse(xml);if(!parsed.svg)return fail();
   const inspect=(v:any):void=>{if(!v||typeof v!=='object')return;for(const [key,value] of Object.entries(v)){if(key.startsWith('@_')){const k=key.slice(2).toLowerCase();if(k.startsWith('on')||((k.endsWith('href')||k==='src')&&!String(value).startsWith('#'))||(/url\s*\(|@import|[\\]/i.test(String(value))))fail();}else inspect(value);}};inspect(parsed.svg);
  }
  try{const decoder=sharp(bytes,{failOn:'warning',limitInputPixels:16777216});const info=await decoder.metadata();if(imageSize&&/^\d+x\d+$/.test(imageSize)){const [width,height]=imageSize.split('x').map(Number);if(info.width!==width||info.height!==height)return fail();}const types:Record<string,string>={'image/png':'png','image/jpeg':'jpeg','image/webp':'webp','image/svg+xml':'svg','image/gif':'gif'};if(!types[output.content_type]||info.format!==types[output.content_type])return fail();await decoder.raw().toBuffer();}catch{return fail();}
  return;
 }
 if(output.content_type.startsWith('audio/')){if(!output.bytes)return fail();await validateAudio(output.content_type,output.bytes);return;}
 if(output.bytes){if(!output.bytes.length)return fail();return;}
 if(!output.text?.trim())return fail();if(output.content_type==='application/json'||schema){try{const value=JSON.parse(output.text);if(schema)validateStructured(value,schema);}catch(error){if(error instanceof DomainError)throw error;return fail();}}
}

/** One durable lease. No database transaction is held during execute or blob I/O. */
export async function executeOne(pool:pg.Pool,deps:WorkerDependencies,clock:Clock=systemClock,worker=id('worker')):Promise<{worked:boolean;request_id?:string;state?:string}>{
 const request=await transaction(pool,t=>leaseNext(t,clock,worker,deps.limits,deps.settle));
 return request?executeLeasedRequest(pool,deps,clock,request):{worked:false};
}
/** Transport delivery is only a wake-up: durable state decides whether execution is allowed. */
export async function executeRequest(pool:pg.Pool,deps:WorkerDependencies,requestId:string,clock:Clock=systemClock,worker=id('worker')):Promise<{worked:boolean;request_id?:string;state?:string}>{
 let request;
 try{request=await transaction(pool,t=>leaseNext(t,clock,worker,deps.limits,deps.settle,requestId,true))}
 catch(error){if(!(error instanceof DomainError)||error.code!=='execution_closure_required')throw error;
  await transaction(pool,t=>closeUnsentIfRequired(t,clock,requestId,deps.limits??{},deps.settle));return {worked:true,request_id:requestId,state:'closure_checked'};
 }
 return request?executeLeasedRequest(pool,deps,clock,request):{worked:false};
}
async function executeLeasedRequest(pool:pg.Pool,deps:WorkerDependencies,clock:Clock,request:any):Promise<{worked:boolean;request_id?:string;state?:string}>{
 const scope=scopeOf(request);
 const route=request.route;let selected:RouteVariant=selectedVariant(request);
 const recovered=(await pool.query(`SELECT working_endpoint_scope FROM execution_incidents WHERE organization_id=$1 AND failure_scope=$2 AND status='recovered'`,[scope.organization_id,route.primary.endpoint_scope])).rows[0];if(recovered?.working_endpoint_scope&&recovered.working_endpoint_scope!==route.primary.endpoint_scope)selected=route.fallback;
 if(selected?.eligible===false)selected=route.fallback;if(!selected)throw new DomainError('route_exhausted');
 let context:WorkContext,adapter:ProviderAdapter;
 try{
  if(deps.variantAvailable&&!await deps.variantAvailable(pool,scope,selected)){
   if(request.slot>=2||!route.fallback||!await deps.variantAvailable(pool,scope,route.fallback))throw new DomainError('connection_disabled');selected=route.fallback;
  }
  context=await deps.context(scope,request,selected);adapter=await deps.adapter(scope,selected,context);adapter.validate(context.input);
 }
 catch(error){await transaction(pool,async t=>{await observePreDispatchFailure(t,scope,clock,request,error,deps.settle);});return {worked:true,request_id:request.id,state:'failed'};}
 // A price increase can spend only a separately approved platform allowance.
 if(context.maximum_items?.length&&!context.price_increase_allowed){const maximum=rateMaximum({state:'known',items:context.maximum_items},context.current_rate_card,{at:clock.now().toISOString(),connection_id:selected.connection_id,conditions:context.conditions});const acceptedMaximum=rateMaximum({state:'known',items:context.maximum_items},context.accepted_rate_card,{at:context.accepted_at,connection_id:selected.connection_id,conditions:context.conditions});if(maximum.state!=='calculated'||acceptedMaximum.state!=='calculated'||maximum.rounded_units>acceptedMaximum.rounded_units){await transaction(pool,async t=>{await t.query(`UPDATE execution_requests SET execution_status='paused',reason='requote_required',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND fencing_token=$2`,[request.id,request.fencing_token]);});return {worked:true,request_id:request.id,state:'paused'};}}
 let admissionId:string|undefined;
 if(deps.admit&&request.execution_backend==='bullmq'){
  let admission:Awaited<ReturnType<NonNullable<WorkerDependencies['admit']>>>;
  try{admission=await deps.admit(scope,request,selected,context,adapter)}catch(error){admission={allowed:false,reason:error instanceof DomainError?error.code:'quota_infrastructure_unavailable',retry_at:new Date(clock.now().getTime()+5000)}}
  if(!admission.allowed){
   await transaction(pool,async tx=>{
    const updated=await tx.query(`UPDATE execution_requests SET execution_status=$3,reason=$4,not_before=$5,lease_owner=NULL,lease_expires_at=NULL,quota_wait=$6 WHERE id=$1 AND fencing_token=$2 AND execution_status='leased' RETURNING id`,[request.id,request.fencing_token,admission.retry_at?'waiting_retry':'paused',admission.reason,admission.retry_at??clock.now(),admission.quota_wait??null]);
    if(updated.rowCount)await emit(tx,scope,'request.waiting_rate_limit',{type:'request',id:request.id},{reason:admission.reason,next_retry_at:admission.retry_at?.toISOString()});
   });return {worked:true,request_id:request.id,state:admission.retry_at?'waiting':'paused'};
  }
  admissionId=admission.admission_id;
 }
 let attempt:any;
 try{attempt=await transaction(pool,t=>prepareDispatch(t,scope,clock,request.id,request.fencing_token,async(t,v)=>v.connection_id===selected.connection_id&&v.model===selected.model&&(!deps.variantAvailable||await deps.variantAvailable(t,scope,v)),admissionId));}
 catch(error){if(error instanceof DomainError&&['execution_limit_changed','platform_risk_budget_exhausted','attempt_limit','route_exhausted','allowance_exhausted','overage_budget_exhausted','subscription_not_started'].includes(error.code)){await transaction(pool,t=>observePreDispatchFailure(t,scope,clock,request,error,deps.settle));return {worked:true,request_id:request.id,state:'failed'};}await transaction(pool,async t=>{await t.query(`UPDATE execution_requests SET execution_status='paused',reason=$3,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND fencing_token=$2 AND execution_status='leased'`,[request.id,request.fencing_token,error instanceof DomainError?error.code:'dispatch_failed']);});return {worked:true,request_id:request.id,state:'paused'};}
 if(!attempt)return {worked:true,request_id:request.id,state:'waiting'};
 const envelope={request_id:request.id,attempt_id:attempt.id,attempt_number:attempt.number,generation:String(request.fencing_token)};
 await deps.onAttempt?.(scope,{type:'attempt',...envelope}).catch(()=>{});
 // The actual route can skip unavailable primary slots. Rebuild trusted context for that target.
 if(attempt.variant.connection_id!==selected.connection_id||attempt.variant.model!==selected.model){context=await deps.context(scope,request,attempt.variant);adapter=await deps.adapter(scope,attempt.variant,context);adapter.validate(context.input);}
 if(adapter.capabilities.native_jobs){
  if(!adapter.submitNative||!adapter.lookupNative)throw new DomainError('native_contract_missing');
  await transaction(pool,t=>t.query('UPDATE execution_attempts SET native_validation=$2 WHERE id=$1',[attempt.id,{capability:context.input.capability,model:context.input.model,parameters:context.input.parameters,response_schema:context.input.response_schema,tools:context.input.tools,tool_choice:context.input.tool_choice,parallel_tool_calls:context.input.parallel_tool_calls,service_mode:context.input.service_mode}]));
  const nativeContext=observationCallbacks(pool,deps,scope,clock,request,attempt);
  const abort=new AbortController();let leaseLost=false,inFlight:Promise<void>|undefined;
  const deadline=setTimeout(()=>abort.abort(),Math.max(1,Math.min(30000,new Date(request.deadline_at).getTime()-clock.now().getTime())));deadline.unref();
  nativeContext.signal=abort.signal;
  const heartbeat=setInterval(()=>{
   if(inFlight)return;
   inFlight=(async()=>{
    await deps.renewAdmission?.(request,attempt);
    await transaction(pool,async tx=>{
     await renewLease(tx,scope,clock,request.id,request.fencing_token);
     const current=await getRequest(tx,scope,request.id);
     if(current.cancel_requested_at||new Date(current.deadline_at)<=clock.now())abort.abort();
    });
   })().catch(()=>{leaseLost=true;abort.abort()}).finally(()=>{inFlight=undefined});
  },5000);heartbeat.unref();
  let submissionFailed=false,submissionResult:ProviderResult|undefined;
  try{const submitted=await adapter.submitNative(context.input,nativeContext);await nativeContext.onRemoteJob!(submitted.job_id);}
  catch(error){submissionFailed=true;if(error instanceof NativeSubmissionFailure)submissionResult=error.result;}
  finally{clearInterval(heartbeat);clearTimeout(deadline);await inFlight;}
  if(submissionFailed){
   const saved=(await pool.query('SELECT remote_job_id FROM execution_attempts WHERE id=$1',[attempt.id])).rows[0];
   if(!saved.remote_job_id){
    const result:ProviderResult=submissionResult??{outcome:'unknown',failure:{kind:'unknown',code:'native_submission_unknown',sent:true},usage:{state:'unknown',reason:'native_submission_unknown'}};
    await deliverQuotaFeedback(pool,deps.onProviderResult,scope,request,attempt,result);
    if(leaseLost)return {worked:true,request_id:request.id,state:'lease_lost'};
    return finalizeProviderResult(pool,deps,clock,request,attempt,context,result,'native-submission-unknown');
   }
  }
  if(leaseLost)return {worked:true,request_id:request.id,state:'lease_lost'};
  await deps.onNativePending?.(request,attempt);
  await releaseObservation(pool,clock,request,attempt,0);return {worked:true,request_id:request.id,state:'running'};
 }
 const abort=new AbortController();let leaseLost=false,inFlight:Promise<void>|undefined;const deadlineTimer=setTimeout(()=>abort.abort(),Math.max(1,new Date(request.deadline_at).getTime()-clock.now().getTime()));deadlineTimer.unref();
 // A silent call is cut before the deadline so that a retry can still fit; whichever timer fires first wins.
 const policy=request.route.execution as ExecutionPolicy|undefined;let timedOut=false;
 const attemptTimer=policy?.attempt_timeout_seconds?setTimeout(()=>{timedOut=true;abort.abort()},policy.attempt_timeout_seconds*1000):undefined;attemptTimer?.unref();
 const heartbeat=setInterval(()=>{
  if(inFlight)return;
  inFlight=(async()=>{
   await deps.renewAdmission?.(request,attempt);
   await transaction(pool,async t=>{
    await renewLease(t,scope,clock,request.id,request.fencing_token);
    const current=await getRequest(t,scope,request.id);
    if(current.cancel_requested_at||new Date(current.deadline_at)<=clock.now())abort.abort();
   });
  })().catch(()=>{leaseLost=true;abort.abort()}).finally(()=>{inFlight=undefined});
 },5000);heartbeat.unref();
 let result:ProviderResult;let outputStarted=false,sequence=0;let parser=request.route.delivery?.field_paths?.length?new JsonFieldParser(request.route.delivery.field_paths):undefined;let parserFailed=false;
 try{result=await adapter.execute(context.input,{attempt_id:attempt.id,idempotency_key:attempt.provider_idempotency_key,signal:abort.signal,onRateLimits:deps.onRateLimits?async observation=>{await deps.onRateLimits!(scope,request,attempt,observation).catch(()=>{console.error('quota_observation_failed')})}:undefined,onUsage:async observation=>{await transaction(pool,t=>persistObservation(t,scope,{...observation,attempt_id:attempt.id,connection_id:attempt.variant.connection_id,model:attempt.variant.model},clock));},onDelta:deps.onDelta?async delta=>{
   const current=await getRequest(pool,scope,request.id);
   if(String(current.fencing_token)!==String(request.fencing_token)||current.cancel_requested_at||new Date(current.deadline_at)<=clock.now())return;
   if(!outputStarted){await transaction(pool,async t=>{await t.query(`UPDATE execution_requests SET reason='output_started' WHERE id=$1 AND fencing_token=$2 AND execution_status IN ('submitting','running')`,[request.id,request.fencing_token]);await t.query('UPDATE execution_attempts SET provider_first_delta_at=COALESCE(provider_first_delta_at,$2) WHERE id=$1',[attempt.id,clock.now()]);});outputStarted=true;}
   let deltas:Array<{field_path:string;text:string}>=[];
   if(!parserFailed){try{deltas=parser?parser.push(delta):[{field_path:'',text:delta}]}catch{parserFailed=true;}}
   for(const part of deltas){for(let start=0;start<part.text.length;start+=500){const text=part.text.slice(start,start+500);await deps.onDelta!(scope,request.id,text,{type:'delta',...envelope,sequence:++sequence,field_path:part.field_path,text}).catch(()=>{});}}
  }:undefined});}
 catch {result={outcome:'unknown',failure:{kind:'unknown',code:'worker_observation_failure',sent:true},usage:{state:'unknown',reason:'execution_interrupted'}};}
 finally{clearInterval(heartbeat);clearTimeout(deadlineTimer);clearTimeout(attemptTimer);await inFlight;}
 if(timedOut&&!leaseLost&&result.outcome==='unknown'){
  // Retry only where the provider deduplicates by key, or where the profile accepted a possible second charge.
  const idempotent=adapter.capabilities.idempotency;
  result={outcome:'failure',failure:{kind:'transient',code:'attempt_timeout',sent:true,safe_to_retry:idempotent||policy?.timeout_retry==='accept_duplicate_cost'},usage:result.usage,provider_request_id:result.provider_request_id};
  await pool.query('UPDATE execution_attempts SET timed_out_at=COALESCE(timed_out_at,$2),reuse_idempotency_key=$3 WHERE id=$1',[attempt.id,clock.now(),idempotent]);
 }
 await deliverQuotaFeedback(pool,deps.onProviderResult,scope,request,attempt,result);
 if(result.outcome!=='success'&&(result.failure.kind==='auth'||result.failure.kind==='quota'))await deps.onConnectionFailure?.(scope,attempt.variant,result.failure.kind);
 if(leaseLost)return {worked:true,request_id:request.id,state:'lease_lost'};
 return finalizeProviderResult(pool,deps,clock,request,attempt,context,result,'worker-final');
}
async function finalizeProviderResult(pool:pg.Pool,deps:WorkerDependencies,clock:Clock,request:any,attempt:any,context:WorkContext,result:ProviderResult,observationKey:string){
 const scope=scopeOf(request);
 const apiSnapshot=context.api_snapshot;
 if(apiSnapshot){const measured=settleApiMeasurements(apiSnapshot.definition,apiSnapshot.measurements,result.usage);if(measured)result={...result,usage:{...result.usage,state:'known',items:apiItems(apiSnapshot.definition,measured)}};}
 if(result.outcome==='success'){try{if(context.input.capability==='embeddings.generate')result={...result,output:{...result.output,embeddings:validateEmbeddingOutput(result.output.embeddings,context.input)}};if(context.input.tools)validateToolCalls(context.input,result.output.tool_calls??(result.output.tool_call?[result.output.tool_call]:[]));else if(result.output.tool_call||result.output.tool_calls)throw new DomainError('result_defect');if(apiSnapshot)validateApiOutput(apiSnapshot.definition,result.output.text??'');await validateOutput(result.output,context.input.response_schema?.schema,context.input.capability.startsWith('image.')?String(context.input.parameters?.size??''):undefined);}catch(error){result={outcome:'failure',failure:{kind:'defect',code:'technical_validation_failed',sent:true,...(error instanceof DomainError&&error.details.path?{validation:{path:String(error.details.path),reason:String(error.details.reason)}}:{})},usage:result.usage,provider_request_id:result.provider_request_id};}}
 if(result.outcome==='failure'&&result.failure.validation)await pool.query('UPDATE execution_attempts SET validation_error=$2 WHERE id=$1',[attempt.id,result.failure.validation]);
 await transaction(pool,t=>observeAttemptAllowance(t,scope,clock,attempt,result,observationKey));
 const ratingContext={at:clock.now().toISOString(),accepted_at:context.accepted_at,connection_id:attempt.variant.connection_id,conditions:context.conditions};
 // Provider cost is persisted even when output is invalid or cannot be retained.
 const existingCost=result.usage.state==='known'?(await pool.query('SELECT * FROM provider_cost_entries WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND identity=$4',[scope.organization_id,scope.application_id,scope.account_id,`attempt:${attempt.id}:final`])).rows[0]:null;
 const cost=existingCost??await transaction(pool,async t=>persistCost(t,scope,{identity:`attempt:${attempt.id}:${result.usage.state==='known'?'final':observationKey}`,attempt_id:attempt.id,connection_id:attempt.variant.connection_id,model:attempt.variant.model,usage:result.usage,rate_card:context.current_rate_card,context:ratingContext,allowance_cost:await allowanceCost(t,scope,attempt.id)},clock));
 const rated=customerRating(result.usage,context.accepted_rate_card,context.current_rate_card,ratingContext);const pricing=attempt.variant.usage_pricing;let charged=rated.state==='calculated'?(pricing?Rational.from(rated.exact_amount).mul(Rational.from('1000000000')).mul(Rational.from('1').add(Rational.from(pricing.markup_percent).div(Rational.from('100')))).round(Rational.from(pricing.rounding_units),'ceil').integer():(rated.rounded_units>BigInt(request.max_units)?BigInt(request.max_units):rated.rounded_units)).toString():undefined;
 if(pricing&&attempt.variant.overdraft_allowed!==true&&charged!==undefined&&BigInt(charged)>BigInt(request.max_units))charged=request.max_units;
 if(apiSnapshot){const measurements=settleApiMeasurements(apiSnapshot.definition,apiSnapshot.measurements,result.usage);if(measurements){const calculated=BigInt(priceApi(apiSnapshot.definition,measurements,context.accepted_rate_card,ratingContext,cost.rounded_units??undefined));charged=(calculated>BigInt(request.max_units)?BigInt(request.max_units):calculated).toString();}else charged=undefined;}
 let blobKey:string|undefined;let outputAssetId:string|undefined;
 if(result.outcome==='success'&&result.output.bytes){
  blobKey=id('blob');const output=result.output;
  try{
   // Commit the blob identity first. A crash during upload still leaves a purgeable owner record.
   const asset=await transaction(pool,t=>registerAsset(t,scope,clock,{kind:'output',blob_key:blobKey!,content_hash:contentHash(output.bytes!),media_type:output.content_type,size_bytes:output.bytes!.length,operation_id:request.operation_id,external_project_id:request.external_project_id??undefined,project_generation:request.project_generation??undefined,expires_at:new Date(clock.now().getTime()+request.content_ttl_seconds*1000)}));outputAssetId=asset.id;
   await transaction(pool,async t=>{
    // Only a content-scope advisory lock is held during blob I/O, never account/wallet locks.
    await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[[scope.organization_id,scope.application_id,scope.account_id].join(':')]);
    await getAsset(t,scope,clock,asset.id);await deps.blobStore.put(blobKey!,output.bytes!);
   });
  }catch{if(blobKey)await deps.blobStore.delete(blobKey).catch(()=>{});return finishUnavailable();}
 }
 if(attempt.variant.cache_identity&&result.usage.state==='known')await transaction(pool,t=>observePrefix(t,scope,clock,attempt.variant.connection_id,attempt.variant.model,attempt.variant.cache_identity,result.usage)).catch(()=>{});
 const finalResult=result;
 try{return await transaction(pool,async t=>{
  await lockExecutionAccount(t,scope);
  if(finalResult.outcome==='refused'){await createManifest(t,scope,clock,{request_id:request.id,operation_id:request.operation_id,external_project_id:request.external_project_id??undefined,project_generation:request.project_generation??undefined,content:{type:'refused',reason:finalResult.refusal},ttl_seconds:request.content_ttl_seconds});}
  if(finalResult.outcome==='success'){
   const assets:string[]=outputAssetId?[outputAssetId]:[];
   await createManifest(t,scope,clock,{request_id:request.id,operation_id:request.operation_id,external_project_id:request.external_project_id??undefined,project_generation:request.project_generation??undefined,content:finalResult.output.embeddings?{type:'embeddings',...finalResult.output.embeddings}:finalResult.output.tool_calls?{type:'tool_calls',calls:finalResult.output.tool_calls}:finalResult.output.tool_call?{type:'tool_call',...finalResult.output.tool_call,provider_id:finalResult.output.tool_call.provider_id??finalResult.output.tool_call.id}:context.input.response_schema||finalResult.output.content_type==='application/json'?{type:'structured',content_type:finalResult.output.content_type,text:finalResult.output.text,value:JSON.parse(finalResult.output.text!)}:{type:'text',content_type:finalResult.output.content_type,...(finalResult.output.text!==undefined?{text:finalResult.output.text}:{})},asset_ids:assets,ttl_seconds:request.content_ttl_seconds});
  }
  const row=await observeAttempt(t,scope,clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:observationKey,outcome:finalResult.outcome==='success'?'success':finalResult.failure.kind,cost_units:cost.rounded_units??(finalResult.outcome==='failure'&&finalResult.failure.billable===false?'0':undefined),charged_units:charged,safe_to_retry:finalResult.outcome==='failure'&&finalResult.failure.safe_to_retry===true,retry_after_ms:finalResult.outcome==='failure'?finalResult.failure.retry_after_ms:undefined,result_available:finalResult.outcome==='success',remote_request_id:finalResult.provider_request_id},deps.settle);return {worked:true,request_id:request.id,state:row.execution_status};
 });}catch(error){if(blobKey)await deps.blobStore.delete(blobKey).catch(()=>{});if(error instanceof DomainError&&['content_deleted','content_unavailable'].includes(error.code))return finishUnavailable();throw error;}
 async function finishUnavailable(){const row=await transaction(pool,t=>observeAttempt(t,scope,clock,{request_id:request.id,attempt_id:attempt.id,fence:request.fencing_token,observation_key:`${observationKey}:unavailable`,outcome:result.outcome==='refused'?'refused':'success',cost_units:cost.rounded_units??undefined,charged_units:charged,result_available:false},deps.settle));return {worked:true,request_id:request.id,state:row.execution_status};}
}
async function observePreDispatchFailure(t:Tx,s:Scope,clock:Clock,r:any,error:unknown,settle:Settlement){await lockExecutionAccount(t,s);const code=error instanceof DomainError?error.code:'provider_configuration_missing';const updated=await t.query(`UPDATE execution_requests SET execution_status='failed',reason=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND execution_status='leased' AND fencing_token=$3 AND lease_expires_at>$4 RETURNING id`,[r.id,code,r.fencing_token,clock.now()]);if(!updated.rowCount)throw new DomainError('stale_lease');if(r.incident_id)await t.query(`UPDATE execution_incidents SET owner_request_id=NULL,lease_owner=NULL,lease_expires_at=NULL,status=CASE WHEN status='probing' THEN 'recovery_wait' ELSE status END WHERE id=$1 AND owner_request_id=$2`,[r.incident_id,r.id]);await settle(t,s,{request_id:r.id,charged_units:'0',reason:code,idempotency_key:`execution:${r.id}:settled`});await t.query(`UPDATE execution_requests SET settlement_status='settled',financial_closed_at=$2 WHERE id=$1`,[r.id,clock.now()]);}
export async function schedulerTick(pool:pg.Pool,deps:WorkerDependencies&{webhookSender?:WebhookSender;secretResolver?:(reference:string)=>Promise<string>},clock:Clock=systemClock,worker=id('scheduler')){
 const scope=deps.limits?.scope;const recovered=await transaction(pool,t=>recoverExpiredLeases(t,clock,scope));const financial=await financialMaintenance(pool,clock,deps.settle,scope);const state={...financial,recovered,expired:await transaction(pool,t=>expireContent(t,clock,scope))};
 const native=await observeNativeOne(pool,deps,clock,worker);
 const job=await transaction(pool,t=>leasePurge(t,clock,worker,scope));if(job){let error:string|undefined;try{await purgeBlob(deps.blobStore,job);}catch{error='blob_delete_failed';}await transaction(pool,t=>completePurge(t,clock,job.id,worker,error));}
 await transaction(pool,t=>finalizeDeletions(t));const monitors=await runOperationalMonitors(pool,clock);const events=await consumeExecutionEvents(pool,clock);const delivery=await dispatchOne(pool,clock,deps.secretResolver,deps.webhookSender);return {...state,native,purged:!!job,monitors:monitors.observations,events,delivery:delivery?.status??null};
}

function observationCallbacks(pool:pg.Pool,deps:WorkerDependencies,scope:Scope,clock:Clock,request:any,attempt:any):AdapterContext {
 return {attempt_id:attempt.id,idempotency_key:attempt.provider_idempotency_key,signal:AbortSignal.timeout(30000),onRateLimits:async observation=>{await deps.onRateLimits?.(scope,request,attempt,observation).catch(()=>{console.error('quota_observation_failed')})},onRemoteJob:async jobId=>{if(!jobId||jobId.length>1000)throw new DomainError('invalid_remote_job');await transaction(pool,t=>recordRemoteJob(t,scope,clock,request.id,request.fencing_token,attempt.id,jobId));},onUsage:async observation=>{await transaction(pool,t=>persistObservation(t,scope,{...observation,attempt_id:attempt.id,connection_id:attempt.variant.connection_id,model:attempt.variant.model},clock));}};
}
async function releaseObservation(pool:pg.Pool,clock:Clock,request:any,attempt:any,delayMs:number){
 await transaction(pool,async t=>{const row=await t.query('UPDATE execution_requests SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND fencing_token=$2 AND lease_expires_at>$3 RETURNING id',[request.id,request.fencing_token,clock.now()]);if(!row.rowCount)throw new DomainError('stale_lease');await t.query('UPDATE execution_attempts SET next_poll_at=$2 WHERE id=$1',[attempt.id,new Date(clock.now().getTime()+delayMs)]);});
}
/** Observe one existing native job. Never invokes submit/execute or creates an attempt. */
export async function observeNativeOne(pool:pg.Pool,deps:WorkerDependencies,clock:Clock=systemClock,worker=id('observer')){
 return observeNative(pool,deps,clock,worker);
}
export interface NativeObservationDelivery {request_id:string;generation:number;poll_count:number}
/** Exact durable observation identity. A stale transport job must not poll another request. */
export async function observeNativeRequest(pool:pg.Pool,deps:WorkerDependencies,delivery:NativeObservationDelivery,clock:Clock=systemClock,worker=id('observer')){
 if(!delivery.request_id||!Number.isSafeInteger(delivery.generation)||delivery.generation<0||!Number.isSafeInteger(delivery.poll_count)||delivery.poll_count<0)throw new DomainError('invalid_observation_delivery');
 return observeNative(pool,deps,clock,worker,delivery);
}
async function observeNative(pool:pg.Pool,deps:WorkerDependencies,clock:Clock,worker:string,delivery?:NativeObservationDelivery):Promise<{worked:boolean;request_id?:string;state?:string}>{
 const scope=deps.limits?.scope;
 const selected=await transaction(pool,async t=>{
  let policy:any;
  if(delivery){
   policy=(await t.query("SELECT * FROM execution_dispatch_policies WHERE queue_kind='observe' FOR UPDATE")).rows[0];
   if(!policy)throw new DomainError('observation_policy_missing');
  }else{
   await lockLegacyCapacity(t);
   const active=(await t.query("SELECT count(*)::int n FROM execution_requests WHERE execution_backend='legacy' AND lease_expires_at>$1 AND execution_status IN ('leased','submitting','running') AND ($2::text IS NULL OR (organization_id=$2 AND application_id=$3 AND account_id=$4))",[clock.now(),scope?.organization_id??null,scope?.application_id??null,scope?.account_id??null])).rows[0].n;if(active>=(deps.limits?.global??16))return null;
  }
  const r=(await t.query(`SELECT r.* FROM execution_requests r JOIN execution_attempts a ON a.request_id=r.id AND a.number=r.attempt_count WHERE a.remote_job_id IS NOT NULL AND ($8::text IS NULL OR r.execution_backend=$8) AND ($5::text IS NULL OR (r.id=$5 AND r.execution_backend='bullmq' AND r.dispatch_generation=$6 AND a.poll_count=$7)) AND (r.execution_status IN ('running','outcome_unknown') OR (r.execution_status IN ('succeeded','canceled','refused') AND a.cost_units IS NULL)) AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=$1) AND (a.next_poll_at IS NULL OR a.next_poll_at<=$1) AND r.deadline_at+INTERVAL '1 hour'>$1 AND ($2::text IS NULL OR (r.organization_id=$2 AND r.application_id=$3 AND r.account_id=$4)) ORDER BY a.next_poll_at NULLS FIRST,r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,[clock.now(),scope?.organization_id??null,scope?.application_id??null,scope?.account_id??null,delivery?.request_id??null,delivery?.generation??null,delivery?.poll_count??null,deps.limits?.backend??(delivery?'bullmq':'legacy')])).rows[0];if(!r)return null;
  if(!await tryLockExecutionAccount(t,scopeOf(r)))return null;
  if(policy){
   const counts=(await t.query(`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE r.organization_id=$2 AND r.application_id=$3)::int AS application,
    count(*) FILTER(WHERE r.organization_id=$2 AND r.application_id=$3 AND r.account_id=$4)::int AS account
    FROM execution_requests r JOIN execution_attempts a ON a.request_id=r.id AND a.number=r.attempt_count
    WHERE r.execution_backend='bullmq' AND r.lease_expires_at>$1 AND a.observation_fence=r.fencing_token`,[clock.now(),r.organization_id,r.application_id,r.account_id])).rows[0];
   if(counts.total>=policy.queue_limit||counts.application>=policy.application_limit||counts.account>=policy.account_limit)return null;
  }
  const leased=await leaseObservation(t,scopeOf(r),clock,r.id,worker);
  const attempt=(await t.query(delivery
   ?'UPDATE execution_attempts SET poll_count=poll_count+1,observation_fence=$3 WHERE request_id=$1 AND number=$2 RETURNING *'
   :'UPDATE execution_attempts SET poll_count=poll_count+1 WHERE request_id=$1 AND number=$2 RETURNING *',
   delivery?[r.id,r.attempt_count,leased.fencing_token]:[r.id,r.attempt_count])).rows[0];return {request:leased,attempt};
 });
 if(!selected)return {worked:false};const {request,attempt}=selected,s=scopeOf(request);const delay=Math.min(60000,1000*2**Math.min(attempt.poll_count,6));
 let context:WorkContext,adapter:ProviderAdapter;
 try{context=deps.observationContext?await deps.observationContext(s,request,attempt):await deps.context(s,request,attempt.variant);adapter=await deps.adapter(s,attempt.variant,context);if(!adapter.lookupNative||!adapter.capabilities.lookup)throw new DomainError('native_lookup_unavailable');}
 catch{await releaseObservation(pool,clock,request,attempt,delay);return {worked:true,request_id:request.id,state:'observation_unavailable'};}
 const callbacks=observationCallbacks(pool,deps,s,clock,request,attempt);let result:ProviderResult|{outcome:'pending'};
 try{
  if(request.cancel_requested_at&&adapter.cancelNative&&adapter.capabilities.cancel&&!attempt.cancel_dispatched_at){await transaction(pool,t=>t.query('UPDATE execution_attempts SET cancel_dispatched_at=$2 WHERE id=$1 AND cancel_dispatched_at IS NULL',[attempt.id,clock.now()]));await adapter.cancelNative(attempt.remote_job_id,callbacks);}
  result=await adapter.lookupNative!(attempt.remote_job_id,callbacks);
 }catch{await releaseObservation(pool,clock,request,attempt,delay);return {worked:true,request_id:request.id,state:'lookup_unknown'};}
 if(result.outcome==='pending'){await deps.onNativePending?.(request,attempt);await releaseObservation(pool,clock,request,attempt,delay);return {worked:true,request_id:request.id,state:'running'};}
 await deliverQuotaFeedback(pool,deps.onProviderResult,s,request,attempt,result);
 const final=await finalizeProviderResult(pool,deps,clock,request,attempt,context,result,`native-poll:${attempt.poll_count}`);await pool.query('UPDATE execution_attempts SET next_poll_at=$2 WHERE id=$1',[attempt.id,new Date(clock.now().getTime()+delay)]);return final;
}
/** Provider adapters must verify the original bytes before this accepts a job event. */
export async function receiveNativeWebhook(pool:pg.Pool,deps:WorkerDependencies,scope:Scope,clock:Clock,requestId:string,body:Uint8Array,headers:Record<string,string>){
 const request=await getRequest(pool,scope,requestId);const attempt=(await pool.query('SELECT * FROM execution_attempts WHERE request_id=$1 AND number=$2',[request.id,request.attempt_count])).rows[0];if(!attempt?.remote_job_id)throw new DomainError('native_job_not_found');
 const context=deps.observationContext?await deps.observationContext(scope,request,attempt):await deps.context(scope,request,attempt.variant);const adapter=await deps.adapter(scope,attempt.variant,context);if(!adapter.verifyNativeWebhook)throw new DomainError('native_webhook_unsupported');
 const event=await adapter.verifyNativeWebhook(body,headers);if(event.job_id!==attempt.remote_job_id||!event.event_id||event.event_id.length>200)throw new DomainError('native_webhook_binding_invalid');const observationKey=`native-webhook:${event.event_id}`;
 const prior=(await pool.query('SELECT observation_key FROM execution_observations WHERE attempt_id=$1 AND observation_key IN ($2,$3)',[attempt.id,observationKey,`${observationKey}:unavailable`])).rows[0];if(prior)return {worked:false,request_id:request.id,state:request.execution_status};
 const lease=await transaction(pool,t=>leaseObservation(t,scope,clock,request.id,'native-webhook'));
 await observationCallbacks(pool,deps,scope,clock,lease,attempt).onUsage({event_id:`webhook:${event.event_id}`,kind:'final',revision:attempt.poll_count+1,usage:event.result.usage,provider_request_id:event.job_id,raw_usage:event.result.usage});
 await deliverQuotaFeedback(pool,deps.onProviderResult,scope,lease,attempt,event.result);
 return finalizeProviderResult(pool,deps,clock,lease,attempt,context,event.result,observationKey);
}
