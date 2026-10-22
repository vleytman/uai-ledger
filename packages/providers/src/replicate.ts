import {DomainError} from '../../contracts/src/index.js';
import {HttpAdapter,classifyFailure,type AdapterOptions} from './index.js';
import {boundedJson} from './firecrawl.js';
import {object,unknownUsage} from './usage.js';
import {validateSvgInput,validateSvgAssets,RECRAFT_VECTORIZE} from './svg-input.js';
import type {AdapterCapabilities,AdapterContext,ProviderInput,ProviderResult,NormalizedUsage} from './contracts.js';
export class NativeSubmissionFailure extends Error {constructor(readonly result:ProviderResult){super('native_submission_failed');}}
function jobId(value:unknown):string{if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,200}$/.test(value))throw new DomainError('invalid_native_job');return value;}
export class ReplicateAdapter extends HttpAdapter {
 readonly id='replicate';readonly capabilities:AdapterCapabilities={operations:['image.generate','image.vectorize'],streaming:false,native_jobs:true,lookup:true,cancel:true,idempotency:false,usage:true,read_usage:false,read_costs:false,read_balance:false};
 constructor(options:AdapterOptions){super(options);}
 validate(input:ProviderInput){super.validate(input);validateSvgInput(this.id,input);}
 acceptsAssets(){return true;}
 allowedParameters(input:ProviderInput){return input.capability==='image.vectorize'?[]:['size','style_match'];}
 request(input:ProviderInput){const images=input.assets!.map(a=>`data:${a.content_type};base64,${Buffer.from(a.bytes).toString('base64')}`);return {url:`https://api.replicate.com/v1/models/${input.model}/predictions`,headers:{authorization:`Bearer ${this.options.apiKey}`,'content-type':'application/json'},body:{input:input.capability==='image.vectorize'?{image:images[0]}:{...input.parameters,prompt:input.input,style_reference_images:images}}};}
 normalizeUsage(raw:unknown):NormalizedUsage{
  const body=object(raw);if(body.status!=='succeeded')return unknownUsage('replicate_unsuccessful_cost_unconfirmed');
  return {state:'known',items:[{dimension:'output.image',unit:'images',quantity:'1'},...(body.model!==RECRAFT_VECTORIZE?[{dimension:'style.creation',unit:'calls',quantity:'1'}]:[])]};
 }
 extract():never{throw new Error('native_lookup_required');}
 async submitNative(input:ProviderInput,context:AdapterContext){
  this.validate(input);await validateSvgAssets(this.id,input);if(context.signal?.aborted)throw new NativeSubmissionFailure({outcome:'failure',failure:{kind:'canceled',code:'canceled_before_send',sent:false},usage:unknownUsage('not_sent')});
  const req=this.request(input),response=await this.transport(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(req.body),signal:context.signal,redirect:'error'});
  const body=object(await boundedJson(response));
  if(!response.ok){const failure=classifyFailure(response.status,body,response.headers);if(response.status>=500||response.status===408)failure.kind='unknown';throw new NativeSubmissionFailure({outcome:failure.kind==='unknown'?'unknown':'failure',failure,usage:unknownUsage('replicate_submission_rejected')});}
  const id=jobId(body.id);await context.onRemoteJob?.(id);return {job_id:id};
 }
 async lookupNative(id:string,context:AdapterContext):Promise<ProviderResult|{outcome:'pending'}>{
  const response=await this.transport(`https://api.replicate.com/v1/predictions/${jobId(id)}`,{method:'GET',headers:{authorization:`Bearer ${this.options.apiKey}`},signal:context.signal,redirect:'error'});
  if(!response.ok)throw new Error('replicate_lookup_unavailable');
  const body=object(await boundedJson(response));if(body.id!==id||!this.options.models.includes(body.model))throw new Error('replicate_job_identity_mismatch');
  if(['starting','processing'].includes(body.status))return {outcome:'pending'};
  const usage=this.normalizeUsage(body);
  // Persist only normalized usage. No response, style ID, reference, or prompt is retained in the financial journal.
  await context.onUsage({event_id:`${context.attempt_id}:native-final`,kind:'final',revision:1,usage,raw_usage:usage,provider_request_id:id});
  if(body.status!=='succeeded')return {outcome:body.status==='failed'||body.status==='canceled'?'failure':'unknown',failure:{kind:body.status==='canceled'?'canceled':body.status==='failed'?'defect':'unknown',code:`replicate_${['failed','canceled'].includes(body.status)?body.status:'unknown'}`,sent:true},usage,provider_request_id:id};
  const output=body.model===RECRAFT_VECTORIZE?body.output:object(body.output).image;
  let url:URL;try{url=new URL(output)}catch{return {outcome:'failure',failure:{kind:'defect',code:'invalid_svg_url',sent:true},usage,provider_request_id:id}}
  if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname==='replicate.delivery'||url.hostname.endsWith('.replicate.delivery')))return {outcome:'failure',failure:{kind:'defect',code:'unsafe_svg_url',sent:true},usage,provider_request_id:id};
  const file=await this.transport(url.href,{method:'GET',signal:context.signal,redirect:'error'});if(!file.ok||!file.body)throw new Error('replicate_output_unavailable');
  const reader=file.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8000000)throw new Error('svg_too_large');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return {outcome:'success',output:{content_type:'image/svg+xml',bytes:Buffer.concat(chunks)},usage,provider_request_id:id,limit_usage:{requests:1,images:1}};
 }
 async cancelNative(id:string,context:AdapterContext){const response=await this.transport(`https://api.replicate.com/v1/predictions/${jobId(id)}/cancel`,{method:'POST',headers:{authorization:`Bearer ${this.options.apiKey}`},signal:context.signal,redirect:'error'});if(!response.ok)throw new Error('replicate_cancel_unconfirmed');}
}
