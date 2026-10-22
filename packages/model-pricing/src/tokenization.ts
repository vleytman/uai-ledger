import {structuredTransport} from '../../providers/src/structured.js';
import {getEncoding} from 'js-tiktoken';
import {DomainError} from '../../contracts/src/index.js';
export type Tokenizer='o200k_base'|'cl100k_base'|'utf8_upper_bound';
export type TokenInputMode='prompt'|'messages_json'|'compiled_messages_json'|'embedding_batch';
const encoders=new Map<string,ReturnType<typeof getEncoding>>();
export function inputTokens(input:Record<string,unknown>,tokenizer:Tokenizer,mode:TokenInputMode):number{
 if(!['o200k_base','cl100k_base','utf8_upper_bound'].includes(tokenizer)||!['prompt','messages_json','compiled_messages_json','embedding_batch'].includes(mode))throw new DomainError('invalid_calculation','Unregistered tokenization operation',422);
 if(mode==='embedding_batch'){if(!Array.isArray(input.texts)||!input.texts.length||input.texts.length>128||input.texts.some(text=>typeof text!=='string'||Buffer.byteLength(text)>128000))throw new DomainError('invalid_embedding_batch');return input.texts.reduce((total:number,text:string)=>total+inputTokens({text},tokenizer,'prompt'),0);}
 if(mode==='prompt'&&['texts','messages','instructions','response_schema','tools','tool_choice'].some(key=>input[key]!==undefined))throw new DomainError('invalid_calculation','This input requires full-context token counting (messages_json)',422);
 if(mode==='compiled_messages_json'){const compiled=structuredTransport('generic',{...input,capability:'text.generate',model:'estimate',input:String(input.text??''),response_schema:input.response_schema?{name:'result',schema:input.response_schema as Record<string,unknown>}:undefined} as any,'estimate').input;return inputTokens({...input,tools:compiled.tools,response_schema:compiled.response_schema?.schema},tokenizer,'messages_json');}
 const source=mode==='messages_json'?JSON.stringify(input):typeof input.prompt==='string'?input.prompt:typeof input.text==='string'?input.text:'';
 if(Buffer.byteLength(source,'utf8')>2000000)throw new DomainError('invalid_calculation','Input exceeds calculation limit',422);
 if(tokenizer==='utf8_upper_bound')return Buffer.byteLength(source,'utf8');
 let encoder=encoders.get(tokenizer);if(!encoder){encoder=getEncoding(tokenizer);encoders.set(tokenizer,encoder)}
 return encoder.encode(source).length;
}
