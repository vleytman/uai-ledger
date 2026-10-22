import {DomainError} from '../../contracts/src/index.js';
import {inputTokens} from '../../model-pricing/src/tokenization.js';
import type {ProviderInput,NormalizedUsage} from './contracts.js';
export interface EmbeddingBatch {model:string;revision?:string|null;dimensions:number;data:{index:number;embedding:number[]}[]}
/** Verified provider limits, intersected with the installation's bounded JSON transport. */
export const embeddingModels = {
 'text-embedding-3-small':{provider:'openai',default_dimensions:1536,max_dimensions:1536,dimensions:null,max_tokens:8192,max_batch_tokens:300000,max_batch:2048,input_types:[] as string[],token_count:'cl100k_base'},
 'text-embedding-3-large':{provider:'openai',default_dimensions:3072,max_dimensions:3072,dimensions:null,max_tokens:8192,max_batch_tokens:300000,max_batch:2048,input_types:[] as string[],token_count:'cl100k_base'},
 'voyage-4':{provider:'voyage',default_dimensions:1024,max_dimensions:2048,dimensions:[256,512,1024,2048],max_tokens:32000,max_batch_tokens:320000,max_batch:1000,input_types:['query','document'],token_count:'utf8_upper_bound'},
} as const;
export const embeddingInstallationLimits={max_batch:128,max_coordinates:16384,max_text_bytes:128000,max_result_bytes:512*1024};
export function embeddingModel(model:string){
 if(!Object.hasOwn(embeddingModels,model))throw new DomainError('unsupported_embedding_model');
 return embeddingModels[model as keyof typeof embeddingModels];
}
export function embeddingDimensions(model:string,requested:unknown){
 const spec=embeddingModel(model),value=requested??spec.default_dimensions;
 if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>spec.max_dimensions||spec.dimensions&&!(spec.dimensions as readonly number[]).includes(Number(value)))throw new DomainError('unsupported_embedding_dimensions');return Number(value);
}
export function validateEmbeddingInput(input:Pick<ProviderInput,'model'|'texts'|'parameters'>){
 const spec=embeddingModel(input.model),limits=embeddingInstallationLimits;
 const dimensions=embeddingDimensions(input.model,input.parameters?.dimensions);
 if(Object.keys(input.parameters??{}).some(key=>!['dimensions','input_type'].includes(key)))throw new DomainError('unsupported_parameter');
 if(input.parameters?.input_type!==undefined&&!(spec.input_types as readonly unknown[]).includes(input.parameters.input_type))throw new DomainError('unsupported_embedding_input_type');
 if(!Array.isArray(input.texts)||!input.texts.length||input.texts.length>Math.min(spec.max_batch,limits.max_batch)||input.texts.some(text=>typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>Math.min(limits.max_text_bytes,spec.provider==='openai'?32768:128000)))throw new DomainError('invalid_embedding_batch');
 if(input.texts.reduce((sum,text)=>sum+Buffer.byteLength(text),0)>limits.max_text_bytes)throw new DomainError('embedding_batch_bytes_limit');
 if(input.texts.length*dimensions>limits.max_coordinates)throw new DomainError('embedding_result_limit');
 // Voyage does not ship a tokenizer here. UTF-8 bytes plus retrieval framing are an explicit conservative bound, never truncation.
 const counts=input.texts.map(text=>spec.token_count==='cl100k_base'?inputTokens({text},'cl100k_base','prompt'):Buffer.byteLength(text)+(input.parameters?.input_type?64:0));
 if(counts.some(count=>count>spec.max_tokens)||counts.reduce((n,count)=>n+count,0)>spec.max_batch_tokens)throw new DomainError('embedding_token_limit');
 return counts.reduce((n,count)=>n+count,0);
}
export function validateEmbeddingOutput(value:unknown,input:Pick<ProviderInput,'model'|'texts'|'parameters'>):EmbeddingBatch{
 const batch=value as EmbeddingBatch,dimensions=embeddingDimensions(input.model,input.parameters?.dimensions);
 if(!batch||batch.revision!==undefined&&batch.revision!==null&&(typeof batch.revision!=='string'||!batch.revision.length||batch.revision.length>200)||batch.model!==input.model||batch.dimensions!==undefined&&batch.dimensions!==dimensions||!Array.isArray(batch.data)||batch.data.length!==input.texts?.length||batch.data.length>128)throw new DomainError('result_defect');
 const seen=new Set<number>();
 for(const item of batch.data){
  if(!item||!Number.isSafeInteger(item.index)||item.index<0||item.index>=batch.data.length||seen.has(item.index)||!Array.isArray(item.embedding)||item.embedding.length!==dimensions||item.embedding.some(number=>typeof number!=='number'||!Number.isFinite(number)))throw new DomainError('result_defect');
  seen.add(item.index);
 }
 const output={model:batch.model,revision:batch.revision??null,dimensions,data:batch.data.map(item=>({index:item.index,embedding:item.embedding})).sort((a,b)=>a.index-b.index)};
 if(Buffer.byteLength(JSON.stringify(output))>512*1024)throw new DomainError('result_defect');return output;
}
export function embeddingUsage(raw:unknown):NormalizedUsage{
 const value=raw as {prompt_tokens?:unknown;total_tokens?:unknown};
 if(!value||!Number.isSafeInteger(value.prompt_tokens)||Number(value.prompt_tokens)<0||value.total_tokens!==value.prompt_tokens)return {state:'unknown',reason:'embedding_usage_missing_or_inconsistent'};
 return {state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:String(value.prompt_tokens)}]};
}
