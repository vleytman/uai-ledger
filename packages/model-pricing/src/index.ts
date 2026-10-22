import {inputTokens} from './tokenization.js';
import {DomainError,canonical,units} from '../../contracts/src/index.js';
import {rateUsage,validateRateCard,type RateCard,type RatingContext} from '../../pricing/src/index.js';
import {Rational,evaluateExpression,validateExpression,expressionUnit,type Expression} from './expression.js';
export {Rational,type Expression} from './expression.js';
export type ParameterSpec={type:'string'|'number'|'boolean';default?:string|number|boolean;values?:Array<string|number|boolean>;minimum?:number;maximum?:number;required?:boolean};
export type InputAsset={id:string;sha256:string;width:number;height:number;format:string};
export interface CalculationInput {input:Record<string,unknown>;parameters:Record<string,unknown>;assets:InputAsset[]}
interface BaseComponent {key:string;label:string;covers:string[];maximum:string;result:{kind:'quantity';dimension:string;unit:'tokens'|'images'|'seconds'|'characters'|'calls';conditions?:Record<string,string>}|{kind:'usd'}}
export type CalculationComponent=BaseComponent&(
 |{type:'tokens';direction:'input';tokenizer:'o200k_base'|'cl100k_base'|'utf8_upper_bound';input_mode:'prompt'|'messages_json'|'compiled_messages_json'|'embedding_batch';overhead:number;per_message:number;per_asset:number}
 |{type:'tokens';direction:'output';policy:'configured_expected'|'requested_maximum'|'estimated_parameter';expected?:number;limit_parameter:string}
 |{type:'per_unit';source:'constant'|'parameter'|'characters'|'assets';constant?:string;parameter?:string;character_mode?:'unicode'|'utf16';step:string;rounding:'ceil'|'floor'|'half_up'}
 |{type:'lookup';parameters:string[];rows:Array<{parameters:Record<string,string>;value:string}>;multiplier_parameter?:string}
 |{type:'formula';expression:Expression}
);
export interface ModelCalculation {
 version:1;source:string;verification:'documented'|'empirically_validated'|'approximate';verified_at:string;
 parameters:Record<string,ParameterSpec>;
 preparation:{mode?:'preserve'|'transform';auto_orient?:boolean;max_assets:number;max_edge:number;format:'png'|'jpeg'|'webp';fit?:'inside'|'contain';allowed_dimensions?:string[]};
 components:CalculationComponent[];
 /** Per-model policy. Decimal factors are stored independently from provider rates. */
 pricing:{safety_factor:string;markup_percent:string;rounding_units:string};
 samples:Array<{name:string;source?:string;input:CalculationInput;expected:Record<string,string>;tolerance?:Record<string,string>;expected_cost_usd?:string;cost_tolerance_usd?:string;expected_price_units?:string}>;
}
function fail(message:string):never{throw new DomainError('invalid_model_calculation',message,422)}
function decimalString(value:unknown){if(typeof value!=='string')fail('Decimal values must be strings');return Rational.from(value)}
const keyPattern=/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const integer=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
export function normalizeParameters(policy:ModelCalculation,parameters:Record<string,unknown>){
 const result:Record<string,unknown>={};
 for(const key of Object.keys(parameters))if(!Object.hasOwn(policy.parameters,key))fail(`Unknown parameter ${key}`);
 for(const [key,s]of Object.entries(policy.parameters)){
  const value=Object.hasOwn(parameters,key)?parameters[key]:s.default;
  if(value===undefined){if(s.required)fail(`Missing parameter ${key}`);continue}
  if(typeof value!==s.type||s.values&&!s.values.includes(value as never))fail(`Unsupported parameter ${key}`);
  if(typeof value==='number'&&(!Number.isFinite(value)||s.minimum!==undefined&&value<s.minimum||s.maximum!==undefined&&value>s.maximum))fail(`Parameter ${key} exceeds bounds`);
  result[key]=value;
 }
 return result;
}
export function validateModelCalculation(policy:ModelCalculation,checkSamples=true):void {
 if(!policy||policy.version!==1||typeof policy.source!=='string'||!policy.source.trim()||!['documented','empirically_validated','approximate'].includes(policy.verification)||!Number.isFinite(Date.parse(policy.verified_at)))fail('Calculation source, version and verification required');
 if(!policy.parameters||typeof policy.parameters!=='object'||Array.isArray(policy.parameters)||Object.keys(policy.parameters).length>64)fail('Invalid parameter schema');
 const numeric=new Set(['input.characters','input.asset_count']);const fieldUnits=new Map<string,string>();
 for(const [key,p]of Object.entries(policy.parameters)){
  if(!keyPattern.test(key)||!p||!['string','number','boolean'].includes(p.type))fail('Invalid parameter schema');
  if(p.values&&(!Array.isArray(p.values)||!p.values.length||p.values.length>1000||new Set(p.values.map(canonical)).size!==p.values.length||p.values.some(v=>typeof v!==p.type)))fail(`Invalid values for ${key}`);
  if(p.type==='number'){if(!Number.isFinite(p.minimum)||!Number.isFinite(p.maximum)||p.minimum!<0||p.maximum!<p.minimum!||p.maximum!>1e9)fail(`Numeric bounds required for ${key}`);numeric.add('parameters.'+key)}
  if(p.default!==undefined)normalizeParameters({...policy,parameters:{[key]:p}},{[key]:p.default});
 }
 const prep=policy.preparation;
 if(!prep||prep.mode!==undefined&&!['preserve','transform'].includes(prep.mode)||prep.auto_orient!==undefined&&typeof prep.auto_orient!=='boolean'||prep.auto_orient&&prep.mode!=='transform'||!integer(prep.max_assets,0,16)||!integer(prep.max_edge,16,4096)||!['png','jpeg','webp'].includes(prep.format)||prep.fit!==undefined&&!['inside','contain'].includes(prep.fit))fail('Invalid asset preparation');
 if(prep.allowed_dimensions&&(!Array.isArray(prep.allowed_dimensions)||!prep.allowed_dimensions.length||prep.allowed_dimensions.length>1000||prep.allowed_dimensions.some(s=>!/^\d+x\d+$/.test(s)||s.split('x').some(x=>Number(x)<1||Number(x)>prep.max_edge))))fail('Invalid prepared image dimensions');
 if(!policy.pricing)fail('Per-model pricing required');const safety=decimalString(policy.pricing.safety_factor),markup=decimalString(policy.pricing.markup_percent);
 if(safety.compare(Rational.from('1'))<0||safety.compare(Rational.from('100'))>0||markup.n<0n||markup.compare(Rational.from('10000'))>0||units(policy.pricing.rounding_units)<=0n)fail('Invalid safety factor, markup or rounding');
 if(!Array.isArray(policy.components)||!policy.components.length||policy.components.length>32)fail('Cost components required');
 const keys=new Set<string>(),covered=new Set<string>(),rated=new Set<string>();
 for(const c of policy.components){
  if(!c||!keyPattern.test(c.key)||keys.has(c.key)||!c.label?.trim()||!Array.isArray(c.covers)||!c.covers.length||c.covers.some(v=>typeof v!=='string'||!v||covered.has(v))||new Set(c.covers).size!==c.covers.length)fail('Duplicate component or overlapping cost coverage');
  c.covers.forEach(v=>covered.add(v));keys.add(c.key);
  if(decimalString(c.maximum).n<0n)fail('Invalid component maximum');
  if(!c.result||!['usd','quantity'].includes(c.result.kind))fail('Component result type required');
  if(c.result.kind==='quantity'&&c.result.unit!=='seconds')decimalString(c.maximum).integer();
  if(c.result.kind==='quantity'&&(!c.result.dimension||!['tokens','images','seconds','characters','calls'].includes(c.result.unit)))fail('Invalid quantity result');
  switch(c.type){
   case 'tokens':
    if(c.result.kind!=='quantity'||c.result.unit!=='tokens')fail('Token counter must return tokens');
    if(c.direction==='input'){if(!['o200k_base','cl100k_base','utf8_upper_bound'].includes(c.tokenizer)||!['prompt','messages_json','compiled_messages_json','embedding_batch'].includes(c.input_mode)||![c.overhead,c.per_message,c.per_asset].every(x=>integer(x,0,100000)))fail('Invalid token counter')}
    else if(c.direction==='output'){const spec=policy.parameters[c.limit_parameter];if(!['configured_expected','requested_maximum','estimated_parameter'].includes(c.policy)||!spec||spec.type!=='number'||!spec.required&&spec.default===undefined||c.policy==='configured_expected'&&!integer(c.expected,0,Number(c.maximum)))fail('Output policy and limit required');}
    else fail('Token direction required');break;
   case 'per_unit':
    if(!['constant','parameter','characters','assets'].includes(c.source)||!['ceil','floor','half_up'].includes(c.rounding)||decimalString(c.step).n<=0n)fail('Invalid unit counter');
    if(c.source==='constant')decimalString(c.constant!);
    if(c.source==='parameter'&&(!c.parameter||policy.parameters[c.parameter]?.type!=='number'))fail('Numeric quantity parameter required');
    if(c.source==='characters'&&!['unicode','utf16'].includes(c.character_mode!))fail('Character counting mode required');break;
   case 'lookup':{
    if(!Array.isArray(c.parameters)||new Set(c.parameters).size!==c.parameters.length||c.parameters.some(k=>!policy.parameters[k]?.values?.length||!policy.parameters[k].required&&policy.parameters[k].default===undefined)||!Array.isArray(c.rows)||!c.rows.length||c.rows.length>10000)fail('Invalid lookup table');
    const combinations=c.parameters.reduce((n,k)=>n*policy.parameters[k].values!.length,1),seen=new Set<string>();
    for(const row of c.rows){if(!row.parameters||Object.keys(row.parameters).length!==c.parameters.length||c.parameters.some(k=>!policy.parameters[k].values!.some(v=>String(v)===row.parameters[k])))fail('Invalid table coordinates');const key=canonical(row.parameters);if(seen.has(key))fail('Duplicate table row');seen.add(key);if(decimalString(row.value).n<0n)fail('Negative table value');const multiplier=c.multiplier_parameter?policy.parameters[c.multiplier_parameter]?.maximum:1;if(multiplier===undefined||decimalString(row.value).mul(Rational.from(multiplier)).compare(decimalString(c.maximum))>0)fail('Table value exceeds component maximum')}
    if(seen.size!==combinations)fail('Table must cover every allowed combination');
    if(c.multiplier_parameter&&policy.parameters[c.multiplier_parameter]?.type!=='number')fail('Invalid table multiplier');break;
   }
   case 'formula':{validateExpression(c.expression,numeric,undefined,false,{nodes:0},0,Object.fromEntries(Object.entries(policy.parameters).filter(([,p])=>p.values?.length).map(([k,p])=>[k,p.values!.map(String)])));const inferred=expressionUnit(c.expression,fieldUnits);if(inferred&&inferred!==(c.result.kind==='usd'?'usd':c.result.unit))fail('Formula result unit differs from its referenced quantities');break;}
   default:fail('Unknown calculation type');
  }
  numeric.add('components.'+c.key);fieldUnits.set('components.'+c.key,c.result.kind==='usd'?'usd':c.result.unit);
  if(c.result.kind==='quantity'){const ratedKey=canonical(c.result);if(rated.has(ratedKey))fail('Duplicate billable quantity coverage');rated.add(ratedKey);}
 }
 if(prep.max_assets>0&&!covered.has('image_input'))fail('Permitted references need image_input coverage');
 if(!Array.isArray(policy.samples)||checkSamples&&!policy.samples.length||policy.samples.length>100)fail('Calculation test cases required');
 if(checkSamples)for(const sample of policy.samples){
  if(!sample.name||!sample.expected||Object.keys(sample.expected).length!==policy.components.length||sample.source!==undefined&&(typeof sample.source!=='string'||!sample.source.trim()))fail('Invalid test case');
  if(sample.tolerance&&Object.entries(sample.tolerance).some(([key,value])=>!keys.has(key)||decimalString(value).n<0n))fail('Invalid sample tolerance');
  if(sample.expected_cost_usd!==undefined&&decimalString(sample.expected_cost_usd).n<0n||sample.cost_tolerance_usd!==undefined&&(sample.expected_cost_usd===undefined||decimalString(sample.cost_tolerance_usd).n<0n))fail('Invalid expected sample cost');
  if(sample.expected_price_units!==undefined)units(sample.expected_price_units);
  const actual=calculateQuantities(policy,sample.input);
  for(const row of actual){const delta=decimalString(row.value).sub(decimalString(sample.expected[row.key])),tolerance=Rational.from(sample.tolerance?.[row.key]??'0');if(delta.compare(tolerance)>0||delta.compare(tolerance.mul(Rational.from('-1')))<0)fail(`Test case ${sample.name}: ${row.key} does not match`)}
 }
}
export function calculateQuantities(policy:ModelCalculation,request:CalculationInput){
 const parameters=normalizeParameters(policy,request.parameters??{}),assets=request.assets??[];
 if(!Array.isArray(assets)||assets.length>policy.preparation.max_assets)fail('Too many references');
 for(const asset of assets)if(!asset.id||!asset.sha256||!integer(asset.width,1,policy.preparation.max_edge)||!integer(asset.height,1,policy.preparation.max_edge)||(policy.preparation.mode==='transform'?asset.format!==policy.preparation.format:!['jpeg','png','webp'].includes(asset.format))||policy.preparation.allowed_dimensions&&!policy.preparation.allowed_dimensions.includes(`${asset.width}x${asset.height}`))fail('Reference does not match preparation policy');
 const input=request.input??{},text=typeof input.prompt==='string'?input.prompt:typeof input.text==='string'?input.text:'';
 if(Buffer.byteLength(JSON.stringify(input),'utf8')>2000000)fail('Input exceeds calculation limit');
 const fields:Record<string,string|number>={'input.characters':[...text].length,'input.asset_count':assets.length};
 for(const [k,v]of Object.entries(parameters))if(typeof v==='number')fields['parameters.'+k]=v;
 return policy.components.map(c=>{
  let value:Rational;
  switch(c.type){
   case 'tokens':
    if(c.direction==='input'){value=Rational.from(inputTokens(input,c.tokenizer,c.input_mode)+c.overhead+c.per_asset*assets.length+c.per_message*(Array.isArray(input.messages)?input.messages.length:0));}
    else{const max=Rational.from(parameters[c.limit_parameter] as number);value=c.policy!=='configured_expected'?max:Rational.from(c.expected!);if(value.compare(max)>0)value=max;}break;
   case 'per_unit':{const quantity=c.source==='constant'?c.constant!:c.source==='parameter'?parameters[c.parameter!] as number:c.source==='assets'?assets.length:c.character_mode==='utf16'?text.length:[...text].length;value=Rational.from(quantity).round(decimalString(c.step),c.rounding);break}
   case 'lookup':{const key=canonical(Object.fromEntries(c.parameters.map(k=>[k,String(parameters[k])])));const row=c.rows.find(r=>canonical(r.parameters)===key);if(!row)fail('No price for these parameters');value=Rational.from(row!.value);if(c.multiplier_parameter)value=value.mul(Rational.from(parameters[c.multiplier_parameter] as number));break}
   case 'formula':value=evaluateExpression(c.expression,{fields,assets:assets.map(a=>({width:a.width,height:a.height})),input,parameters});break;
  }
  if(value.n<0n||value.compare(decimalString(c.maximum))>0)fail(`Quantity exceeds ${c.key} bounds`);
  if(c.result.kind==='quantity'&&c.result.unit!=='seconds')value.integer();
  const result=value.decimal();fields['components.'+c.key]=result;
  return {key:c.key,label:c.label,value:result,result:c.result};
 });
}
export function priceModel(policy:ModelCalculation,request:CalculationInput,card:RateCard,context:RatingContext,options:{checkSamples?:boolean}={}){
 validateModelCalculation(policy,options.checkSamples??true);
 if(card.currency!=='USD')fail('Provider rates must use USD');
 const quantities=calculateQuantities(policy,request);let total=Rational.from('0');
 const parameters=normalizeParameters(policy,request.parameters);const ratingContext={...context,conditions:{...Object.fromEntries(Object.entries(parameters).map(([k,v])=>[k,String(v)])),...context.conditions}};
 const components=quantities.map(row=>{
  let cost:Rational;
  if(row.result.kind==='usd')cost=decimalString(row.value);
  else {const rating=rateUsage({state:'known',items:[{dimension:row.result.dimension,unit:row.result.unit,quantity:row.value,conditions:row.result.conditions}]},card,ratingContext);if(rating.state!=='calculated')fail(rating.reason);cost=Rational.from(rating.exact_amount)}
  total=total.add(cost);return {...row,cost_usd:cost.decimal()};
 });
 const safety=decimalString(policy.pricing.safety_factor),markup=Rational.from('1').add(decimalString(policy.pricing.markup_percent).div(Rational.from('100')));
 const price=total.mul(safety).mul(markup).mul(Rational.from('1000000000')).round(Rational.from(policy.pricing.rounding_units),'ceil').integer();
 units(price.toString());
 return {components,provider_estimate_usd:total.decimal(),provider_estimate_units:total.mul(Rational.from('1000000000')).ceil().toString(),price_units:price.toString(),pricing:{...policy.pricing},verification:policy.verification};
}

/** Check every parameter combination that can select a provider rate, independently of sample prompts. */
export function validateModelRateCoverage(policy:ModelCalculation,card:RateCard,context:RatingContext){
 validateModelCalculation(policy);validateRateCard(card);
 for(const component of policy.components){
  if(component.result.kind==='usd')continue;
  const result=component.result;
  const applicable=card.rates.filter(r=>r.dimension===result.dimension&&r.unit===result.unit);
  const keys=[...new Set(applicable.flatMap(r=>Object.keys(r.conditions??{})))].filter(key=>key in policy.parameters&&result.conditions?.[key]===undefined&&context.conditions?.[key]===undefined);
  let variants:Record<string,string>[]=[{}];
  for(const key of keys){const spec=policy.parameters[key];const values=spec.values??(spec.type==='number'&&spec.minimum===spec.maximum?[spec.minimum!]:undefined);if(!values||!values.length||variants.length*values.length>10000)fail(`Rate selection requires finite values for ${key}`);variants=variants.flatMap(v=>values.map(value=>({...v,[key]:String(value)})));}
  for(const parameters of variants){const rated=rateUsage({state:'known',items:[{dimension:result.dimension,unit:result.unit,quantity:'1',conditions:result.conditions}]},card,{...context,conditions:{...parameters,...context.conditions}});if(rated.state!=='calculated')fail(`Provider rate coverage: ${rated.reason}`);}
 }
}

/** Publication checks expected money against the selected version of provider rates. */
export function validateModelPriceSamples(policy:ModelCalculation,card:RateCard,context:RatingContext){
 validateModelCalculation(policy);
 for(const sample of policy.samples){
  const price=priceModel(policy,sample.input,card,context,{checkSamples:false});
  if(sample.expected_cost_usd!==undefined){const delta=Rational.from(price.provider_estimate_usd).sub(decimalString(sample.expected_cost_usd)),tolerance=Rational.from(sample.cost_tolerance_usd??'0');if(delta.compare(tolerance)>0||delta.compare(tolerance.mul(Rational.from('-1')))<0)fail(`Test case ${sample.name}: provider cost does not match`);}
  if(sample.expected_price_units!==undefined&&price.price_units!==sample.expected_price_units)fail(`Test case ${sample.name}: final price does not match`);
 }
}
