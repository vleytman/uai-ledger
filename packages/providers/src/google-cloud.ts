import {createHash} from 'node:crypto';
import {GoogleAuth} from 'google-auth-library';
import {HttpAdapter,sseEvents,type AdapterOptions} from './index.js';
import {DomainError} from '../../contracts/src/index.js';
import {object,unknownUsage} from './usage.js';
import {alternativeFeatures,alternativeModel,validateAlternative} from './alternative-models.js';
import {contentBlocks,validateToolCalls,validateTextFeatures} from './text-input.js';
import {providerParameters} from './parameters.js';
import type {ProviderInput,AdapterContext,NormalizedUsage} from './contracts.js';

/** Shared by attempts in one worker, including concurrent first use. No generation retry. */
export class RefreshingToken {
 private token?:{value:string;expires:number};private pending?:Promise<string>;
 constructor(private refresh:()=>Promise<{value:string;expires:number}>,private now=()=>Date.now()){}
 async get(){if(this.token&&this.token.expires>this.now()+60000)return this.token.value;if(!this.pending)this.pending=this.refresh().then(t=>{if(!t.value||t.expires<=this.now()+60000)throw new Error('invalid_token');this.token=t;return t.value;}).finally(()=>{this.pending=undefined;});return this.pending;}
}
const tokens=new Map<string,RefreshingToken>();
function credentialToken(secret:string){
 const key=createHash('sha256').update(secret).digest('hex');let token=tokens.get(key);if(token)return token;
 let credentials:any;try{credentials=JSON.parse(secret);}catch{throw new DomainError('invalid_cloud_credential');}
 // Only explicit service-account or user ADC JSON from the encrypted vault. No URLs from configuration.
 if(!['service_account','authorized_user'].includes(credentials.type))throw new DomainError('unsupported_cloud_credential');
 if(credentials.type==='service_account'&&credentials.token_uri&&credentials.token_uri!=='https://oauth2.googleapis.com/token')throw new DomainError('invalid_cloud_credential');
 const auth=new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/cloud-platform']});
 token=new RefreshingToken(async()=>{const client=await auth.getClient();const result=await client.getAccessToken();return {value:result.token??'',expires:client.credentials.expiry_date??0};});
 if(tokens.size>=128)tokens.delete(tokens.keys().next().value!);tokens.set(key,token);return token;
}
const count=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
export function geminiUsage(raw:unknown):NormalizedUsage{
 const u=object(raw),input=u.promptTokenCount,output=u.candidatesTokenCount,thought=u.thoughtsTokenCount,cache=u.cachedContentTokenCount;
 if(!count(input)||!count(output)||thought!==undefined&&!count(thought)||cache!==undefined&&(!count(cache)||cache>input))return unknownUsage('missing_or_invalid_usage');
 // Gemini candidates exclude thoughts; cached content is a subset of prompt tokens.
 const total=output+(thought??0);if(!Number.isSafeInteger(total))return unknownUsage('invalid_usage');
 return {state:'known',items:[{dimension:'input.uncached',quantity:String(input-(cache??0)),unit:'tokens',conditions:{service_mode:'standard'}},...(cache?[{dimension:'input.cache_read',quantity:String(cache),unit:'tokens',conditions:{service_mode:'standard'}}]:[]),{dimension:'output.text',quantity:String(total),unit:'tokens',conditions:{service_mode:'standard'}}],breakdown:{input_tokens:String(input),output_tokens:String(total),...(thought===undefined?{}:{reasoning_tokens:String(thought)}),...(cache===undefined?{}:{cached_tokens:String(cache)})}};
}
export class GoogleCloudAdapter extends HttpAdapter {
 readonly id='google_cloud';readonly capabilities={text_usage:{estimated_actual:true,output_limit:'required' as const},operations:['text.generate' as const],streaming:true,native_jobs:false,lookup:false,cancel:false,idempotency:false,usage:true,read_usage:false,read_costs:false,read_balance:false};
 constructor(options:AdapterOptions){super(options);}
 protected async authorization(){return {authorization:`Bearer ${await (this.options.googleToken?.get()??credentialToken(this.options.apiKey).get())}`};}
 protected override errorUsage(status:number,error:unknown,input:ProviderInput):NormalizedUsage{
  // Agent Platform bills only HTTP 200. These are billable quantities, not a claim
  // that the server processed zero tokens. Transport loss and incomplete 200 stay unknown.
  // https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
  if(status>=400&&status<600)return {state:'known',items:[{dimension:'input.uncached',quantity:'0',unit:'tokens',conditions:{service_mode:'standard'}},{dimension:'output.text',quantity:'0',unit:'tokens',conditions:{service_mode:'standard'}}],breakdown:{http_status:String(status),billing_basis:'google_cloud_non_200_not_billable'}};
  return super.errorUsage(status,error,input);
 }
 allowedParameters(){return [...providerParameters(this.id,'text.generate')!];}
 acceptsAssets(){return true;}
 override validate(input:ProviderInput){super.validate(input);validateAlternative(this.id,input);validateTextFeatures(alternativeFeatures(this.id,input.model),input);if(!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(this.options.googleProject??'')||this.options.googleLocation!=='global')throw new DomainError('invalid_cloud_connection');}
 override estimateLimitUsage(input:ProviderInput){const m=alternativeModel(this.id,input.model);return {requests:1,input_tokens:m.context,output_tokens:input.max_output_tokens??m.output,tokens:m.context+(input.max_output_tokens??m.output)};}
 normalizeUsage(raw:unknown){return geminiUsage(raw);}
 override actualLimitUsage(raw:unknown){const u=geminiUsage(raw);return u.state==='known'?{requests:1,input_tokens:Number(u.breakdown!.input_tokens),output_tokens:Number(u.breakdown!.output_tokens),tokens:Number(u.breakdown!.input_tokens)+Number(u.breakdown!.output_tokens)}:undefined;}
 request(input:ProviderInput,stream:boolean){
  this.validate(input);const p=input.parameters??{},names=new Map<string,string>();
  const system:string[]=[];if(input.instructions)system.push(input.instructions);
  const contents:any[]=[];
  for(const m of input.messages??[{role:'user',content:input.input}]){
   if(m.role==='system'){for(const b of contentBlocks(m.content)){if(b.type!=='text')throw new DomainError('invalid_system_content');system.push(b.text);}continue;}
   const parts=contentBlocks(m.content).map(b=>{
    if(b.type==='text')return {text:b.text};
    if(b.type==='image'){const a=input.assets!.find(a=>a.filename===b.asset_id);if(!a)throw new DomainError('missing_asset');return {inlineData:{mimeType:a.content_type,data:Buffer.from(a.bytes).toString('base64')}};}
    if(b.type==='tool_call'){names.set(b.id,b.name);return {functionCall:{id:b.id,name:b.name,args:b.arguments},...(b.continuation?{thoughtSignature:b.continuation.thought_signature}:{})};}
    return {functionResponse:{id:b.call_id,name:names.get(b.call_id),response:b.is_error?{error:b.result}:{result:b.result}}};
   });contents.push({role:m.role==='assistant'?'model':'user',parts});
  }
  return {url:`https://aiplatform.googleapis.com/v1/projects/${this.options.googleProject}/locations/global/publishers/google/models/${input.model}:${stream?'streamGenerateContent?alt=sse':'generateContent'}`,headers:{'content-type':'application/json','X-Vertex-AI-LLM-Request-Type':'shared'},body:{contents,...(system.length?{systemInstruction:{parts:system.map(text=>({text}))}}:{}),generationConfig:{maxOutputTokens:input.max_output_tokens,...(p.temperature===undefined?{}:{temperature:p.temperature}),...(p.top_p===undefined?{}:{topP:p.top_p}),...(p.seed===undefined?{}:{seed:p.seed}),thinkingConfig:{thinkingLevel:p.thinking_level??'LOW',includeThoughts:false},...(input.response_schema?{responseMimeType:'application/json',responseJsonSchema:input.response_schema.schema}:{})},...(input.tools?{tools:[{functionDeclarations:input.tools.map(t=>({name:t.name,description:t.description,parametersJsonSchema:t.parameters}))}],toolConfig:{functionCallingConfig:{mode:input.tool_choice?.type==='none'?'NONE':input.tool_choice?.type==='auto'?'AUTO':'ANY',...(input.tool_choice?.type==='named'?{allowedFunctionNames:[input.tool_choice.name]}:{})}}}:{})}};
 }
 refusal(body:Record<string,any>){const reason=body.promptFeedback?.blockReason??body.candidates?.[0]?.finishReason;return ['SAFETY','BLOCKLIST','PROHIBITED_CONTENT','RECITATION','SPII','IMAGE_SAFETY','OTHER'].includes(reason)?String(reason):undefined;}
 extract(body:Record<string,any>,input:ProviderInput){
  const candidates=body.candidates;
  if(Array.isArray(candidates)&&candidates.length===1&&candidates[0].finishReason==='MAX_TOKENS')throw new DomainError('output_limit_reached','Completion exhausted the output token limit',422,{path:'max_output_tokens',reason:'output_limit_reached'});
  if(!Array.isArray(candidates)||candidates.length!==1||candidates[0].finishReason!=='STOP')throw new Error('incomplete_candidate');
  const parts=candidates[0].content?.parts??[];
  const calls=parts.filter((p:any)=>p.functionCall).map((p:any,i:number)=>({id:p.functionCall.id??`gemini-${body.responseId??body.id}-${i}`,name:p.functionCall.name,arguments:p.functionCall.args,execution_method:'native' as const,...(p.thoughtSignature?{continuation:{provider:this.id,model:input.model,thought_signature:p.thoughtSignature}}:{})}));
  if(calls.length||['required','named'].includes(input.tool_choice?.type??'')){const valid=validateToolCalls(input,calls);return {content_type:'application/json',text:valid.length===1?JSON.stringify(valid[0].arguments):JSON.stringify(valid),...(valid.length===1?{tool_call:valid[0]}:{tool_calls:valid})};}
  const text=parts.filter((p:any)=>!p.thought&&typeof p.text==='string').map((p:any)=>p.text).join('');if(!text)throw new Error('missing_text');return {content_type:'text/plain',text};
 }
 protected async stream(response:Response,_input:ProviderInput,context:AdapterContext){
  const parts:any[]=[];let finishReason:string|undefined,usage:unknown,responseId:string|undefined,promptFeedback:unknown;
  for await(const e of sseEvents(response)){const d=object(e.data);if(d.usageMetadata)usage=d.usageMetadata;if(d.responseId)responseId=d.responseId;if(d.promptFeedback)promptFeedback=d.promptFeedback;
   for(const c of d.candidates??[]){if(c.index!==undefined&&c.index!==0)throw new Error('multiple_candidates');if(c.finishReason)finishReason=c.finishReason;for(const p of c.content?.parts??[]){parts.push(p);if(!p.thought&&typeof p.text==='string')await context.onDelta?.(p.text);}}
  }
  if(!finishReason&&!promptFeedback)throw new Error('missing_terminal_event');
  return {responseId,usage,promptFeedback,candidates:[{finishReason,content:{parts}}]};
 }
 // HttpAdapter uses a common usage slot; preserve the provider's original counters.
 override async execute(input:ProviderInput,context:AdapterContext){
  return super.execute(input,context);
 }
}
