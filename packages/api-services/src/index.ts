import {validateBoundedJson,validateJevInput,JEV_OPERATION} from '../../contracts/jev.js';
import {z} from 'zod';
import {DomainError,units} from '../../contracts/src/index.js';
import {paidApiSchemas,type ServiceOperation} from '../../contracts/paid-api.js';
import {validateExpression,evaluateExpression,Rational,type Expression} from '../../model-pricing/src/expression.js';
import {rateMaximum,type RateCard,type RatingContext} from '../../pricing/src/index.js';
import type {NormalizedUsage} from '../../providers/src/contracts.js';
export type {ServiceOperation};
export interface VerifiedFiles {count:number;bytes:string}
const fail=(message:string):never=>{throw new DomainError('invalid_api_operation',message,422)};
/** Deliberately bounded JSON Schema subset; unsupported keywords never silently disappear. */
const keywords=new Set(['type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','pattern','format','minimum','maximum','enum','description','title','anyOf','const','minProperties','maxProperties','x-uai-bounded-json']);
export function validateOperationSchema(schema:Record<string,any>,input=false,depth=0){
 if(depth>10||!schema||typeof schema!=='object'||Array.isArray(schema))fail('Invalid JSON Schema');
 if(depth===0&&Buffer.byteLength(JSON.stringify(schema))>65536)fail('Schema exceeds byte limit');
 for(const key of Object.keys(schema))if(!keywords.has(key))fail(`Unsupported JSON Schema keyword ${key}`);
 if(schema['x-uai-bounded-json']!==undefined){if(schema['x-uai-bounded-json']!==true||Object.keys(schema).length!==1)fail('Invalid bounded JSON schema');return;}
 if(schema.anyOf!==undefined){if(Object.keys(schema).some(k=>k!=='anyOf')||!Array.isArray(schema.anyOf)||!schema.anyOf.length||schema.anyOf.length>8)fail('Invalid union');for(const branch of schema.anyOf)validateOperationSchema(branch,input,depth+1);return;}
 if(!['object','array','string','number','integer','boolean','null'].includes(schema.type))fail('Explicit JSON Schema type required');
 if(schema.type==='object'){
  if(input&&schema.additionalProperties!==false&&!(schema.additionalProperties&&typeof schema.additionalProperties==='object'&&Number.isSafeInteger(schema.maxProperties)&&schema.maxProperties<=255&&schema.maxProperties>0))fail('Input objects require additionalProperties=false');
  if(schema.additionalProperties!==undefined&&typeof schema.additionalProperties!=='boolean')validateOperationSchema(schema.additionalProperties,input,depth+1);
  for(const key of ['minProperties','maxProperties'])if(schema[key]!==undefined&&(!Number.isSafeInteger(schema[key])||schema[key]<0||schema[key]>255))fail('Invalid property bounds');
  if(schema.minProperties>schema.maxProperties)fail('Contradictory property bounds');
  for(const child of Object.values(schema.properties??{}))validateOperationSchema(child as any,input,depth+1);
 }else if(schema.type==='array'){
  if(input&&(!Number.isSafeInteger(schema.maxItems)||schema.maxItems<0||schema.maxItems>100))fail('Input arrays require maxItems <= 100');validateOperationSchema(schema.items,input,depth+1);
 }else if(schema.type==='string'&&input&&(!Number.isSafeInteger(schema.maxLength)||schema.maxLength<0||schema.maxLength>100000))fail('Input strings require maxLength <= 100000');
 else if(['integer','number'].includes(schema.type)&&input&&(!Number.isFinite(schema.minimum)||!Number.isFinite(schema.maximum)||schema.minimum<0||schema.maximum>1e9||schema.minimum>schema.maximum))fail('Numeric input requires nonnegative bounds');
 try{operationValidator(schema);}catch{fail('Unsupported JSON Schema');}
}
export function validateApiInput(operation:ServiceOperation,input:Record<string,unknown>,parameters:Record<string,unknown>={}){
 if(Object.keys(parameters).length)fail('API parameters belong to the published input schema');
 if(Buffer.byteLength(JSON.stringify(input))>2000000)fail('Input too large');
 const {asset_ids,...data}=input;
 if(asset_ids!==undefined&&(!Array.isArray(asset_ids)||asset_ids.some(id=>typeof id!=='string')||new Set(asset_ids).size!==asset_ids.length||asset_ids.length>operation.files.max_count))fail('Invalid API asset references');
 if(operation.key===JEV_OPERATION){try{validateJevInput(data);}catch(error){const e=error as {details?:Record<string,unknown>};throw new DomainError('invalid_input','Invalid Jev input',422,e.details??{});}}
 try{operationValidator(operation.input_schema as any).parse(data);}catch{fail('API input does not match the operation schema');}
 return data;
}
function fields(operation:ServiceOperation,input:Record<string,unknown>,files:VerifiedFiles){
 const result:Record<string,string|number>={'assets.count':files.count,'assets.bytes':files.bytes};
 for(const [key,schema] of Object.entries((operation.input_schema as any).properties??{}))if(['number','integer'].includes((schema as any).type)&&input[key]!==undefined)result[`input.${key}`]=input[key] as number;
 return result;
}
export function apiMeasurements(operation:ServiceOperation,input:Record<string,unknown>,files:VerifiedFiles,usage?:NormalizedUsage){
 const context=fields(operation,input,files),values:Record<string,string>={};
 for(const metric of operation.measurements){
  let value:Rational;
  if(metric.source==='provider_usage'){
   if(!usage)value=Rational.from(metric.maximum);
   else if(usage.state==='unknown')return null;
   else {const matching=usage.items.filter(i=>i.dimension===metric.key&&i.unit===metric.unit);if(!matching.length)return null;value=matching.reduce((n,i)=>n.add(Rational.from(i.quantity)),Rational.from('0'));}
  }else value=evaluateExpression(metric.expression as Expression,{fields:context,assets:[]});
  if(value.n<0n)fail('Negative measurement');
  if(!usage&&value.compare(Rational.from(metric.maximum))>0)fail(`Measurement ${metric.key} exceeds maximum`);
  values[metric.key]=value.decimal();context[`measurements.${metric.key}`]=value.decimal();
 }
 return values;
}
export function apiItems(operation:ServiceOperation,measurements:Record<string,string>){return operation.measurements.map(m=>({dimension:m.key,unit:m.unit,quantity:measurements[m.key]}));}
export function priceApi(operation:ServiceOperation,measurements:Record<string,string>,card:RateCard,context:RatingContext,providerCostUnits?:string){
 const policy=operation.pricing;let total:Rational;
 if(policy.mode==='independent')total=evaluateExpression(policy.expression as Expression,{fields:Object.fromEntries(Object.entries(measurements).map(([key,value])=>[`measurements.${key}`,value])),assets:[]});
 else {
  const rated=rateMaximum({state:'known',items:apiItems(operation,measurements)},card,context);if(rated.state!=='calculated')throw new DomainError('pricing_unavailable',rated.reason,422);
  total=Rational.from(providerCostUnits??rated.rounded_units.toString()).mul(Rational.from(policy.safety_factor)).mul(Rational.from('1').add(Rational.from(policy.markup_percent).div(Rational.from('100'))));
 }
 if(total.n<0n)fail('Negative customer price');
 return units(total.round(Rational.from(policy.rounding_units),'ceil').integer().toString()).toString();
}
export function validateServiceOperation(value:unknown):ServiceOperation {
 const operation=paidApiSchemas.ServiceOperation.parse(value);validateOperationSchema(operation.input_schema,true);validateOperationSchema(operation.output_schema);
 if(operation.files.max_count>16||units(operation.files.max_total_bytes)>20000000n||units(operation.files.max_file_bytes)>units(operation.files.max_total_bytes))fail('File bounds exceed storage limits');
 if(units(operation.pricing.rounding_units)===0n||units(operation.pricing.max_units)===0n)fail('Positive price bounds required');
 if(operation.pricing.mode==='cost_plus'&&(Rational.from(operation.pricing.safety_factor).compare(Rational.from('1'))<0||Rational.from(operation.pricing.safety_factor).compare(Rational.from('100'))>0||Rational.from(operation.pricing.markup_percent).compare(Rational.from('10000'))>0))fail('Invalid markup or safety factor');
 const keys=new Set<string>(),numeric=new Set(['assets.count','assets.bytes']);
 for(const [key,schema] of Object.entries((operation.input_schema as any).properties??{}))if(['number','integer'].includes((schema as any).type))numeric.add(`input.${key}`);
 for(const metric of operation.measurements){
  if(keys.has(metric.key))fail('Duplicate measurement');keys.add(metric.key);
  if(metric.source==='provider_usage'){if(metric.expression)fail('Provider usage cannot execute a request expression');}
  else {if(!metric.expression)fail('Request and asset measurements need an expression');validateExpression(metric.expression as Expression,numeric);}
  numeric.add(`measurements.${metric.key}`);
 }
 if(operation.pricing.mode==='independent')validateExpression(operation.pricing.expression as Expression,new Set([...keys].map(k=>`measurements.${k}`)));
 for(const sample of operation.samples){validateApiInput(operation,sample.input);if(sample.assets.count>operation.files.max_count||BigInt(sample.assets.bytes)>BigInt(operation.files.max_total_bytes))fail('Sample files exceed limits');
  const measured=apiMeasurements(operation,sample.input,sample.assets);for(const metric of operation.measurements)if(metric.source!=='provider_usage'&&measured?.[metric.key]!==sample.measurements[metric.key])fail(`Sample ${sample.name} measurement mismatch`);
 }
 return operation;
}
export function validateApiSamples(operation:ServiceOperation,card:RateCard,context:RatingContext){
 for(const sample of operation.samples){const price=priceApi(operation,sample.measurements,card,context);if(price!==sample.expected_price_units||BigInt(price)>BigInt(operation.pricing.max_units))fail(`Sample ${sample.name} price mismatch`);}
}
export function validateApiOutput(operation:ServiceOperation,text:string){
 try{operationValidator(operation.output_schema as any).parse(JSON.parse(text));}catch{throw new DomainError('result_defect','API response does not match the operation schema');}
}
/** Request/file measurements are immutable after quote; only provider counters can change. */
export function settleApiMeasurements(operation:ServiceOperation,quoted:Record<string,string>,usage:NormalizedUsage){
 const actual={...quoted};for(const metric of operation.measurements){if(metric.source!=='provider_usage')continue;if(usage.state==='unknown')return null;const items=usage.items.filter(i=>i.dimension===metric.key&&i.unit===metric.unit);if(!items.length)return null;actual[metric.key]=items.reduce((sum,i)=>sum.add(Rational.from(i.quantity)),Rational.from('0')).decimal();}return actual;
}

/** Compile extensions explicitly; unknown keywords remain rejected by publication validation. */
function customSchema(schema:Record<string,any>):boolean {
 return schema['x-uai-bounded-json']===true||schema.minProperties!==undefined||schema.maxProperties!==undefined||typeof schema.additionalProperties==='object'||Object.values(schema.properties??{}).some(v=>customSchema(v as any))||!!schema.items&&customSchema(schema.items)||(schema.anyOf??[]).some((v:any)=>customSchema(v));
}
function operationValidator(schema:Record<string,any>):z.ZodType {
 if(!customSchema(schema))return z.fromJSONSchema(schema);
 if(schema['x-uai-bounded-json']===true)return z.unknown().superRefine((v,ctx)=>{try{validateBoundedJson(v);}catch{ctx.addIssue({code:'custom',message:'Bounded JSON required'});}});
 if(schema.anyOf)return z.union(schema.anyOf.map((s:Record<string,any>)=>operationValidator(s)) as [z.ZodType,z.ZodType,...z.ZodType[]]);
 if(schema.type==='object'){
  if(schema.enum!==undefined||schema.const!==undefined)fail('Object constants with bounded extensions are unsupported');
  if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some((key:unknown)=>typeof key!=='string'||!Object.hasOwn(schema.properties??{},key))))fail('Invalid required properties');
  const shape=Object.fromEntries(Object.entries(schema.properties??{}).map(([k,v])=>{const child=operationValidator(v as any);return [k,(schema.required??[]).includes(k)?child:child.optional()];}));
  let result=z.object(shape);if(schema.additionalProperties===false)result=result.strict();else if(typeof schema.additionalProperties==='object')result=result.catchall(operationValidator(schema.additionalProperties));else result=result.passthrough();
  return result.superRefine((v,ctx)=>{const n=Object.keys(v).length;if(schema.minProperties!==undefined&&n<schema.minProperties||schema.maxProperties!==undefined&&n>schema.maxProperties)ctx.addIssue({code:'custom',message:'Property count out of bounds'});});
 }
 if(schema.type==='array'){if(schema.enum!==undefined||schema.const!==undefined)fail('Array constants with bounded extensions are unsupported');let result=z.array(operationValidator(schema.items));if(schema.minItems!==undefined)result=result.min(schema.minItems);if(schema.maxItems!==undefined)result=result.max(schema.maxItems);return result;}
 return z.fromJSONSchema(schema);
}
