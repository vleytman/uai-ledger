import {apiLimitUsage} from './api-limit-usage.js';
import {z} from 'zod';
import {DomainError} from '../../contracts/src/index.js';
import {validateApiInput,apiMeasurements,apiItems} from '../../api-services/src/index.js';
import {validateWebhookUrl} from '../../notifications/src/webhooks.js';
import type {AdapterOptions} from './index.js';
import type {ProviderAdapter,ProviderInput,AdapterContext,ProviderResult,ProviderFailure,NormalizedUsage,AdapterCapabilities,UsageEstimate} from './contracts.js';
const operationSchemas={
 'firecrawl.scrape':z.strictObject({url:z.url(),formats:z.array(z.enum(['markdown','html','links'])).min(1).max(3).optional(),onlyMainContent:z.boolean().optional()}),
 'firecrawl.search':z.strictObject({query:z.string().min(1).max(1000),limit:z.number().int().min(1).max(10).optional(),scrape:z.boolean().optional()}),
 'firecrawl.patent_search':z.strictObject({query:z.string().min(1).max(2000),page_size:z.number().int().min(1).max(100).optional(),start:z.number().int().min(0).max(999).optional(),databases:z.array(z.enum(['US-PGPUB','USPAT','USOCR'])).min(1).max(3).optional()}),
 'firecrawl.patent_document':z.strictObject({number:z.string().min(1).max(80),include_full_text:z.boolean().optional()}),
};
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as any:{};
const unknown=(reason:string):NormalizedUsage=>({state:'unknown',reason});
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):undefined;
export async function boundedJson(response:Response){
 if(Number(response.headers.get('content-length'))>8000000)throw new Error('provider_response_too_large');
 if(!response.body)throw new Error('provider_response_missing');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>8000000)throw new Error('provider_response_too_large');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Fixed hosted API destinations. Arbitrary endpoints and caller-supplied headers are not supported. */
export class FirecrawlAdapter implements ProviderAdapter {
 readonly id='firecrawl';readonly capabilities:AdapterCapabilities={operations:['api.call'],streaming:false,native_jobs:false,lookup:false,cancel:false,idempotency:false,usage:true,read_usage:true,read_costs:false,read_balance:true};
 constructor(private options:AdapterOptions){}
 validate(input:ProviderInput){
  if(input.capability!=='api.call'||!this.options.models.includes(input.model)||!Object.hasOwn(operationSchemas,input.model)||input.assets?.length||!input.api_operation||input.api_operation.adapter_ref!=='firecrawl@1')throw new DomainError('unsupported_provider_input','Unsupported Firecrawl operation',422);
  validateApiInput(input.api_operation,input.structured??{},input.parameters);
  const body=operationSchemas[input.model as keyof typeof operationSchemas].parse(input.structured);
  if('url'in body)validateWebhookUrl(body.url);
 }
 request(input:ProviderInput){
  this.validate(input);const data=operationSchemas[input.model as keyof typeof operationSchemas].parse(input.structured) as Record<string,unknown>;
  if(input.model==='firecrawl.search'){const {scrape,...fields}=data;return {url:'https://api.firecrawl.dev/v2/search',body:{...fields,limit:fields.limit??5,sources:['web'],timeout:20000,...(scrape?{scrapeOptions:{formats:['markdown'],parsers:[],proxy:'basic'}}:{})}};}
  if(input.model==='firecrawl.scrape')return {url:'https://api.firecrawl.dev/v2/scrape',body:{...data,formats:data.formats??['markdown'],parsers:[],proxy:'basic',timeout:20000}};
  return {url:'https://api.firecrawl.dev/v2/scrape',body:{alexandria:{provider:'uspto-gov',capability:`intellectual-property/${input.model.slice('firecrawl.'.length)}`,options:data},timeout:20000}};
 }
 estimateUsage(input:ProviderInput):UsageEstimate{this.validate(input);const measurements=apiMeasurements(input.api_operation!,input.structured!,{count:0,bytes:'0'})!;return {confidence:'conservative',maximum:{state:'known',items:apiItems(input.api_operation!,measurements)}};}
 estimateLimitUsage(input:ProviderInput){this.validate(input);return apiLimitUsage(apiMeasurements(input.api_operation!,input.structured!,{count:0,bytes:'0'})!);}
 normalizeUsage(raw:unknown,input:ProviderInput):NormalizedUsage{
  const body=obj(raw),data=obj(body.data);const credits=count(input.model==='firecrawl.search'?body.creditsUsed:input.model==='firecrawl.scrape'?obj(data.metadata).creditsUsed:data.creditsCost);
  if(credits===undefined)return unknown('firecrawl_credits_missing');
  return {state:'known',items:[{dimension:'credits',unit:'credits',quantity:credits}]};
 }
 classifyFailure(status:number|undefined,raw?:unknown,headers?:Headers):ProviderFailure{
  const body=obj(raw),code=typeof body.code==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(body.code)?body.code:`firecrawl_${status??'transport_unknown'}`;
  const retry=Number(headers?.get('retry-after'));
  return {kind:code==='request_unresolved'||code==='request_in_flight'||status===undefined||status===408||status>=500?'unknown':status===401||status===403?'auth':status===402?'quota':status===429?'transient':'invalid',code,sent:true,safe_to_retry:status===429,...(retry>0&&Number.isFinite(retry)?{retry_after_ms:Math.min(retry*1000,86400000)}:{})};
 }
 readRateLimits(headers:Headers){return Object.fromEntries([...headers].filter(([key])=>key.startsWith('x-ratelimit-')||key==='retry-after'));}
 async execute(input:ProviderInput,context:AdapterContext):Promise<ProviderResult>{
  const request=this.request(input),sentAt=new Date().toISOString();let response:Response;
  try{response=await (this.options.fetch??fetch)(request.url,{method:'POST',redirect:'error',signal:context.signal?AbortSignal.any([context.signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000),headers:{authorization:`Bearer ${this.options.apiKey}`,'content-type':'application/json',...(input.model.startsWith('firecrawl.patent_')?{'x-request-id':context.attempt_id}:{})},body:JSON.stringify(request.body)});}catch{return {outcome:'unknown',failure:this.classifyFailure(undefined),usage:unknown('firecrawl_transport_unknown')};}
  await context.onRateLimits?.({sent_at:sentAt,received_at:new Date().toISOString(),status:response.status,headers:this.readRateLimits(response.headers)});
  let raw:any;try{raw=await boundedJson(response);}catch{return {outcome:'unknown',failure:{kind:'unknown',code:'firecrawl_response_unreadable',sent:true},usage:unknown('firecrawl_response_unreadable')};}
  const usage=this.normalizeUsage(raw,input),body=obj(raw),data=obj(body.data),requestId=response.headers.get('x-request-id')??(typeof body.scrape_id==='string'?body.scrape_id:undefined);
  await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage,raw_usage:usage,provider_request_id:requestId});
  const nestedError=Array.isArray(data.alexandria)?data.alexandria.find((r:any)=>r?.error)?.error:null;
  if(!response.ok||body.success!==true||nestedError){const failure=this.classifyFailure(response.status===200?400:response.status,nestedError??body,response.headers);return {outcome:failure.kind==='unknown'?'unknown':'failure',failure,usage,provider_request_id:requestId};}
  return {outcome:'success',output:{content_type:'application/json',text:JSON.stringify(data)},usage,provider_request_id:requestId,limit_usage:usage.state==='known'?apiLimitUsage(Object.fromEntries(usage.items.map(i=>[i.dimension,i.quantity]))):{requests:1}};
 }
 async readCreditUsage(){
  const response=await (this.options.fetch??fetch)('https://api.firecrawl.dev/v2/team/credit-usage',{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${this.options.apiKey}`}});
  const body=obj(await boundedJson(response)),data=obj(body.data);
  if(!response.ok||body.success!==true||count(data.remainingCredits)===undefined||count(data.planCredits)===undefined||!Number.isFinite(Date.parse(data.billingPeriodStart))||!Number.isFinite(Date.parse(data.billingPeriodEnd))||Date.parse(data.billingPeriodEnd)<=Date.parse(data.billingPeriodStart))throw new DomainError('invalid_firecrawl_credit_snapshot');
  return {remaining:count(data.remainingCredits)!,included:count(data.planCredits)!,period_start:new Date(data.billingPeriodStart).toISOString(),period_end:new Date(data.billingPeriodEnd).toISOString(),covered_through:null,precision:'estimated' as const,scope:'provider_account' as const};
 }
}
