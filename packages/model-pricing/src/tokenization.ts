import {structuredTransport} from '../../providers/src/structured.js';
import o200k from 'js-tiktoken/ranks/o200k_base';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
import {DomainError} from '../../contracts/src/index.js';
export type Tokenizer='o200k_base'|'cl100k_base'|'utf8_upper_bound';
export type TokenInputMode='prompt'|'messages_json'|'compiled_messages_json'|'embedding_batch';
interface Vocabulary {ranks:Map<string,number>;texts:string[];pattern:string;maxBytes:number;pairs:Map<number,number>[];cached:number;last?:{text:string;count:number}}
const vocabularies=new Map<string,Vocabulary>();
function vocabulary(tokenizer:'o200k_base'|'cl100k_base'):Vocabulary{
 let v=vocabularies.get(tokenizer);if(v)return v;
 const source=tokenizer==='o200k_base'?o200k:cl100k;v={ranks:new Map(),texts:[],pattern:source.pat_str,maxBytes:0,pairs:[],cached:0};
 for(const line of source.bpe_ranks.split('\n')){if(!line)continue;const [,offset,...tokens]=line.split(' ');tokens.forEach((token,i)=>{const text=Buffer.from(token,'base64').toString('latin1');v!.ranks.set(text,+offset+i);v!.texts[+offset+i]=text;if(text.length>v!.maxBytes)v!.maxBytes=text.length;});}
 vocabularies.set(tokenizer,v);return v;
}
// js-tiktoken merges each regex piece in quadratic time: 24 000 letters without spaces took 34 s on the API event loop.
// The heap applies the same lowest-rank, leftmost merge order, so counts equal encode().length at n log n cost.
function pieceTokens(v:Vocabulary,bytes:string):number{
 const n=bytes.length;if(n===1||n<=v.maxBytes&&v.ranks.has(bytes))return 1;
 // Heap keys order by rank, then by start offset: rank*2^21+start stays exact because inputs are at most 2 000 000 bytes.
 const rank=new Int32Array(n),next=new Int32Array(n),prev=new Int32Array(n),pair=new Int32Array(n).fill(-1);let heap=new Float64Array(n),size=0;
 const merged=(left:number,right:number)=>{let row=v.pairs[left];if(!row)row=v.pairs[left]=new Map();let r=row.get(right);if(r===undefined){const a=v.texts[left],b=v.texts[right];r=a.length+b.length>v.maxBytes?-1:v.ranks.get(a+b)??-1;if(++v.cached>1<<20){v.pairs=[];v.cached=1;row=v.pairs[left]=new Map();}row.set(right,r);}return r};
 const push=(key:number)=>{if(size===heap.length){const grown=new Float64Array(2*size);grown.set(heap);heap=grown}let i=size++;while(i>0){const p=(i-1)>>1;if(heap[p]<=key)break;heap[i]=heap[p];i=p}heap[i]=key};
 const pop=()=>{const top=heap[0],last=heap[--size];let i=0;for(;;){let c=2*i+1;if(c>=size)break;if(c+1<size&&heap[c+1]<heap[c])c++;if(last<=heap[c])break;heap[i]=heap[c];i=c}heap[i]=last;return top};
 const link=(i:number)=>{pair[i]=next[i]<n?merged(rank[i],rank[next[i]]):-1;if(pair[i]>=0)push(pair[i]*2097152+i)};
 for(let i=0;i<n;i++){rank[i]=v.ranks.get(bytes[i])!;next[i]=i+1;prev[i]=i-1}
 for(let i=0;i<n-1;i++)link(i);
 let parts=n;
 while(size){const key=pop(),r=Math.floor(key/2097152),i=key-r*2097152;if(pair[i]!==r)continue;const j=next[i];rank[i]=r;pair[j]=-1;next[i]=next[j];if(next[j]<n)prev[next[j]]=i;parts--;link(i);if(prev[i]>=0)link(prev[i]);}
 return parts;
}
// Special-token strings such as <|endoftext|> are user text, not control tokens, so they are counted like any other text.
// A quote counts the same serialized input for estimation, the primary route and its fallback; the count depends only on the text.
export function countTokens(text:string,tokenizer:'o200k_base'|'cl100k_base'):number{
 const v=vocabulary(tokenizer);if(v.last?.text===text)return v.last.count;
 let total=0;for(const match of text.matchAll(new RegExp(v.pattern,'ug')))total+=pieceTokens(v,Buffer.from(match[0],'utf8').toString('latin1'));v.last={text,count:total};return total;
}
export function inputTokens(input:Record<string,unknown>,tokenizer:Tokenizer,mode:TokenInputMode):number{
 if(!['o200k_base','cl100k_base','utf8_upper_bound'].includes(tokenizer)||!['prompt','messages_json','compiled_messages_json','embedding_batch'].includes(mode))throw new DomainError('invalid_calculation','Unregistered tokenization operation',422);
 if(mode==='embedding_batch'){if(!Array.isArray(input.texts)||!input.texts.length||input.texts.length>128||input.texts.some(text=>typeof text!=='string'||Buffer.byteLength(text)>128000))throw new DomainError('invalid_embedding_batch');return input.texts.reduce((total:number,text:string)=>total+inputTokens({text},tokenizer,'prompt'),0);}
 if(mode==='prompt'&&['texts','messages','instructions','response_schema','tools','tool_choice'].some(key=>input[key]!==undefined))throw new DomainError('invalid_calculation','This input requires full-context token counting (messages_json)',422);
 if(mode==='compiled_messages_json'){const compiled=structuredTransport('generic',{...input,capability:'text.generate',model:'estimate',input:String(input.text??''),response_schema:input.response_schema?{name:'result',schema:input.response_schema as Record<string,unknown>}:undefined} as any,'estimate').input;return inputTokens({...input,tools:compiled.tools,response_schema:compiled.response_schema?.schema},tokenizer,'messages_json');}
 const source=mode==='messages_json'?JSON.stringify(input):typeof input.prompt==='string'?input.prompt:typeof input.text==='string'?input.text:'';
 if(Buffer.byteLength(source,'utf8')>2000000)throw new DomainError('invalid_calculation','Input exceeds calculation limit',422);
 if(tokenizer==='utf8_upper_bound')return Buffer.byteLength(source,'utf8');
 return countTokens(source,tokenizer);
}
