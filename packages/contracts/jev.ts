export class JevValidationError extends Error {
 readonly code='invalid_jev_value'; readonly status=422;
 constructor(public details:{path:string;reason:string}){super(`${details.path}: ${details.reason}`);}
}
export const JEV_MODEL='jev-1.13.0';
export const JEV_OPERATION='typesafe.systemone';
/** Owner-selected profile exposure assumption, not a provider tokenizer guarantee. */
export const JEV_MAX_INPUT_TOKENS=32768;
export const JEV_LIMITS={bytes:131072,depth:12,nodes:8192,questions:32,options:255,key:128,string:32768,responseBytes:1048576,probabilityTolerance:0.001};
export type JsonValue=null|boolean|number|string|readonly JsonValue[]|{[key:string]:JsonValue};
export type JevContent=string|readonly JsonValue[]|{[key:string]:JsonValue};
export type JevQuestion={type:'noul';instructions:JevContent;criteria?:{true?:JevContent;false?:JevContent}}|{type:'choice';instructions:JevContent;criteria:Record<string,JevContent|null>}|{type:'score';instructions:JevContent;criteria:readonly JevContent[]};
export type JevQuestions=Record<string,JevQuestion>;
export type JevInput<Q extends JevQuestions=JevQuestions>={state:JevContent;questions:Q};
export type JevAnswer<Q extends JevQuestion>=Q extends {type:'choice';criteria:infer C}?{type:'choice';choice:keyof C & string;confidence:number;probabilities:Record<keyof C & string,number>}:Q extends {type:'score'}?{type:'score';score:number;confidence:number;probabilities:Record<string,number>;legend:Record<string,string>}:{type:'noul';noul:number};
export type JevResult<Q extends JevQuestions=JevQuestions>={model:string;answers:{[K in keyof Q]:JevAnswer<Q[K]>};usage?:{input_tokens:number;output_tokens?:number}};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const bad=(path:string,reason:string):never=>{throw new JevValidationError({path,reason});};
const pointer=(path:string,key:string)=>`${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`;
export function validateBoundedJson(value:unknown,path=''){
 let nodes=0;const seen=new Set<object>();
 function visit(v:unknown,p:string,depth:number){
  if(++nodes>JEV_LIMITS.nodes||depth>JEV_LIMITS.depth)bad(p,'JSON complexity exceeds limit');
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='number'){if(!Number.isFinite(v))bad(p,'Finite number required');return;}
  if(typeof v==='string'){if(v.length>JEV_LIMITS.string)bad(p,'String exceeds limit');return;}
  if(!v||typeof v!=='object'||seen.has(v))bad(p,'JSON value required');
  if(Array.isArray(v)&&(Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i))))bad(p,'Dense JSON array required');
  if(Object.getOwnPropertySymbols(v as object).length)bad(p,'JSON keys must be strings');
  seen.add(v as object);
  if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)bad(p,'Plain JSON object required');
  for(const [k,child] of Object.entries(v as object)){if(k.length>JEV_LIMITS.key||['__proto__','prototype','constructor'].includes(k))bad(p,'Invalid JSON key');visit(child,pointer(p,k),depth+1);}
  seen.delete(v as object);
 }
 visit(value,path,0);
 if(new TextEncoder().encode(JSON.stringify(value)).length>JEV_LIMITS.bytes)bad(path,'JSON byte limit exceeded');
}
function content(v:unknown,p:string){if(typeof v!=='string'&&!Array.isArray(v)&&!object(v))bad(p,'String, object or array required');if(typeof v==='string'?!v.trim():Object.keys(v as object).length===0)bad(p,'Content is empty');}
function keys(v:Record<string,unknown>,allowed:string[],p:string){if(Object.keys(v).some(k=>!allowed.includes(k)))bad(p,'Unexpected field');}
export function validateJevInput(value:unknown):asserts value is JevInput{
 validateBoundedJson(value);if(!object(value))bad('','Object required');const v=value as Record<string,any>;keys(v,['state','questions'],'');content(v.state,'/state');
 if(!object(v.questions)||!Object.keys(v.questions).length||Object.keys(v.questions).length>JEV_LIMITS.questions)bad('/questions','Expected 1–32 questions');
 for(const [key,q] of Object.entries(v.questions) as [string,any][]){const p=pointer('/questions',key);if(!key.trim()||!object(q))bad('/questions','Invalid question');keys(q,['type','instructions','criteria'],p);content(q.instructions,`${p}/instructions`);
  if(q.type==='choice'){if(!object(q.criteria)||!Object.keys(q.criteria).length||Object.keys(q.criteria).length>255)bad(p,'Expected 1–255 choices');for(const [k,c] of Object.entries(q.criteria)){if(!k.trim())bad(p,'Empty choice key');if(c!==null)content(c,`${p}/criteria`);}}
  else if(q.type==='score'){if(!Array.isArray(q.criteria)||q.criteria.length<2||q.criteria.length>10)bad(p,'Expected 2–10 score levels');q.criteria.forEach((c:unknown)=>content(c,`${p}/criteria`));}
  else if(q.type==='noul'){if(q.criteria!==undefined){if(!object(q.criteria))bad(p,'Criteria object required');keys(q.criteria,['true','false'],p);Object.values(q.criteria).forEach(c=>content(c,`${p}/criteria`));}}
  else bad(`${p}/type`,'Unsupported question type');
 }
}
export function validateJevResult<Q extends JevQuestions>(value:unknown,questions:Q):JevResult<Q>{
 if(!object(value)||typeof value.model!=='string'||!value.model.length||value.model.length>128||!object(value.answers))bad('','Model and answers required');const v=value as Record<string,any>;
 const same=(actual:unknown,expected:string[],p:string)=>{if(!object(actual)||Object.keys(actual).length!==expected.length||expected.some(k=>!Object.hasOwn(actual,k)))bad(p,'Keys do not match the question');};
 const probability=(n:unknown,p:string)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)bad(p,'Probability must be finite and within 0–1');};
 same(v.answers,Object.keys(questions),'/answers');
 for(const [k,q] of Object.entries(questions)){const a=v.answers[k],p=pointer('/answers',k);if(!object(a)||a.type!==q.type)bad(p,'Answer type mismatch');
  if(q.type==='noul'){keys(a,['type','noul'],p);probability(a.noul,`${p}/noul`);continue;}
  keys(a,q.type==='choice'?['type','choice','confidence','probabilities']:['type','score','confidence','probabilities','legend'],p);
  const expected=q.type==='choice'?Object.keys(q.criteria):q.criteria.map((_,i)=>String(i));same(a.probabilities,expected,`${p}/probabilities`);probability(a.confidence,`${p}/confidence`);
  let sum=0;for(const n of Object.values(a.probabilities)){probability(n,`${p}/probabilities`);sum+=n as number;}if(Math.abs(sum-1)>JEV_LIMITS.probabilityTolerance)bad(p,'Probabilities must sum to one');
  if(q.type==='choice'){if(typeof a.choice!=='string'||!expected.includes(a.choice)||expected.some(key=>a.probabilities[key]>a.probabilities[a.choice]+JEV_LIMITS.probabilityTolerance))bad(p,'Choice must be a highest probability option');}
  else {same(a.legend,expected,`${p}/legend`);if(Object.values(a.legend).some(s=>typeof s!=='string'||s.length>JEV_LIMITS.string)||q.criteria.some((c,i)=>typeof c==='string'&&a.legend[String(i)]!==c))bad(p,'Invalid legend');if(typeof a.score!=='number'||!Number.isFinite(a.score)||a.score<0||a.score>expected.length-1||Math.abs(a.score-expected.reduce((n,key)=>n+Number(key)*a.probabilities[key],0))>JEV_LIMITS.probabilityTolerance*expected.length)bad(p,'Score does not match the scale distribution');}
 }
 const u=v.usage;const usage=u&&Number.isSafeInteger(u.input_tokens)&&u.input_tokens>=0&&(u.output_tokens===undefined||Number.isSafeInteger(u.output_tokens)&&u.output_tokens>=0)?{input_tokens:u.input_tokens,...(u.output_tokens!==undefined?{output_tokens:u.output_tokens}:{})}:undefined;
 return {model:v.model,answers:v.answers,...(usage?{usage}:{})} as JevResult<Q>;
}
