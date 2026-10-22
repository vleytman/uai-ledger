import {HttpAdapter,sseEvents} from './index.js';
import {object,unknownUsage} from './usage.js';
import {alternativeFeatures,alternativeModel,validateAlternative} from './alternative-models.js';
import {contentBlocks,validateToolCalls,validateTextFeatures} from './text-input.js';
import {providerParameters} from './parameters.js';
import {DomainError} from '../../contracts/src/index.js';
import type {ProviderInput,AdapterContext,NormalizedUsage} from './contracts.js';

const count=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
export function chatUsage(raw:unknown,provider:string):NormalizedUsage{
 const u=object(raw),input=u.prompt_tokens,output=u.completion_tokens;
 if(!count(input)||!count(output))return unknownUsage('missing_terminal_usage');
 const cached=object(u.prompt_tokens_details).cached_tokens;
 const reasoning=object(u.completion_tokens_details).reasoning_tokens;
 if(cached!==undefined&&(!count(cached)||cached>input)||reasoning!==undefined&&(!count(reasoning)||reasoning>output))return unknownUsage('invalid_usage');
 // Both reasoning and cache are subsets of the corresponding totals.
 return {state:'known',items:[{dimension:'input.uncached',quantity:String(input-(cached??0)),unit:'tokens'},...(cached?[{dimension:'input.cache_read',quantity:String(cached),unit:'tokens'}]:[]),{dimension:'output.text',quantity:String(output),unit:'tokens'}],breakdown:{provider,input_tokens:String(input),output_tokens:String(output),...(reasoning===undefined?{}:{reasoning_tokens:String(reasoning)}),...(cached===undefined?{}:{cached_tokens:String(cached)})}};
}
export function chatMessages(input:ProviderInput){
 const messages:any[]=[];if(input.instructions)messages.push({role:'system',content:input.instructions});
 for(const message of input.messages??[{role:'user',content:input.input}]){
  const blocks=contentBlocks(message.content),calls=blocks.filter(b=>b.type==='tool_call'),results=blocks.filter(b=>b.type==='tool_result');
  const content=blocks.flatMap(b=>{
   if(b.type==='text')return [{type:'text',text:b.text}] as any[];
   if(b.type!=='image')return [];
   const a=input.assets!.find(a=>a.filename===b.asset_id);if(!a)throw new Error('missing_asset');
   return [{type:'image_url',image_url:{url:`data:${a.content_type};base64,${Buffer.from(a.bytes).toString('base64')}`}}];
  });
  if(content.length||calls.length)messages.push({role:message.role,content:content.length?content:null,...(calls.length?{tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}:{})});
  for(const r of results)messages.push({role:'tool',tool_call_id:r.call_id,content:JSON.stringify(r.is_error?{error:r.result}:r.result)});
 }
 return messages;
}
/** Shared wire framing only. Provider wrappers retain endpoints, parameters and accounting. */
export abstract class ChatCompletionsAdapter extends HttpAdapter {
 abstract readonly id:'cerebras'|'groq';abstract readonly endpoint:string;
 readonly capabilities={text_usage:{estimated_actual:true,output_limit:'required' as const},operations:['text.generate' as const],streaming:true,native_jobs:false,lookup:false,cancel:false,idempotency:false,usage:true,read_usage:false,read_costs:false,read_balance:false};
 allowedParameters(){return [...providerParameters(this.id,'text.generate')??[]];}
 acceptsAssets(input:ProviderInput){const m=alternativeModel(this.id,input.model);return !!m.images;}
 override validate(input:ProviderInput){super.validate(input);validateAlternative(this.id,input);validateTextFeatures(alternativeFeatures(this.id,input.model),input);}
 override estimateLimitUsage(input:ProviderInput){const m=alternativeModel(this.id,input.model);return {requests:1,input_tokens:m.context,output_tokens:input.max_output_tokens??m.output,tokens:m.context+(input.max_output_tokens??m.output)};}
 normalizeUsage(raw:unknown){return chatUsage(raw,this.id);}
 override actualLimitUsage(raw:unknown){const u=object(raw);return count(u.prompt_tokens)&&count(u.completion_tokens)?{requests:1,input_tokens:u.prompt_tokens,output_tokens:u.completion_tokens,tokens:u.prompt_tokens+u.completion_tokens}:undefined;}
 request(input:ProviderInput,stream:boolean){
  this.validate({...input,stream});
  const choice=input.tool_choice;
  return {url:this.endpoint,headers:{authorization:`Bearer ${this.options.apiKey}`,'content-type':'application/json'},body:{model:input.model,messages:chatMessages(input),...input.parameters,max_completion_tokens:input.max_output_tokens,stream,...(stream?{stream_options:{include_usage:true}}:{}),...(input.response_schema?{response_format:{type:'json_schema',json_schema:{name:input.response_schema.name,schema:input.response_schema.schema,strict:true}}}:{}),...(input.tools?{tools:input.tools.map(t=>({type:'function',function:{...t}})),tool_choice:choice?.type==='named'?{type:'function',function:{name:choice.name}}:choice?.type??'auto',parallel_tool_calls:input.parallel_tool_calls??false}:{})}};
 }
 refusal(body:Record<string,any>){const c=body.choices?.[0];return c?.message?.refusal??(c?.finish_reason==='content_filter'?'Content refused':undefined);}
 extract(body:Record<string,any>,input:ProviderInput){
  if(!Array.isArray(body.choices)||body.choices.length!==1)throw new Error('invalid_choices');
  const c=body.choices[0];
  if(c.finish_reason==='length')throw new DomainError('output_limit_reached','Completion exhausted the output token limit',422,{path:'max_output_tokens',reason:'output_limit_reached'});
  if(!['stop','tool_calls'].includes(c.finish_reason))throw new Error('incomplete_completion');
  const calls=(c.message?.tool_calls??[]).map((t:any)=>({id:t.id,name:t.function?.name,arguments:JSON.parse(t.function?.arguments),execution_method:'native' as const}));
  if(calls.length||input.tool_choice?.type==='required'||input.tool_choice?.type==='named'){
   const valid=validateToolCalls(input,calls);return {content_type:'application/json',text:valid.length===1?JSON.stringify(valid[0].arguments):JSON.stringify(valid),...(valid.length===1?{tool_call:valid[0]}:{tool_calls:valid})};
  }
  if(typeof c.message?.content!=='string'||!c.message.content)throw new Error('missing_text');
  return {content_type:'text/plain',text:c.message.content};
 }
 protected async stream(response:Response,_input:ProviderInput,context:AdapterContext){
  let text='',refusal='',finish:string|undefined,usage:unknown,id:string|undefined;
  const calls=new Map<number,{id:string;function:{name:string;arguments:string}}>();
  for await(const event of sseEvents(response)){
   const d=object(event.data);if(typeof d.id==='string')id=d.id;
   if(d.usage)usage=d.usage;else if(d.x_groq?.usage)usage=d.x_groq.usage;
   for(const c of d.choices??[]){if(c.index!==0)throw new Error('multiple_choices');if(c.finish_reason)finish=c.finish_reason;const delta=c.delta??{};
    if(typeof delta.content==='string'){text+=delta.content;await context.onDelta?.(delta.content);}if(typeof delta.refusal==='string')refusal+=delta.refusal;
    for(const t of delta.tool_calls??[]){if(!Number.isInteger(t.index)||t.index<0||t.index>=64)throw new Error('invalid_tool_index');const call=calls.get(t.index)??{id:'',function:{name:'',arguments:''}};
     if(t.id){if(call.id&&call.id!==t.id)throw new Error('tool_id_changed');call.id=t.id;}
     call.function.name+=t.function?.name??'';call.function.arguments+=t.function?.arguments??'';calls.set(t.index,call);
    }
   }
  }
  if(!finish)throw new Error('missing_terminal_event');
  return {id,usage,choices:[{finish_reason:finish,message:{content:text,...(refusal?{refusal}:{}),tool_calls:[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v)}}]};
 }
}
export class CerebrasAdapter extends ChatCompletionsAdapter {readonly id='cerebras';readonly endpoint='https://api.cerebras.ai/v1/chat/completions';}
export class GroqAdapter extends ChatCompletionsAdapter {readonly id='groq';readonly endpoint='https://api.groq.com/openai/v1/chat/completions';}
