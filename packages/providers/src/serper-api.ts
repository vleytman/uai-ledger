import {apiLimitUsage} from './api-limit-usage.js';
import {z} from 'zod';
import {DomainError} from '../../contracts/src/index.js';
import {apiItems,apiMeasurements,validateApiInput} from '../../api-services/src/index.js';
import {boundedJson} from './firecrawl.js';
import {SerperAdapter,type AdapterOptions} from './index.js';
import type {ProviderAdapter,ProviderInput,AdapterContext,ProviderResult,AdapterCapabilities,UsageEstimate,NormalizedUsage} from './contracts.js';
const schema=z.strictObject({query:z.string().min(1).max(1000),num:z.number().int().min(1).max(100).optional(),page:z.number().int().min(1).max(100).optional(),gl:z.string().regex(/^[a-z]{2}$/).optional(),hl:z.string().regex(/^[a-z]{2}$/).optional()});
export class SerperApiAdapter implements ProviderAdapter {
 readonly id='serper';readonly capabilities:AdapterCapabilities={operations:['api.call'],streaming:false,native_jobs:false,lookup:false,cancel:false,idempotency:false,usage:true,read_usage:false,read_costs:false,read_balance:false};
 private legacy:SerperAdapter;
 constructor(private options:AdapterOptions){this.legacy=new SerperAdapter(options);}
 validate(input:ProviderInput){if(input.capability!=='api.call'||input.model!=='serper.search'||!this.options.models.includes(input.model)||input.assets?.length||!input.api_operation)throw new DomainError('unsupported_provider_input');validateApiInput(input.api_operation,input.structured??{},input.parameters);schema.parse(input.structured);}
 estimateUsage(input:ProviderInput):UsageEstimate{this.validate(input);return {confidence:'conservative',maximum:{state:'known',items:apiItems(input.api_operation!,apiMeasurements(input.api_operation!,input.structured!,{count:0,bytes:'0'})!)}};}
 estimateLimitUsage(input:ProviderInput){this.validate(input);return apiLimitUsage(apiMeasurements(input.api_operation!,input.structured!,{count:0,bytes:'0'})!);}
 normalizeUsage(raw:unknown):NormalizedUsage{const usage=this.legacy.normalizeUsage(raw);return usage.state==='unknown'?usage:{...usage,items:usage.items.map(i=>({...i,dimension:'credits'}))};}
 classifyFailure=thisFailure;
 readRateLimits(headers:Headers){return this.legacy.readRateLimits(headers);}
 async execute(input:ProviderInput,context:AdapterContext):Promise<ProviderResult>{
  this.validate(input);const {query,...parameters}=schema.parse(input.structured),sentAt=new Date().toISOString();let response:Response;
  try{response=await (this.options.fetch??fetch)('https://google.serper.dev/search',{method:'POST',redirect:'error',signal:context.signal?AbortSignal.any([context.signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000),headers:{'X-API-KEY':this.options.apiKey,'content-type':'application/json'},body:JSON.stringify({...parameters,q:query})});}catch{return {outcome:'unknown',failure:this.classifyFailure(undefined),usage:{state:'unknown',reason:'serper_transport_unknown'}};}
  await context.onRateLimits?.({sent_at:sentAt,received_at:new Date().toISOString(),status:response.status,headers:this.readRateLimits(response.headers)});
  let body:any;try{body=await boundedJson(response);}catch{return {outcome:'unknown',failure:this.classifyFailure(undefined),usage:{state:'unknown',reason:'serper_response_unreadable'}};}
  const usage=this.normalizeUsage(body);await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage,raw_usage:usage});
  if(!response.ok){const failure=this.classifyFailure(response.status,body,response.headers);return {outcome:failure.kind==='unknown'?'unknown':'failure',failure,usage};}
  if(!Array.isArray(body.organic))return {outcome:'failure',failure:{kind:'defect',code:'serper_results_missing',sent:true},usage};
  return {outcome:'success',output:{content_type:'application/json',text:JSON.stringify({organic:body.organic,searchParameters:body.searchParameters})},usage,limit_usage:usage.state==='known'?apiLimitUsage(Object.fromEntries(usage.items.map(i=>[i.dimension,i.quantity]))):{requests:1}};
 }
}
import {classifyFailure as thisFailure} from './index.js';
