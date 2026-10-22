import {DomainError,canonical} from './src/index.js';
export type JsonSchema=Record<string,any>;
export const SCHEMA_LIMITS={bytes:65536,depth:16,nodes:2048,properties:256,variants:16,pattern:256};
const invalid=(message:string):never=>{throw new DomainError('invalid_input',message,422)};
const record=(v:unknown):v is JsonSchema=>!!v&&typeof v==='object'&&!Array.isArray(v);
const pointer=(path:string,key:string|number)=>`${path}/${String(key).replaceAll('~','~0').replaceAll('/','~1')}`;
const allowed=new Set(['type','properties','required','additionalProperties','items','enum','const','description','title','minimum','maximum','minItems','maxItems','minLength','maxLength','pattern','anyOf','oneOf','$ref','$defs']);
function reference(root:JsonSchema,ref:unknown):JsonSchema{
 if(typeof ref!=='string'||!/^#\/\$defs\/(?:[^~/]|~[01])+$/.test(ref))invalid('Only local #/$defs/name references are supported');
 const name=(ref as string).slice(8).replaceAll('~1','/').replaceAll('~0','~');
 if(!record(root.$defs)||!Object.hasOwn(root.$defs,name)||!record(root.$defs[name]))invalid('Unresolved local schema reference');
 return root.$defs[name];
}
function expand(schema:unknown):JsonSchema{
 let bytes:number;try{bytes=Buffer.byteLength(JSON.stringify(schema));}catch{return invalid('Invalid JSON schema');}
 if(bytes>SCHEMA_LIMITS.bytes||!record(schema))invalid('Schema size or shape exceeds limits');
 const root=schema as JsonSchema;let nodes=0,properties=0;
 function visit(node:unknown,depth:number,chain:Set<unknown>):JsonSchema{
  if(!record(node)||depth>SCHEMA_LIMITS.depth||++nodes>SCHEMA_LIMITS.nodes)invalid('Schema complexity exceeds limits');
  const s=node as JsonSchema;
  for(const key of Object.keys(s))if(!allowed.has(key))invalid(`Unsupported schema keyword ${key}`);
  if(s.$ref!==undefined){if(Object.keys(s).some(k=>!['$ref','description','title'].includes(k)))invalid('$ref siblings are not supported');if(chain.has(s.$ref))invalid('Recursive schema references are not supported');return visit(reference(root,s.$ref),depth+1,new Set([...chain,s.$ref]));}
  for(const key of ['description','title'])if(s[key]!==undefined&&typeof s[key]!=='string')invalid('Schema annotation must be text');
  const types=s.type===undefined?[]:Array.isArray(s.type)?s.type:[s.type];
  if(types.some((t:unknown)=>!['object','array','string','number','integer','boolean','null'].includes(t as string))||new Set(types).size!==types.length||s.type!==undefined&&!types.length)invalid('Unsupported schema type');
  if(!types.length&&!s.anyOf&&!s.oneOf&&!Object.hasOwn(s,'const')&&!s.enum)invalid('Schema needs type, variants or constant');
  if(s.anyOf&&s.oneOf)invalid('Use one variant keyword per schema');
  if((s.anyOf||s.oneOf)&&Object.keys(s).some(k=>!['anyOf','oneOf','$defs','description','title'].includes(k)))invalid('Variant schemas cannot have assertion siblings');
  if(s.enum!==undefined&&(!Array.isArray(s.enum)||!s.enum.length||s.enum.length>256))invalid('Invalid enum');
  if([...(s.enum??[]),...(Object.hasOwn(s,'const')?[s.const]:[])].some(v=>v!==null&&typeof v==='object'))invalid('Only scalar enum and const values are supported');
  if(s.enum!==undefined&&(!Array.isArray(s.enum)||!s.enum.length||s.enum.length>256))invalid('Invalid enum');
  for(const key of ['minimum','maximum'])if(s[key]!==undefined&&(typeof s[key]!=='number'||!Number.isFinite(s[key])))invalid('Invalid numeric bound');
  for(const key of ['minItems','maxItems','minLength','maxLength'])if(s[key]!==undefined&&(!Number.isSafeInteger(s[key])||s[key]<0||s[key]>1000000))invalid('Invalid schema bound');
  for(const [min,max] of [['minimum','maximum'],['minItems','maxItems'],['minLength','maxLength']])if(s[min]!==undefined&&s[max]!==undefined&&s[min]>s[max])invalid('Contradictory schema bounds');
  if(s.pattern!==undefined){
   // Bounded, ordinary regular expressions. No backreferences, lookaround, groups, alternation or repeated quantifiers.
   if(typeof s.pattern!=='string'||s.pattern.length>SCHEMA_LIMITS.pattern||/[()|]|\\[1-9]|[+*?}]\s*[+*?{]/.test(s.pattern))invalid('Unsupported pattern complexity');
   const atoms=s.pattern.replace(/\\./g,'x').replace(/\[[^\]]*\]/g,'x');
   const repeats=atoms.match(/[+*?]|\{[0-9]+(?:,[0-9]*)?\}/g)??[];
   if(repeats.length>1||repeats.length&&(!s.pattern.startsWith('^')||!s.pattern.endsWith('$')))invalid('Patterns allow one repeated atom in an anchored expression');
   if(repeats.some((r:string)=>/\d/.test(r)&&r.match(/\d+/g)!.some(n=>Number(n)>10000)))invalid('Pattern repeat exceeds limit');
   try{new RegExp(s.pattern,'u')}catch{invalid('Invalid pattern')}
  }
  const out:JsonSchema={...s};delete out.$defs;
  for(const key of ['anyOf','oneOf'])if(s[key]!==undefined){if(!Array.isArray(s[key])||s[key].length<1||s[key].length>SCHEMA_LIMITS.variants)invalid('Invalid schema variants');out[key]=s[key].map((v:unknown)=>visit(v,depth+1,chain));}
  if(s.properties!==undefined&&!types.includes('object')||s.items!==undefined&&!types.includes('array'))invalid('Keyword requires matching type');
  if(types.includes('object')){
   if(s.properties!==undefined&&!record(s.properties))invalid('Invalid properties');
   properties+=Object.keys(s.properties??{}).length;if(properties>SCHEMA_LIMITS.properties)invalid('Too many schema properties');
   if(s.required!==undefined&&(!Array.isArray(s.required)||new Set(s.required).size!==s.required.length||s.required.some((k:unknown)=>typeof k!=='string'||!Object.hasOwn(s.properties??{},k))))invalid('Invalid required properties');
   if(s.additionalProperties!==undefined&&typeof s.additionalProperties!=='boolean')invalid('Unsupported additionalProperties');
   out.properties=Object.fromEntries(Object.entries(s.properties??{}).map(([k,v])=>[k,visit(v,depth+1,chain)]));
  }
  if(types.includes('array'))out.items=visit(s.items,depth+1,chain);
  return out;
 }
 const result=visit(root,0,new Set());
 if(root.$defs!==undefined){if(!record(root.$defs))invalid('Invalid definitions');for(const value of Object.values(root.$defs))visit(value,0,new Set());}
 return result;
}
export function checkSchema(schema:unknown):void{expand(schema);}
export function validateFieldPaths(schema:unknown,paths:string[]):void{
 const root=expand(schema);
 function descend(s:JsonSchema,parts:string[]):boolean{
  if(s.anyOf||s.oneOf)return (s.anyOf??s.oneOf).some((branch:JsonSchema)=>descend(branch,parts));
  const types=Array.isArray(s.type)?s.type:[s.type];
  if(!parts.length)return types.includes('string');
  return types.includes('object')&&Object.hasOwn(s.properties??{},parts[0])&&descend(s.properties[parts[0]],parts.slice(1));
 }
 for(const path of paths){if(!/^(?:\/(?:[^~/]|~[01])*)+$/.test(path)||path.includes('*')||!descend(root,path.slice(1).split('/').map(part=>part.replaceAll('~1','/').replaceAll('~0','~'))))invalid('Streaming supports only declared string properties outside arrays');}
}
function defect(path:string,reason:string):never{throw new DomainError('result_defect',`Invalid result at ${path||'/'}: ${reason}`,422,{path:path||'/',reason});}
function matches(value:unknown,s:JsonSchema){try{validate(value,s,'');return true}catch(error){if(error instanceof DomainError&&error.code==='result_defect')return false;throw error}}
function validate(value:unknown,s:JsonSchema,path:string):void{
 if(s.enum&&!s.enum.some((v:unknown)=>canonical(v)===canonical(value)))defect(path,'enum');
 if(Object.hasOwn(s,'const')&&canonical(s.const)!==canonical(value))defect(path,'const');
 if(s.anyOf&&!s.anyOf.some((v:JsonSchema)=>matches(value,v)))defect(path,'anyOf');
 if(s.oneOf&&s.oneOf.filter((v:JsonSchema)=>matches(value,v)).length!==1)defect(path,'oneOf');
 const types=s.type===undefined?[]:Array.isArray(s.type)?s.type:[s.type];
 const type=value===null?'null':Array.isArray(value)?'array':typeof value;
 if(types.length&&!types.includes(type)&&!(type==='number'&&Number.isInteger(value)&&types.includes('integer')))defect(path,'type');
 if(type==='object'){
  for(const key of s.required??[])if(!Object.hasOwn(value!,key))defect(pointer(path,key),'required');
  for(const [key,child] of Object.entries(value as JsonSchema)){if(Object.hasOwn(s.properties??{},key))validate(child,s.properties[key],pointer(path,key));else if(s.additionalProperties===false)defect(pointer(path,key),'additionalProperties');}
 }
 if(Array.isArray(value)){
  if(s.minItems!==undefined&&value.length<s.minItems)defect(path,'minItems');if(s.maxItems!==undefined&&value.length>s.maxItems)defect(path,'maxItems');
  if(s.items)value.forEach((child,i)=>validate(child,s.items,pointer(path,i)));
 }
 if(typeof value==='string'){
  if(s.minLength!==undefined&&Array.from(value).length<s.minLength)defect(path,'minLength');if(s.maxLength!==undefined&&Array.from(value).length>s.maxLength)defect(path,'maxLength');
  if(s.pattern!==undefined&&!new RegExp(s.pattern,'u').test(value))defect(path,'pattern');
 }
 if(typeof value==='number'){
  if(!Number.isFinite(value))defect(path,'finite');if(s.minimum!==undefined&&value<s.minimum)defect(path,'minimum');if(s.maximum!==undefined&&value>s.maximum)defect(path,'maximum');
 }
}
export function validateStructured(value:unknown,schema:JsonSchema):void{validate(value,expand(schema),'');}

/** A tagged envelope for optional values preserves absence even when explicit null is legal.
 * Bounds and oneOf exclusivity are enforced locally against the original schema. */
export function providerSchema(schema:JsonSchema):{schema:JsonSchema;restore:(value:unknown)=>unknown;transformed:boolean}{
 const source=expand(schema);
 function convert(s:JsonSchema):{wire:JsonSchema;decode:(v:any,path?:string)=>any}{
  if(s.type===undefined&&s.enum){const types=[...new Set(s.enum.map((v:unknown)=>v===null?'null':typeof v))];return convert({...s,type:types.length===1?types[0]:types});}
  if(Array.isArray(s.type)&&s.type.length>1){const variants=s.type.map((type:string)=>convert({...s,type,...(s.enum?{enum:s.enum.filter((v:unknown)=>(v===null?'null':typeof v)===type||type==='integer'&&Number.isInteger(v))}:{})}));return {wire:{anyOf:variants.map(v=>v.wire)},decode:(v,path='')=>{for(const variant of variants){if(matches(v,variant.wire))return variant.decode(v,path)}defect(path,s.oneOf?'oneOf':'anyOf');}};}
  const wire:JsonSchema={};for(const key of ['type','description','title','enum'])if(s[key]!==undefined)wire[key]=Array.isArray(s.type)&&key==='type'?s.type[0]:s[key];
  if(Object.hasOwn(s,'const')){wire.enum=[s.const];wire.type??=s.const===null?'null':Array.isArray(s.const)?'array':typeof s.const;}
  const branches=s.anyOf??s.oneOf;
  if(branches){const variants=branches.map((b:JsonSchema)=>({source:b,...convert(b)}));wire.anyOf=variants.map((v:{wire:JsonSchema})=>v.wire);return {wire,decode:(v,path='')=>{for(const variant of variants){if(matches(v,variant.wire)){try{const decoded=variant.decode(v,path);if(matches(decoded,variant.source))return decoded}catch(error){if(!(error instanceof DomainError))throw error}}}defect(path,s.oneOf?'oneOf':'anyOf');}};}
  if(wire.type==='object'){
   if(s.additionalProperties!==false)invalid('Provider structured objects require additionalProperties:false');
   const children=Object.entries(s.properties??{}).map(([key,child])=>({key,child:convert(child as JsonSchema),required:s.required?.includes(key)??false}));
   wire.properties=Object.fromEntries(children.map(({key,child,required})=>[key,required?child.wire:{anyOf:[{type:'object',properties:{present:{type:'boolean',enum:[false]}},required:['present'],additionalProperties:false},{type:'object',properties:{present:{type:'boolean',enum:[true]},value:child.wire},required:['present','value'],additionalProperties:false}]}]));
   wire.required=children.map(c=>c.key);wire.additionalProperties=false;
   return {wire,decode:(v,path='')=>{if(!record(v))defect(path,'provider_object');const out:JsonSchema={};for(const c of children){if(c.required)Object.defineProperty(out,c.key,{value:c.child.decode(v[c.key],pointer(path,c.key)),enumerable:true});else {const wrapped=v[c.key];if(wrapped.present===true)Object.defineProperty(out,c.key,{value:c.child.decode(wrapped.value,pointer(path,c.key)),enumerable:true});}}return out;}};
  }
  if(wire.type==='array'){const item=convert(s.items);wire.items=item.wire;return {wire,decode:(v,path='')=>v.map((child:any,i:number)=>item.decode(child,pointer(path,i)))};}
  return {wire,decode:v=>v};
 }
 const converted=convert(source),rootObject=converted.wire.type==='object'&&!converted.wire.anyOf;
 const wire=rootObject?converted.wire:{type:'object',properties:{value:converted.wire},required:['value'],additionalProperties:false};
 return {schema:wire,transformed:canonical(wire)!==canonical(schema),restore:value=>{validate(value,wire,'');const restored=converted.decode(rootObject?value:(value as any).value);validate(restored,source,'');return restored;}};
}
