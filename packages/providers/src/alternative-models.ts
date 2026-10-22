import {DomainError} from '../../contracts/src/index.js';
import type {TextFeatures} from '../../contracts/invocation.js';
import type {z} from 'zod';
import type {ProviderInput} from './contracts.js';
export const alternativeModels = [
 {provider:'cerebras',id:'qwen-3.8-27b',context:65536,output:32768,images:3,imageBytes:4000000,parallel:true,preview:false,inputRate:'0.99',outputRate:'1.49'},
 {provider:'cerebras',id:'gpt-oss-120b',context:131072,output:40960,images:0,imageBytes:4000000,parallel:false,preview:false,inputRate:'0.35',outputRate:'0.75'},
 {provider:'groq',id:'qwen/qwen3.8-27b',context:131072,output:16384,images:3,imageBytes:4000000,parallel:false,preview:true,inputRate:'0.80',outputRate:'4.00'},
 {provider:'groq',id:'openai/gpt-oss-20b',context:131072,output:65536,images:0,imageBytes:4000000,parallel:true,preview:false,inputRate:'0.075',outputRate:'0.30'},
 {provider:'google_cloud',id:'gemini-3.8-flash',context:1048576,output:65536,images:16,imageBytes:7000000,parallel:true,preview:false,inputRate:'0.75',outputRate:'3.75'},
] as const;
export function alternativeModel(provider:string,id:string){const m=alternativeModels.find(m=>m.provider===provider&&m.id===id);if(!m)throw new DomainError('unsupported_model','Model is not registered for this provider',422);return m;}
export function isAlternativeProvider(provider:string){return alternativeModels.some(m=>m.provider===provider);}
export function alternativeFeatures(provider:string,id:string):z.infer<typeof TextFeatures>{const m=alternativeModel(provider,id);return {tools:true,forced_tool_choice:true,tool_history:true,parallel_tools:m.parallel,schema:true,schema_streaming:provider==='google_cloud',tool_streaming:true,usage_counters:['input','output','reasoning',...(provider==='google_cloud'||id==='openai/gpt-oss-20b'||provider==='cerebras'&&id==='gpt-oss-120b'?['cache_read' as const]:[])],output_limit:'required',max_output_tokens:m.output,max_images:m.images,max_image_bytes:m.imageBytes,image_media_types:m.images?['image/png','image/jpeg','image/webp']:[],image_detail:m.images?['auto']:[],cache:provider==='google_cloud'||id==='openai/gpt-oss-20b'||provider==='cerebras'&&id==='gpt-oss-120b'?'automatic':'none'};}
export function validateAlternative(provider:string,input:ProviderInput){
 const m=alternativeModel(provider,input.model),p=input.parameters??{};
 if(input.service_mode!==undefined&&(provider!=='google_cloud'||input.service_mode!=='standard'))throw new DomainError('unsupported_service_mode');
 if(!Number.isSafeInteger(input.max_output_tokens)||input.max_output_tokens!<1||input.max_output_tokens!>m.output)throw new DomainError('invalid_output_limit');
 if(input.parallel_tool_calls&&!m.parallel)throw new DomainError('unsupported_parallel_tools');
 if(input.response_schema&&input.stream&&provider!=='google_cloud')throw new DomainError('unsupported_schema_streaming');
 for(const [key,max] of [['temperature',2],['top_p',1]] as const)if(p[key]!==undefined&&(typeof p[key]!=='number'||!Number.isFinite(p[key])||Number(p[key])<0||Number(p[key])>max))throw new DomainError('invalid_parameter');
 if(p.seed!==undefined&&(!Number.isSafeInteger(p.seed)||Math.abs(Number(p.seed))>2147483647))throw new DomainError('invalid_parameter');
 if(p.reasoning_effort!==undefined){const allowed=input.model.includes('gpt-oss')?['low','medium','high']:provider==='groq'?['none','default','low','medium','high']:[];if(!allowed.includes(String(p.reasoning_effort)))throw new DomainError('invalid_reasoning_effort');}
 if(p.thinking_level!==undefined&&(provider!=='google_cloud'||!['LOW','MEDIUM','HIGH'].includes(String(p.thinking_level))))throw new DomainError('invalid_thinking_level');
 if((input.assets?.length??0)>m.images||input.assets?.some(a=>!['image/png','image/jpeg','image/webp'].includes(a.content_type)||!a.bytes.length||a.bytes.length>m.imageBytes))throw new DomainError('unsupported_assets');
}
