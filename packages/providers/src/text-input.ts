import {DomainError} from '../../contracts/src/index.js';
import {ContentBlock,ToolDefinition,ToolChoice,ToolCallRecord} from '../../contracts/invocation.js';
import {checkSchema,validateStructured,providerSchema} from '../../contracts/schema.js';
import type {ProviderInput,ProviderBlock,ToolCall} from './contracts.js';

export function validateTextInput(input:Pick<ProviderInput,'messages'|'tools'|'tool_choice'|'response_schema'>){
 if(input.messages){
  if(!Array.isArray(input.messages)||!input.messages.length||input.messages.length>256)throw new DomainError('invalid_messages');
  const calls=new Map<string,string>(),pending=new Set<string>(),resolved=new Set<string>();
  for(const message of input.messages){
   if(!message||!['user','assistant','system'].includes(message.role))throw new DomainError('invalid_messages');
   if(pending.size&&(message.role!=='user'||typeof message.content==='string'))throw new DomainError('missing_tool_result');
   if(typeof message.content==='string')continue;
   if(!Array.isArray(message.content)||!message.content.length||message.content.length>128)throw new DomainError('invalid_messages');
   for(const block of message.content){
    if(block.type==='tool_call'){if(message.role!=='assistant'||calls.has(block.id))throw new DomainError('invalid_tool_history');calls.set(block.id,block.name);pending.add(block.id);}
    else if(block.type==='tool_result'){if(message.role!=='user'||!pending.has(block.call_id)||resolved.has(block.call_id))throw new DomainError('invalid_tool_history');pending.delete(block.call_id);resolved.add(block.call_id);}
    else if(pending.size&&message.role!=='assistant')throw new DomainError('missing_tool_result');
   }
   for(const block of message.content)if(!ContentBlock.safeParse(block).success||message.role==='system'&&block.type==='image')throw new DomainError('invalid_content_block');
  }
  if(pending.size)throw new DomainError('missing_tool_result');
 }
 if(input.response_schema)checkSchema(input.response_schema.schema);
 if(input.tools!==undefined){
  if(!Array.isArray(input.tools)||!input.tools.length||input.tools.length>64||input.response_schema)throw new DomainError('invalid_tools');
  const names=new Set<string>();
  for(const tool of input.tools){
   if(!ToolDefinition.safeParse(tool).success||names.has(tool.name)||tool.parameters.type!=='object')throw new DomainError('invalid_tools');
   names.add(tool.name);checkSchema(tool.parameters);
  }
  if(!ToolChoice.safeParse(input.tool_choice).success||input.tool_choice?.type==='named'&&!names.has(input.tool_choice.name))throw new DomainError('invalid_tool_choice');
 }else if(input.tool_choice!==undefined)throw new DomainError('invalid_tool_choice');
}

export function validateProviderText(provider:string,input:ProviderInput){
 validateTextInput(input);
 if(input.tools&&['auto','none'].includes(input.tool_choice?.type??'')&&!['cerebras','groq','google_cloud','fake'].includes(provider))throw new DomainError('unsupported_tool_choice');
 if(provider!=='fake'){if(input.response_schema)providerSchema(input.response_schema.schema);for(const tool of input.tools??[])providerSchema(tool.parameters);}
 const referenced=new Set((input.messages??[]).flatMap(message=>contentBlocks(message.content)).filter(block=>block.type==='image').map(block=>block.asset_id));
 if(input.assets?.some(asset=>!referenced.has(asset.filename)))throw new DomainError('unreferenced_input_asset');
 for(const message of input.messages??[])for(const block of contentBlocks(message.content)){
  if(block.type==='tool_call'){if(block.continuation&&(block.continuation.provider!==provider||block.continuation.model!==input.model))throw new DomainError('incompatible_continuation');}
  if((block.type==='tool_call'||block.type==='tool_result')&&!['cerebras','groq','google_cloud'].includes(provider))throw new DomainError('unsupported_tool_history');
 }
 if(provider==='openai'){
  const key=input.parameters?.prompt_cache_key;
  if(key!==undefined&&(typeof key!=='string'||!key.length||key.length>64))throw new DomainError('invalid_prompt_cache_key','Cache key must contain 1 to 64 characters',422);
 }
 if(provider==='anthropic'){

  for(const message of input.messages??[])for(const block of typeof message.content==='string'?[]:message.content){
   if(('cache' in block?block.cache:undefined)?.ttl_seconds!==undefined&&'cache' in block&&![300,3600].includes(block.cache!.ttl_seconds!))throw new DomainError('unsupported_cache_ttl');
   if(block.type==='image'&&block.detail&&block.detail!=='auto')throw new DomainError('unsupported_image_detail');
  }
 }
}

export function contentBlocks(content:string|ProviderBlock[]):ProviderBlock[]{return typeof content==='string'?[{type:'text',text:content}]:content;}
function imageAsset(input:ProviderInput,id:string){
 const asset=input.assets?.find(asset=>asset.filename===id);
 if(!asset||!['image/png','image/jpeg','image/webp'].includes(asset.content_type)||!asset.bytes.length||asset.bytes.length>20000000)throw new DomainError('unsupported_assets');
 return asset;
}
export function openAIContent(input:ProviderInput,content:string|ProviderBlock[],role:string){
 return contentBlocks(content).map(block=>{
  if(block.type==='text')return {type:role==='assistant'?'output_text':'input_text',text:block.text};
  if(block.type!=='image')throw new DomainError('unsupported_tool_history');
  const asset=imageAsset(input,block.asset_id);
  return {type:'input_image',image_url:`data:${asset.content_type};base64,${Buffer.from(asset.bytes).toString('base64')}`,detail:block.detail??'auto'};
 });
}
export function anthropicContent(input:ProviderInput,content:string|ProviderBlock[]){
 return contentBlocks(content).map(block=>{
  const cache=('cache' in block&&block.cache)?{cache_control:{type:'ephemeral',...(block.cache.ttl_seconds?{ttl:block.cache.ttl_seconds===3600?'1h':'5m'}:{})}}:{};
  if(('cache' in block?block.cache:undefined)?.ttl_seconds!==undefined&&'cache' in block&&![300,3600].includes(block.cache!.ttl_seconds!))throw new DomainError('unsupported_cache_ttl');
  if(block.type==='text')return {type:'text',text:block.text,...cache};
  if(block.type!=='image')throw new DomainError('unsupported_tool_history');
  const asset=imageAsset(input,block.asset_id);
  if(asset.bytes.length>5000000)throw new DomainError('unsupported_assets');
  return {type:'image',source:{type:'base64',media_type:asset.content_type,data:Buffer.from(asset.bytes).toString('base64')},...cache};
 });
}

/** Validate actual output independently of provider-side enforcement. */
export function validateToolCalls(input:ProviderInput,calls:unknown[]):ToolCall[]{
 const forced=input.tool_choice?.type==='required'||input.tool_choice?.type==='named';
 if(!input.tools||input.tool_choice?.type==='none'&&calls.length||forced&&calls.length!==1||!input.parallel_tool_calls&&calls.length>1)throw new DomainError('result_defect');
 const ids=new Set<string>();return calls.map(value=>{const call=ToolCallRecord.parse(value);if(ids.has(call.id))throw new DomainError('result_defect');ids.add(call.id);const tool=input.tools!.find(t=>t.name===call.name);if(!tool||input.tool_choice?.type==='named'&&input.tool_choice.name!==call.name)throw new DomainError('result_defect');validateStructured(call.arguments,tool.parameters);return call;});
}
export function validateToolCall(input:ProviderInput,calls:unknown[]):ToolCall{
 if(!input.tools||calls.length!==1)throw new DomainError('result_defect');
 const call=calls[0] as ToolCall;
 if(!call||typeof call.id!=='string'||!call.id||typeof call.name!=='string'||input.tool_choice?.type==='named'&&call.name!==input.tool_choice.name)throw new DomainError('result_defect');
 const tool=input.tools.find(tool=>tool.name===call.name);if(!tool)throw new DomainError('result_defect');
 validateStructured(call.arguments,tool.parameters);return call;
}

export function validateTextFeatures(features:import('../../catalog/src/index.js').ModelDefinition['text_features'],input:ProviderInput){
 if((input.messages??[]).some(m=>contentBlocks(m.content).some(b=>b.type==='tool_call'||b.type==='tool_result'))&&!features?.tool_history)throw new DomainError('unsupported_tool_history');
 if(!features?.parallel_tools&&(input.messages??[]).some(m=>contentBlocks(m.content).filter(b=>b.type==='tool_call').length>1))throw new DomainError('unsupported_parallel_tools');
 if(input.tools&&(features?.forced_tool_choice===false||!features?.tools||/^claude-(?:opus-5[.-]5|fable-5[.-]1|mythos-5[.-]1)/.test(input.model))&&!features?.schema)throw new DomainError('unsupported_model_constraint','Tool emulation requires structured output support',422);
 if(input.parallel_tool_calls&&!features?.parallel_tools)throw new DomainError('unsupported_parallel_tools');
 if(input.response_schema&&input.stream&&features?.schema_streaming===false)throw new DomainError('unsupported_schema_streaming');
 if(input.tools&&input.stream&&features?.tool_streaming===false)throw new DomainError('unsupported_tool_streaming');
 if(features?.max_output_tokens&&input.max_output_tokens!>features.max_output_tokens)throw new DomainError('invalid_output_limit');
 if(features?.max_images!==undefined&&(input.assets?.length??0)>features.max_images||input.assets?.some(a=>features?.max_image_bytes!==undefined&&a.bytes.length>features.max_image_bytes))throw new DomainError('unsupported_assets');
 const blocks=(input.messages??[]).flatMap(message=>contentBlocks(message.content));
 if(input.tools&&!features?.tools&&!features?.schema||input.response_schema&&!features?.schema||blocks.some(block=>block.type==='image'&&!features?.image_detail.includes(block.detail??'auto')||('cache' in block&&block.cache)&&(!features||features.cache==='none')))throw new DomainError('unsupported_model_constraint','The model has no published support for this input',422);
 for(const asset of input.assets??[])if(!features?.image_media_types.includes(asset.content_type as any))throw new DomainError('unsupported_model_image');
}
