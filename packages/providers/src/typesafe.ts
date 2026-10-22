import {DomainError} from '../../contracts/src/index.js';
import {JevValidationError,JEV_MODEL,JEV_OPERATION,JEV_MAX_INPUT_TOKENS,JEV_LIMITS,validateJevInput,validateJevResult} from '../../contracts/jev.js';
import {validateApiInput} from '../../api-services/src/index.js';
import type {AdapterOptions} from './index.js';
import type {ProviderAdapter,ProviderInput,AdapterContext,ProviderResult,AdapterCapabilities,NormalizedUsage,ProviderFailure} from './contracts.js';
/** No SDK, remote cancellation, lookup or implicit resubmission. */
export class TypeSafeAdapter implements ProviderAdapter {
 readonly id='typesafe';
 readonly capabilities:AdapterCapabilities={operations:['api.call'],streaming:false,native_jobs:false,lookup:false,cancel:false,idempotency:false,usage:true,read_usage:false,read_costs:false,read_balance:false};
 constructor(private options:AdapterOptions){}
 validate(input:ProviderInput){
  if(input.capability!=='api.call'||input.model!==JEV_OPERATION||!this.options.models.includes(input.model)||!input.api_operation||input.assets?.length||input.stream||input.tools||input.messages||input.response_schema||input.max_output_tokens||input.instructions)throw new DomainError('unsupported_provider_input');
  validateApiInput(input.api_operation,input.structured??{},input.parameters);validateJevInput(input.structured);
 }
 estimateUsage(input:ProviderInput){this.validate(input);return {confidence:'unavailable' as const,maximum:{state:'known' as const,items:[{dimension:'input_tokens',unit:'tokens',quantity:String(JEV_MAX_INPUT_TOKENS)}]}};}
 estimateLimitUsage(input:ProviderInput){this.validate(input);return {requests:1,tokens:JEV_MAX_INPUT_TOKENS,input_tokens:JEV_MAX_INPUT_TOKENS};}
 normalizeUsage(raw:unknown):NormalizedUsage{
  const u=(raw as any)?.usage;
  if(!u||!Number.isSafeInteger(u.input_tokens)||u.input_tokens<0||u.output_tokens!==undefined&&(!Number.isSafeInteger(u.output_tokens)||u.output_tokens<0))return {state:'unknown',reason:'typesafe_usage_missing_or_invalid'};
  return {state:'known',items:[{dimension:'input_tokens',unit:'tokens',quantity:String(u.input_tokens)}],...(u.output_tokens!==undefined?{breakdown:{output_tokens:String(u.output_tokens)}}:{})};
 }
 classifyFailure(status:number|undefined,_body?:unknown,headers?:Headers):ProviderFailure{
  const kind=status===401||status===403?'auth':status===422?'invalid':status===429||status===529?'transient':'unknown';
  const raw=headers?.get('retry-after'),seconds=raw?Number(raw):NaN,delay=Number.isFinite(seconds)?seconds*1000:raw?Date.parse(raw)-Date.now():NaN;
  return {kind,code:`typesafe_http_${status??'unknown'}`,sent:true,safe_to_retry:status===429||status===529,...(Number.isFinite(delay)&&delay>0?{retry_after_ms:Math.ceil(delay)}:{})};
 }
 readRateLimits(headers:Headers):Record<string,string>{const value=headers.get('retry-after');return value?{'retry-after':value}:{};}
 async execute(input:ProviderInput,context:AdapterContext):Promise<ProviderResult>{
  this.validate(input);
  if(context.signal?.aborted)return {outcome:'failure',failure:{kind:'canceled',code:'canceled_before_dispatch',sent:false},usage:{state:'known',items:[{dimension:'input_tokens',unit:'tokens',quantity:'0'}]}};
  // One HTTP request per attempt; the owner-selected exposure is not a provider token limit.

  const sent_at=new Date().toISOString();let response:Response;
  try{response=await (this.options.fetch??fetch)('https://api.typesafe.ai/v1/systemone',{method:'POST',redirect:'error',signal:context.signal?AbortSignal.any([context.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000),headers:{authorization:`Bearer ${this.options.apiKey}`,'content-type':'application/json'},body:JSON.stringify({model:JEV_MODEL,...input.structured})});}
  catch{return {outcome:'unknown',failure:this.classifyFailure(undefined),usage:{state:'unknown',reason:'typesafe_transport_unknown',model_identity:{requested:JEV_MODEL}}};}
  const requestId=response.headers.get('x-request-id'),provider_request_id=requestId&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(requestId)?requestId:undefined;
  // Audit errors propagate; execution recovery must retain the dispatch marker.
  await context.onRateLimits?.({sent_at,received_at:new Date().toISOString(),status:response.status,headers:this.readRateLimits(response.headers)});
  let raw:any;
  try{if(!response.body)throw new Error();const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>JEV_LIMITS.responseBytes)throw new Error();chunks.push(value);}raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
  catch{const failure=this.classifyFailure(response.ok?undefined:response.status,undefined,response.headers);return {outcome:failure.kind==='unknown'?'unknown':'failure',failure,usage:{state:'unknown',reason:'typesafe_response_unreadable',model_identity:{requested:JEV_MODEL}},provider_request_id};}
  const usage:NormalizedUsage={...this.normalizeUsage(raw),model_identity:{requested:JEV_MODEL,...(typeof raw?.model==='string'&&raw.model.length<=128?{actual:raw.model}:{})}};
  const limit_usage=usage.state==='known'?{requests:1,tokens:Number(usage.items[0].quantity),input_tokens:Number(usage.items[0].quantity)}:{requests:1};
  await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage,provider_request_id,raw_usage:{usage,...(typeof raw?.model==='string'?{model:raw.model}:{}),requested_model:JEV_MODEL}});
  if(!response.ok){const failure=this.classifyFailure(response.status,raw,response.headers);return {outcome:failure.kind==='unknown'?'unknown':'failure',failure,usage,provider_request_id,limit_usage};}
  try{validateJevResult(raw,(input.structured as any).questions);if(raw.model!==JEV_MODEL)throw new DomainError('model_mismatch','Unexpected model',422,{path:'/model',reason:'Unexpected model'});}
  catch(error){return {outcome:'failure',failure:{kind:'defect',code:'typesafe_invalid_response',sent:true,...(error instanceof DomainError||error instanceof JevValidationError?{validation:{path:String(error.details.path??''),reason:String(error.details.reason??'Invalid answer')}}:{})},usage,provider_request_id,limit_usage};}
  return {outcome:'success',output:{content_type:'application/json',text:JSON.stringify(validateJevResult(raw,(input.structured as any).questions))},usage,provider_request_id,limit_usage};
 }
}
