import {structuredTransport} from './structured.js';
import {validateEmbeddingInput,validateEmbeddingOutput,embeddingUsage} from './embeddings.js';
import {validateProviderText,openAIContent,anthropicContent,validateToolCall} from './text-input.js';
import {openAILimitUsage,anthropicLimitUsage} from './limit-usage.js';
import { DomainError } from '../../contracts/src/index.js';
import type { AdapterCapabilities, AdapterContext, Capability, NormalizedUsage, ProviderAdapter, ProviderFailure, ProviderInput, ProviderResult, UsageEstimate, LimitUsage, LimitEstimateOptions } from './contracts.js';
import { counter, normalizeAnthropic, normalizeOpenAI, object, unknownUsage } from './usage.js';
import {providerParameters} from './parameters.js';
export * from './contracts.js';
export * from './usage.js';
export type Fetcher=(url:string,init:RequestInit)=>Promise<Response>;
export interface AdapterOptions { apiKey:string; googleProject?:string; googleLocation?:string; googleToken?:{get():Promise<string>}; models:readonly string[]; fetch?:Fetcher; cartesiaVersion?:string; maxInputTokens?:number; }
const caps=(operations:Capability[],streaming=false):AdapterCapabilities=>({operations,streaming,native_jobs:false,lookup:false,cancel:false,idempotency:false,usage:true,read_usage:false,read_costs:false,read_balance:false});
export function classifyFailure(status:number|undefined,body?:unknown,headers?:Headers):ProviderFailure {
  const e=object(object(body).error); const code=String(e.code??e.type??`http_${status??'unknown'}`);
  const quota=/insufficient_quota|billing|credit|quota_exceeded/.test(code);
  const kind=status===undefined?'unknown':quota||status===402?'quota':status===401||status===403?'auth':status===429||status>=500&&status<600?'transient':status>=400&&status<500?'invalid':'unknown';
  const retry=Number(headers?.get('retry-after'));
  // Credential, billing and rate-limit refusals happen before generation; these providers do not bill them.
  const refused=kind==='auth'||kind==='quota'||status===429;
  return {kind,safe_to_retry:status===429&&!quota,code: /^[a-zA-Z0-9_.-]{1,100}$/.test(code)?code:`http_${status??'unknown'}`,sent:true,...(refused?{billable:false}:{}),...(retry>0 && Number.isFinite(retry)?{retry_after_ms:retry*1000}:{})};
}
/** Parser accepts arbitrary UTF-8/network chunk boundaries and requires callers to verify terminal events. */
export async function* sseEvents(response:Response):AsyncGenerator<{event:string;data:unknown}> {
  if(!response.body) throw new Error('missing_stream');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  try { while(true) {const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});buffer=buffer.replace(/\r\n/g,'\n');if(done&&buffer.trim())buffer+='\n\n';let split:number;
    while((split=buffer.indexOf('\n\n'))>=0) {const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);const lines=frame.split('\n');const data=lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data&&data!=='[DONE]') yield {event:lines.find(l=>l.startsWith('event:'))?.slice(6).trim()??'message',data:JSON.parse(data)};}
    if(done) break;
  }} finally {reader.releaseLock();}
}
async function boundedProviderJson(response:Response,limit=1048576){
 if(!response.body)throw new Error('missing_body');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>limit)throw new Error('embedding_response_too_large');chunks.push(chunk.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export abstract class HttpAdapter implements ProviderAdapter {
  abstract readonly id:string;abstract readonly capabilities:AdapterCapabilities;
  protected transport:Fetcher;
  constructor(protected options:AdapterOptions){this.transport=options.fetch??fetch;}
  abstract normalizeUsage(raw:unknown,input:ProviderInput):NormalizedUsage;
  actualLimitUsage(_raw:unknown,_input:ProviderInput):LimitUsage|undefined{return undefined;}
  protected async authorization(_input:ProviderInput):Promise<Record<string,string>>{return {};}
  protected errorUsage(_status:number,error:unknown,input:ProviderInput):NormalizedUsage{const raw=object(error).usage;return raw===undefined?unknownUsage('error_usage_not_reported'):this.normalizeUsage(raw,input);}
  abstract request(input:ProviderInput,stream:boolean):{url:string;headers:Record<string,string>;body:unknown};
  abstract extract(body:Record<string,any>,input:ProviderInput):{content_type:string;text?:string;bytes?:Uint8Array};
  refusal(_body:Record<string,any>):string|undefined{return undefined;}
  allowedParameters(_input:ProviderInput):string[]{return [];}
  acceptsAssets(_input:ProviderInput){return false;}
  validate(input:ProviderInput) {
    if(!this.options.models.includes(input.model)||!this.capabilities.operations.includes(input.capability)||typeof input.input!=='string') throw new DomainError('unsupported_provider_input','Unsupported provider input',422);
    if(!input.input && !input.messages?.length&&!input.texts?.length&&!(input.capability==='image.vectorize'&&input.assets?.length)) throw new DomainError('empty_input','Input required',422);
    if(input.max_output_tokens!==undefined&&(!Number.isSafeInteger(input.max_output_tokens)||input.max_output_tokens<1)) throw new DomainError('invalid_output_limit','Output limit must be positive integer',422);
    if(input.capability==='text.generate'&&!input.max_output_tokens&&!(this.id==='openai'&&input.output_limit_policy==='provider_default')) throw new DomainError('output_limit_required','Output limit required',422);
    if(input.assets?.length&&!this.acceptsAssets(input)) throw new DomainError('unsupported_assets','This adapter does not accept input assets',422);
    if(Object.keys(input.parameters??{}).some(k=>!this.allowedParameters(input).includes(k))) throw new DomainError('unsupported_parameter','Unsupported provider parameter',422);
    if(input.capability==='embeddings.generate')validateEmbeddingInput(input);
    if(input.capability==='text.generate')validateProviderText(this.id,input);
    if(input.capability!=='text.generate'&&(input.messages||input.instructions||input.response_schema||input.tools||input.tool_choice)) throw new DomainError('unsupported_text_constraint','Text constraints require text generation',422);
  }
  estimateUsage(input:ProviderInput):UsageEstimate {
    this.validate(input);
    if(input.capability==='search') return {confidence:'conservative',maximum:{state:'known',items:[{dimension:'tool.search',quantity:'1',unit:'requests'}]}};
    // Tokenizer/model context bounds must be configured by the trusted catalog.
    if(input.capability==='text.generate' && !/^gpt-(5\.6|6)(?:-|$)/.test(input.model) && this.options.maxInputTokens && input.max_output_tokens) return {confidence:'conservative',maximum:{state:'known',items:[{dimension:'input.uncached',quantity:String(this.options.maxInputTokens),unit:'tokens'},{dimension:'output.text',quantity:String(input.max_output_tokens),unit:'tokens'}]}};
    return {confidence:'unavailable',maximum:unknownUsage('model_usage_bound_not_configured')};
  }
  estimateLimitUsage(input:ProviderInput,options:LimitEstimateOptions={}):LimitUsage {
    const estimate:LimitUsage={requests:1};
    // This adapter sends exactly one image per HTTP request, independently of recipe count.
    if(input.capability.startsWith('image.'))estimate.images=1;
    if(input.capability==='embeddings.generate'){const tokens=validateEmbeddingInput(input);return {requests:1,input_tokens:tokens,tokens}}
    if(input.capability!=='text.generate')return estimate;
    const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
    if(positive(this.options.maxInputTokens))estimate.input_tokens=this.options.maxInputTokens;
    const output=input.max_output_tokens??options.expected_output_tokens;
    if(positive(output))estimate.output_tokens=output;
    // Missing output prediction must never silently become zero for provider-default generation.
    if(estimate.input_tokens!==undefined&&estimate.output_tokens!==undefined){
      const total=estimate.input_tokens+estimate.output_tokens;if(Number.isSafeInteger(total))estimate.tokens=total;
    }
    return estimate;
  }
  classifyFailure=classifyFailure;
  readRateLimits(headers:Headers){const result:Record<string,string>={};for(const [k,v] of headers) if(/^(x-ratelimit-|anthropic-ratelimit-|retry-after$)/.test(k)) result[k]=v;return result;}
  protected async stream(_response:Response,_input:ProviderInput,_context:AdapterContext):Promise<Record<string,any>>{throw new Error('unsupported_stream');}
  async execute(input:ProviderInput,context:AdapterContext):Promise<ProviderResult> {
    this.validate(input);
    if(context.signal?.aborted) return {outcome:'failure',failure:{kind:'canceled',code:'canceled_before_send',sent:false},usage:unknownUsage('not_sent')};
    const wantsStream=(input.stream??!!context.onDelta)&&this.capabilities.streaming&&input.capability==='text.generate'; const structured=structuredTransport(this.id,input,context.attempt_id);const req=this.request(structured.input,wantsStream);let response:Response;let auth:Record<string,string>;try{auth=await this.authorization(input);}catch{return {outcome:'failure',failure:{kind:'auth',code:'credential_refresh_failed',sent:false},usage:unknownUsage('not_sent')};}const sentAt=new Date().toISOString();
    try {response=await this.transport(req.url,{method:'POST',headers:{...req.headers,...auth},body:JSON.stringify(req.body),signal:context.signal,redirect:'error'});} catch {return {outcome:'unknown',failure:classifyFailure(undefined),usage:unknownUsage('transport_outcome_unknown')};}
    await context.onRateLimits?.({sent_at:sentAt,received_at:new Date().toISOString(),status:response.status,headers:this.readRateLimits(response.headers)});
    const provider_request_id=response.headers.get('x-request-id')??response.headers.get('request-id')??undefined;
    if(this.id==='quiver'&&response.headers.get('x-quiver-environment')==='test')return {outcome:'failure',failure:{kind:'defect',code:'quiver_sandbox_response',sent:true,safe_to_retry:false},usage:unknownUsage('quiver_sandbox_not_production_usage'),provider_request_id};
    if(!response.ok) {let error:unknown;try {error=await response.json();}catch {error={};}const raw=object(error).usage;const usage=this.errorUsage(response.status,error,input);if(raw!==undefined||usage.state==='known')await context.onUsage({event_id:`${context.attempt_id}:error`,kind:'final',revision:1,usage,raw_usage:{status:response.status,usage:raw??null},provider_request_id});const failure=this.classifyFailure(response.status,error,response.headers);return {outcome:failure.kind==='unknown'?'unknown':'failure',failure,usage,provider_request_id,limit_usage:this.actualLimitUsage(raw,input)};}
    let body:Record<string,any>;
    try {body=wantsStream?await this.stream(response,structured.input,structured.buffered?{...context,onDelta:undefined}:context):this.id==='cartesia'?{bytes:new Uint8Array(await response.arrayBuffer())}:object(input.capability==='embeddings.generate'?await boundedProviderJson(response):this.id==='quiver'?await boundedProviderJson(response,8000000):await response.json());}
    catch {return {outcome:'unknown',failure:{kind:'unknown',code:'response_incomplete',sent:true},usage:unknownUsage('response_incomplete'),provider_request_id};}
    if(this.id==='google_cloud'){body.usage=body.usageMetadata??body.usage;body.id=body.responseId??body.id;}
    const usage=this.normalizeUsage(body.usage,input),limit_usage=this.actualLimitUsage(body.usage,input);
    if(usage.state==='known'&&['cerebras','groq','google_cloud'].includes(this.id)){
      const finish=body.choices?.[0]?.finish_reason??body.candidates?.[0]?.finishReason;
      usage.breakdown={...usage.breakdown,...(typeof finish==='string'&&finish.length<=64?{finish_reason:finish}:{}),...(this.id==='google_cloud'?{requested_service_mode:'standard'}:{})};
      if(this.id==='google_cloud'&&typeof body.serviceTier==='string'&&body.serviceTier.length<=64)usage.breakdown.actual_service_mode=body.serviceTier;
    }
    const requestId=typeof body.id==='string'?body.id:provider_request_id;
    body.id??=context.attempt_id;
    // Audit failure must propagate to worker recovery; it must not become a content failure or a retry.
    await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage,raw_usage:['cerebras','groq','google_cloud'].includes(this.id)?{...body.usage,_uai:{finish_reason:body.choices?.[0]?.finish_reason??body.candidates?.[0]?.finishReason??null,requested_service_mode:input.service_mode??(this.id==='google_cloud'?'standard':null),actual_service_mode:body.serviceTier??null,stream:wantsStream}}:body.usage??null,provider_request_id:requestId});
    const refusal=this.refusal(body);if(refusal!==undefined)return {outcome:'refused',refusal,failure:{kind:'refused',code:'model_refused',sent:true},usage,provider_request_id:requestId,limit_usage};
    try {const output=structured.restore(this.extract(body,structured.input));if(structured.buffered&&output.text)await context.onDelta?.(output.text);return {outcome:'success',output,usage,provider_request_id:requestId,limit_usage};}
    catch(error) {return {outcome:'failure',failure:{kind:'defect',code:'invalid_provider_output',sent:true,...(error instanceof DomainError&&error.details.path?{validation:{path:String(error.details.path),reason:String(error.details.reason)}}:{})},usage,provider_request_id:requestId,limit_usage};}
  }
}
export class OpenAIAdapter extends HttpAdapter {
  readonly id='openai';readonly capabilities={...caps(['embeddings.generate','text.generate','image.generate'],true),text_usage:{estimated_actual:true,output_limit:'provider_default' as const}};
  acceptsAssets(input:ProviderInput){return ['image.generate','text.generate'].includes(input.capability)&&!!input.assets?.length&&input.assets.length<=16&&input.assets.every(a=>['image/png','image/jpeg','image/webp'].includes(a.content_type)&&a.bytes&&a.bytes.length<=20000000);}
  allowedParameters(input:ProviderInput){return [...providerParameters(this.id,input.capability)??[]];}
  validate(input:ProviderInput){
    super.validate(input);
    const p=input.parameters??{};
    if(p.reasoning_effort!==undefined&&(input.model!=='gpt-6-luna'||p.reasoning!==undefined||!['none','low','medium','high','xhigh','max'].includes(String(p.reasoning_effort))))throw new DomainError('invalid_reasoning_effort');
    if(input.model==='gpt-6-luna'&&input.capability==='text.generate'){
      const effort=p.reasoning===undefined?p.reasoning_effort:object(p.reasoning).effort;
      if(effort!==undefined&&!['none','low','medium','high','xhigh','max'].includes(String(effort)))throw new DomainError('invalid_reasoning_effort');
      if(p.service_tier!==undefined&&p.service_tier!=='default')throw new DomainError('unsupported_service_tier');
      if(p.temperature!==undefined)throw new DomainError('unsupported_parameter');
      if(input.max_output_tokens!==undefined&&input.max_output_tokens>128000)throw new DomainError('invalid_output_limit');
    }
  }
  request(input:ProviderInput,stream:boolean){const {reasoning_effort,...parameters}=input.parameters??{};const p={...parameters,...(reasoning_effort!==undefined?{reasoning:{effort:reasoning_effort}}:{})};return {url:`https://api.openai.com/v1/${input.capability==='embeddings.generate'?'embeddings':input.capability==='text.generate'?'responses':input.assets?.length?'images/edits':'images/generations'}`,headers:{authorization:`Bearer ${this.options.apiKey}`,'content-type':'application/json'},body:input.capability==='embeddings.generate'?{...p,model:input.model,input:input.texts,encoding_format:'float'}:input.capability==='text.generate'?{...p,model:input.model,input:input.messages?.map(message=>({role:message.role,content:openAIContent(input,message.content,message.role)}))??input.input,...(input.tools?{tools:input.tools.map(tool=>({type:'function',...tool,strict:true})),tool_choice:input.tool_choice?.type==='named'?{type:'function',name:input.tool_choice.name}:'required',parallel_tool_calls:false}:{}),instructions:input.instructions,max_output_tokens:input.max_output_tokens,stream,store:false,...(input.response_schema?{text:{format:{type:'json_schema',name:input.response_schema.name,schema:input.response_schema.schema,strict:true}}}:{})}:{...p,model:input.model,prompt:input.input,n:1,...(input.assets?.length?{images:input.assets.map(a=>({image_url:`data:${a.content_type};base64,${Buffer.from(a.bytes!).toString('base64')}`}))}:{})}};}
  refusal(body:Record<string,any>){const blocks=(body.output??[]).filter((v:any)=>v.type==='message').flatMap((v:any)=>v.content??[]).filter((v:any)=>v.type==='refusal');return blocks.length?blocks.map((v:any)=>typeof v.refusal==='string'?v.refusal:'Model refused').join('\n'):undefined;}
  normalizeUsage(raw:unknown,input:ProviderInput){return input.capability==='embeddings.generate'?embeddingUsage(raw):normalizeOpenAI(raw,input)}
  override actualLimitUsage(raw:unknown,input:ProviderInput){if(input.capability==='embeddings.generate'){const usage=embeddingUsage(raw);return usage.state==='known'?{requests:1,input_tokens:Number(usage.items[0].quantity),tokens:Number(usage.items[0].quantity)}:undefined}return openAILimitUsage(raw);}
  extract(body:Record<string,any>,input:ProviderInput){
    if(input.capability==='embeddings.generate'){const embeddings=validateEmbeddingOutput({...body,revision:null},input);return {content_type:'application/json',text:JSON.stringify(embeddings),embeddings};}
    if(input.capability==='image.generate') {const data=body.data;if(!Array.isArray(data)||data.length!==1||typeof data[0].b64_json!=='string'||!data[0].b64_json.length) throw new Error('missing_image');return {content_type:`image/${input.parameters?.output_format??'png'}`,bytes:new Uint8Array(Buffer.from(data[0].b64_json,'base64'))};}
    if(body.status!=='completed') throw new Error('incomplete_text');
    const calls=(body.output??[]).filter((o:any)=>o.type==='function_call');
    if(input.tools){const tool_call=validateToolCall(input,calls.map((call:any)=>({id:call.call_id,provider_id:call.id,name:call.name,arguments:JSON.parse(call.arguments)})));return {content_type:'application/json',text:JSON.stringify(tool_call.arguments),tool_call};}
    if(calls.length)throw new Error('unexpected_tool_call');
    const text=(body.output??[]).filter((o:any)=>o.type==='message').flatMap((o:any)=>o.content??[]).filter((c:any)=>c.type==='output_text').map((c:any)=>c.text).join('');if(!text) throw new Error('missing_text');return {content_type:'text/plain',text};
  }
  protected async stream(response:Response,_input:ProviderInput,context:AdapterContext){for await(const event of sseEvents(response)){const d=object(event.data);if((d.type==='response.output_text.delta'||d.type==='response.function_call_arguments.delta')&&typeof d.delta==='string') await context.onDelta?.(d.delta);if(d.type==='response.completed'||d.type==='response.incomplete'||d.type==='response.failed') return object(d.response);}throw new Error('missing_terminal_event');}
}
export class AnthropicAdapter extends HttpAdapter {
  readonly id='anthropic';readonly capabilities={...caps(['text.generate'],true),text_usage:{estimated_actual:true,output_limit:'required' as const}};
  allowedParameters(){return [...providerParameters(this.id,'text.generate')!];}
  acceptsAssets(input:ProviderInput){return input.capability==='text.generate'&&!!input.assets?.length&&input.assets.length<=100&&input.assets.every(a=>['image/png','image/jpeg','image/webp'].includes(a.content_type)&&a.bytes.length>0&&a.bytes.length<=5000000);}
  request(input:ProviderInput,stream:boolean){
   const messages=input.messages?.filter(m=>m.role!=='system').map(m=>({role:m.role,content:anthropicContent(input,m.content)}))??[{role:'user',content:[{type:'text',text:input.input}]}];
   const system=[...(input.instructions?[{type:'text',text:input.instructions}]:[]),...(input.messages?.filter(m=>m.role==='system').flatMap(m=>anthropicContent(input,m.content))??[])];
   return {url:'https://api.anthropic.com/v1/messages',headers:{'x-api-key':this.options.apiKey,'anthropic-version':'2023-06-01','content-type':'application/json'},body:{...input.parameters,model:input.model,messages,...(system.length?{system}:{}),max_tokens:input.max_output_tokens,stream,...(input.response_schema?{output_config:{format:{type:'json_schema',schema:input.response_schema.schema}}}:{}),...(input.tools?{tools:input.tools.map(tool=>({name:tool.name,description:tool.description,input_schema:tool.parameters})),tool_choice:{...(input.tool_choice?.type==='named'?{type:'tool',name:input.tool_choice.name}:{type:'any'}),disable_parallel_tool_use:true}}:{})}};
  }
  refusal(body:Record<string,any>){return body.stop_reason==='refusal'?(body.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n')||'Model refused':undefined;}
  normalizeUsage(raw:unknown){return normalizeAnthropic(raw);}
  override actualLimitUsage(raw:unknown){return anthropicLimitUsage(raw);}
  extract(body:Record<string,any>,input:ProviderInput){
   const calls=(body.content??[]).filter((c:any)=>c.type==='tool_use');
   if(input.tools){if(body.stop_reason!=='tool_use')throw new Error('missing_tool_call');const tool_call=validateToolCall(input,calls.map((call:any)=>({id:call.id,name:call.name,arguments:call.input})));return {content_type:'application/json',text:JSON.stringify(tool_call.arguments),tool_call};}
   if(calls.length||!['end_turn','stop_sequence'].includes(body.stop_reason))throw new Error('incomplete_text');
   const text=(body.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('');if(!text)throw new Error('missing_text');return {content_type:'text/plain',text};
  }
  protected async stream(response:Response,_input:ProviderInput,context:AdapterContext){
   let message:Record<string,any>={};const blocks:Record<string,any>[]=[];const partial=new Map<number,string>();
   for await(const event of sseEvents(response)){
    const d=object(event.data);
    if(d.type==='message_start')message=object(d.message);
    if(d.type==='content_block_start'){blocks[d.index]={...d.content_block};if(d.content_block?.type==='tool_use')partial.set(d.index,'');}
    if(d.type==='content_block_delta'){
     const block=blocks[d.index];if(!block)throw new Error('missing_content_block');
     if(d.delta?.type==='text_delta'){block.text=(block.text??'')+d.delta.text;await context.onDelta?.(d.delta.text);}
     if(d.delta?.type==='input_json_delta'){partial.set(d.index,(partial.get(d.index)??'')+d.delta.partial_json);await context.onDelta?.(d.delta.partial_json);}
    }
    if(d.type==='content_block_stop'&&partial.has(d.index)){const json=partial.get(d.index)!;if(json)blocks[d.index].input=JSON.parse(json);}
    if(d.type==='message_delta'){message.usage={...message.usage,...d.usage};message.stop_reason=d.delta?.stop_reason;}
    if(d.type==='message_stop')return {...message,content:blocks};
    if(d.type==='error')throw new Error('stream_error');
   }
   throw new Error('missing_terminal_event');
  }
}
export class CartesiaAdapter extends HttpAdapter {
  readonly id='cartesia';readonly capabilities=caps(['speech.synthesize']);
  allowedParameters(){return [...providerParameters(this.id,'speech.synthesize')!];}
  validate(input:ProviderInput){super.validate(input);if(!this.options.cartesiaVersion||typeof input.parameters?.voice!=='string'||!input.parameters?.output_format) throw new DomainError('cartesia_configuration_required','Version, voice and output format required',422);}
  request(input:ProviderInput){return {url:'https://api.cartesia.ai/tts/bytes',headers:{authorization:`Bearer ${this.options.apiKey}`,'Cartesia-Version':this.options.cartesiaVersion!,'content-type':'application/json'},body:{...input.parameters,model_id:input.model,transcript:input.input}};}
  // Bytes endpoint does not return individual billed credits. Character guesses are not confirmed usage.
  normalizeUsage(){return unknownUsage('cartesia_bytes_usage_unreported');}
  extract(body:Record<string,any>,input:ProviderInput){if(!(body.bytes instanceof Uint8Array)||!body.bytes.length)throw new Error('missing_audio');const container=object(input.parameters?.output_format).container;return {content_type:container==='wav'?'audio/wav':container==='mp3'?'audio/mpeg':'application/octet-stream',bytes:body.bytes};}
}
export class SerperAdapter extends HttpAdapter {
  readonly id='serper';readonly capabilities=caps(['search']);
  allowedParameters(){return [...providerParameters(this.id,'search')!];}
  request(input:ProviderInput){return {url:'https://google.serper.dev/search',headers:{'X-API-KEY':this.options.apiKey,'content-type':'application/json'},body:{...input.parameters,q:input.input}};}
  normalizeUsage(raw:unknown){const credits=counter(object(raw).credits);return credits===null?unknownUsage('serper_credits_unreported'):{state:'known' as const,items:[{dimension:'tool.search',quantity:credits.toString(),unit:'credits'}]};}
  extract(body:Record<string,any>){if(!Array.isArray(body.organic))throw new Error('missing_search_results');return {content_type:'application/json',text:JSON.stringify({organic:body.organic,searchParameters:body.searchParameters})};}
  async execute(input:ProviderInput,context:AdapterContext){
    // Serper reports credits at the response root. Adapt its envelope before the common audit path.
    const original=this.transport;const proxy:Fetcher=async(url,init)=>{const response=await original(url,init);if(!response.ok)return response;const body=object(await response.json());return new Response(JSON.stringify({...body,usage:{credits:body.credits}}),{status:response.status,headers:response.headers});};
    // Per-call object avoids mutating transport when concurrent requests share the adapter.
    const call=new SerperAdapter({...this.options,fetch:proxy});return HttpAdapter.prototype.execute.call(call,input,context);
  }
  estimateUsage(input:ProviderInput):UsageEstimate{this.validate(input);return {confidence:'unavailable',maximum:unknownUsage('connection_search_credit_bound_required')};}
}
export interface FakeScenario { outcome:'success'|'transient'|'defect'|'unknown'|'auth'|'quota'|'invalid'; text?:string; usage?:NormalizedUsage; bytes?:Uint8Array; content_type?:string;tool_call?:import('./contracts.js').ToolCall }
export class FakeAdapter implements ProviderAdapter {
  readonly id='fake';readonly capabilities=caps(['text.generate','image.generate','speech.synthesize','search','api.call']);readonly calls:ProviderInput[]=[];
  constructor(private scenarios:FakeScenario[]=[{outcome:'success',text:'fixture response'}]){}
  validate(input:ProviderInput){if(!this.capabilities.operations.includes(input.capability))throw new DomainError('unsupported_capability');}
  normalizeUsage(raw:unknown){return (raw as NormalizedUsage)??unknownUsage();}
  estimateUsage():UsageEstimate{return {confidence:'conservative',maximum:{state:'known',items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]}};}
  estimateLimitUsage(){return {requests:1,tokens:10};}
  classifyFailure=classifyFailure;readRateLimits(){return {};}
  async execute(input:ProviderInput,context:AdapterContext):Promise<ProviderResult>{this.validate(input);const scenario=this.scenarios[this.calls.length]??this.scenarios[this.scenarios.length-1];this.calls.push(structuredClone(input));const usage=scenario.usage??{state:'known',items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]};await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage,raw_usage:usage});if(scenario.outcome==='success')return {outcome:'success',output:{content_type:scenario.content_type??'text/plain',text:scenario.text??'fixture response',bytes:scenario.bytes,tool_call:scenario.tool_call},usage};return {outcome:scenario.outcome==='unknown'?'unknown':'failure',failure:{kind:scenario.outcome,code:`fixture_${scenario.outcome}`,safe_to_retry:scenario.outcome==='transient',sent:true},usage};}
}
