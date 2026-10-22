import {adapterDefinition} from '../../providers/src/registry.js';
import {isAlternativeProvider,validateAlternative} from '../../providers/src/alternative-models.js';
import {validateSvgAssets} from '../../providers/src/svg-input.js';
import {priorityValue,type InvocationPriority} from '../../execution/src/priority.js';
import {validateEmbeddingInput,embeddingModel} from '../../providers/src/embeddings.js';
import {cacheIdentity,cacheForecast} from './cache.js';
import {DeliveryPolicy} from '../../contracts/invocation.js';
import {validateTextFeatures,validateTextInput,validateProviderText} from '../../providers/src/text-input.js';
import type {ProviderInput} from '../../providers/src/contracts.js';
import {checkSchema,validateFieldPaths} from '../../contracts/schema.js';
import {resolveExecutionPolicy,resolveBillingPolicy,type ExecutionOverrides} from '../../contracts/invocation.js';
import {executionLimits,defaultExecutionPolicy} from '../../execution/src/policy.js';
import {validateApiInput,apiMeasurements,apiItems,priceApi,type ServiceOperation,type VerifiedFiles} from '../../api-services/src/index.js';
import {prepareApiFiles,fileMetrics,type PreparedApiFile} from '../../api-services/src/files.js';
import {AllowanceService} from '../../allowance/src/index.js';
import {quoteAllowance,releaseUnsentAllowance} from '../../allowance/src/execution.js';
import {assertDatabaseManaged,activeFileReleases,type FileSource} from '../../configuration/src/ownership.js';
import {lockExecutionAccount,forAvailableExecutionAccounts} from '../../db/src/execution-lock.js';
import {checkAdmissionBackpressure} from './backpressure.js';
import {priceModel,normalizeParameters,type InputAsset,type ModelCalculation} from '../../model-pricing/src/index.js';
import {prepareModelAssets,type PreparedAsset} from './prepare-model-assets.js';
import {fixedPrice,validateFixedPricing,parameterBounds,type FixedPricing} from './fixed-pricing.js';
import {estimateItems,validateEstimation,type EstimationPolicy} from './estimation.js';
import { DomainError, CREDIT_UNIT, hash, id, units, type Clock, type Scope } from '../../contracts/src/index.js';
import { afterRollback, emit, type Tx } from '../../db/src/index.js';
import * as accounting from '../../accounting/src/index.js';
import * as execution from '../../execution/src/index.js';
import * as storage from '../../storage/src/index.js';
import { CatalogService, type RouteDefinition, type CatalogDefinition } from '../../catalog/src/index.js';
import { rateMaximum, type RateCard } from '../../pricing/src/index.js';
import type { BillableItem, Capability, UsageConditions } from '../../providers/src/contracts.js';

export type CountExpression={constant:number}|{input:string}|{sum:CountExpression[]}|{product:CountExpression[]};
export type ParameterValue=string|number|boolean|null|ParameterValue[]|{[key:string]:ParameterValue};
export interface ComponentLimits {
 input_tokens?:number;output_tokens?:number;input_characters?:number;image_count?:number;
 image_sizes?:string[];image_qualities?:string[];max_assets?:number;image_input_tokens_per_asset?:number;
 parameter_values?:Record<string,ParameterValue[]>;
}
export interface RecipeComponent {key:string;capability:Capability;route_version_id:string;rate_card_version_id:string;count:CountExpression;limits:ComponentLimits;billing?:FixedPricing;pricing_mode?:'quoted_final'|'estimated_actual'|'actual_capped';estimation?:EstimationPolicy;maximum_items?:BillableItem[];conditions?:UsageConditions;response_schema?:Record<string,unknown>}
export interface RecipeDefinition {execution?:ExecutionOverrides;billing?:{refused?:'platform'|'actual_usage'};key:string;version:number;inputs?:Record<string,{type:'integer';minimum:number;maximum:number}>;components:RecipeComponent[];partial_policy?:'successful_parts';settlement?:'actual_usage'|'fixed'|'mixed'|'quoted_final';deadline_seconds?:number;content_ttl_seconds?:number;period_budget_key:string;actor_id?:string}
export interface RequestPayload {kind:Capability;input:Record<string,unknown>;parameters?:Record<string,unknown>}
/** A reserve for composite work: single-call profiles with call limits. The reserve is the quote budget; each call is priced when it is made. */
export interface PoolDefinition {profiles:{profile:string;max_calls:number}[];max_calls?:number;deadline_seconds?:number}
interface PoolTerms {profiles:{profile:string;version:number;max_calls:number}[];max_calls:number}
export interface QuoteInput {priority?:InvocationPriority;delivery?:{stream?:boolean;field_paths?:string[]};execution?:ExecutionOverrides;billing?:{refused?:'platform'|'actual_usage'};idempotency_key:string;kind?:'single_call'|'recipe'|'pool';pool?:PoolDefinition;profile?:string;recipe?:{key:string;version:number};inputs?:Record<string,number>;input?:Record<string,unknown>;parameters?:Record<string,unknown>;capability?:Capability;budget?:{credit_unit_id?:string;max_units?:string;max_credits?:string};metadata?:{external_project_id?:string;project_generation?:string};operation_id?:string;wallet_id?:string}
interface QuotedComponent extends RecipeComponent {api_snapshot?:{definition:ServiceOperation;measurements:Record<string,string>;files:VerifiedFiles};allowance_reservations?:string[];count_resolved:number;max_units:string;estimated_units:string;route:execution.ExecutionRoute;route_deadline_seconds:number;execution_parameters?:Record<string,unknown>;calculation_snapshot?:{catalog_version_id:string;model:string;method:ModelCalculation;breakdown:ReturnType<typeof priceModel>}}
const sv=(s:Scope)=>[s.organization_id,s.application_id,s.account_id];
const scoped='organization_id=$1 AND application_id=$2 AND account_id=$3';
function invalid(message:string):never {throw new DomainError('invalid_input',message,422);}
async function lock(tx:Tx,scope:Scope) {await lockExecutionAccount(tx,scope);return accounting.ensureWallet(tx,scope);}
function integer(n:unknown,min=0,max=1_000_000):number {if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min||n>max)invalid('Integer outside allowed range');return n as number;}
export function evaluateCount(expression:CountExpression,inputs:Record<string,number>,depth=0):number {
 if(depth>8||!expression||typeof expression!=='object'||Object.keys(expression).length!==1)invalid('Invalid count expression');
 if('constant' in expression)return integer(expression.constant,0,256);
 if('input' in expression) {if(!Object.hasOwn(inputs,expression.input))invalid('Missing count input');return integer(inputs[expression.input],0,256);}
 const values='sum' in expression?expression.sum:expression.product;
 if(!Array.isArray(values)||!values.length||values.length>16)invalid('Invalid expression operands');
 const evaluated=values.map(e=>evaluateCount(e,inputs,depth+1));
 return integer('sum' in expression?evaluated.reduce((a,b)=>a+b,0):evaluated.reduce((a,b)=>a*b,1),0,256);
}
function recipeInputs(def:RecipeDefinition,values:Record<string,number>) {
 for(const key of Object.keys(values))if(!def.inputs?.[key])invalid(`Unknown recipe input ${key}`);
 for(const [key,schema] of Object.entries(def.inputs??{})) integer(values[key],schema.minimum,schema.maximum);
}
function validateRecipe(def:RecipeDefinition) {
 resolveExecutionPolicy(def.execution);resolveBillingPolicy(def.billing);
 if(!def.key?.trim()||!def.period_budget_key?.trim()||!Array.isArray(def.components)||!def.components.length||def.components.length>32)invalid('Recipe key, components and period budget are required');
 integer(def.version,1);if(def.partial_policy&&def.partial_policy!=='successful_parts')invalid('Only successful_parts supported');if(def.settlement&&!['actual_usage','fixed','mixed','quoted_final'].includes(def.settlement))invalid('Unsupported settlement');
 if(def.deadline_seconds!==undefined)integer(def.deadline_seconds,1,86400);if(def.content_ttl_seconds!==undefined)integer(def.content_ttl_seconds,1,3600);
 const upper:Record<string,number>={};for(const [key,schema] of Object.entries(def.inputs??{})){if(schema.type!=='integer')invalid('Only bounded integer inputs supported');integer(schema.minimum);integer(schema.maximum,schema.minimum);upper[key]=schema.maximum;}
 const keys=new Set<string>();for(const c of def.components){
  if(!c.key||keys.has(c.key))invalid('Duplicate component');keys.add(c.key);evaluateCount(c.count,upper);
  if(!c.route_version_id||!c.pricing_mode&&!c.rate_card_version_id)invalid('Published route and rate card required');
  if(c.capability==='api.call'){if(c.billing||c.estimation||c.pricing_mode==='estimated_actual')invalid('API uses its published operation pricing');continue;}
  if(c.pricing_mode==='quoted_final'||c.pricing_mode==='estimated_actual'||c.pricing_mode==='actual_capped'){if(c.billing||c.estimation)invalid('Model pricing cannot combine legacy billing or estimation');continue;}
  if(c.capability==='text.generate'){integer(c.limits.input_tokens,1,2_000_000);integer(c.limits.output_tokens,1,200_000);}
  else if(['image.generate','image.edit'].includes(c.capability)){if(c.limits.image_count!==1)invalid('One image per request required');if(!c.limits.image_sizes?.length||!c.limits.image_qualities?.length)invalid('Image size and quality bounds required');}
  else if(c.capability==='speech.synthesize')integer(c.limits.input_characters,1,100_000);
  else if(c.capability!=='search')invalid('Unsupported capability');
  if(c.limits.max_assets!==undefined)integer(c.limits.max_assets,0,16);
  if(c.pricing_mode&&!['quoted_final','estimated_actual'].includes(c.pricing_mode)||c.pricing_mode&&c.billing)invalid('Select either model pricing or legacy fixed table');
  if(c.estimation)validateEstimation(c.estimation);if(c.billing)validateFixedPricing(c.billing,parameterBounds(c.limits));
  if(c.maximum_items?.some(i=>!i.dimension||!i.unit||!/^\d+(\.\d+)?$/.test(i.quantity)))invalid('Invalid maximum billable item');
 }
}
async function published(tx:Tx,scope:Scope,id:string,kind:'route'|'rate_card'|'catalog'|'execution_policy') {
 const version=await new CatalogService(tx).get(scope,id);if(version.kind!==kind||version.status!=='published')throw new DomainError('pricing_unavailable','Configuration must be published',422);return version;
}
export async function publishRecipe(tx:Tx,scope:Scope,clock:Clock,def:RecipeDefinition,fileSource:FileSource|null=null) {
 if(!fileSource)await assertDatabaseManaged(tx,scope,'recipe',def.key);
 def=structuredClone(def);validateRecipe(def);
 const application=(await tx.query('SELECT id FROM applications WHERE id=$1 AND organization_id=$2',[scope.application_id,scope.organization_id])).rows[0];if(!application)throw new DomainError('not_found','Application not found',404);
 for(const component of def.components){
  const route=(await published(tx,scope,component.route_version_id,'route')).payload as RouteDefinition;if(route.capability!==component.capability)invalid('Recipe capability mismatches route');
  if(component.capability==='api.call'){
   if(def.components.length!==1||!('constant' in component.count)||component.count.constant!==1)invalid('API operation requires a single-call profile');
   const models=(await published(tx,scope,route.primary.catalog_version_id,'catalog')).payload as CatalogDefinition;const model=models.models.find(m=>m.id===route.primary.model&&m.status==='active');if(!model?.api||!model.rate_card_version_id)throw new DomainError('api_operation_required');
   component.rate_card_version_id=model.rate_card_version_id;component.pricing_mode=model.api.billing_mode;component.limits={max_assets:model.api.files.max_count};
  }else if(component.pricing_mode==='quoted_final'||component.pricing_mode==='estimated_actual'||component.pricing_mode==='actual_capped'){
   if(def.components.length!==1||!('constant' in component.count)||component.count.constant!==1)invalid('Model final pricing requires a single-call recipe');
   const models=(await published(tx,scope,route.primary.catalog_version_id,'catalog')).payload as CatalogDefinition;
   const model=models.models.find(m=>m.id===route.primary.model&&m.status==='active');if(!model?.calculation||!model.rate_card_version_id)throw new DomainError('model_calculation_missing');
   component.rate_card_version_id=model.rate_card_version_id;
   const method=model.calculation,params=method.parameters;
   const textUsage=component.capability==='text.generate'?adapterDefinition(model.adapter_ref??`${model.provider}@1`,model.provider).create({apiKey:'',models:[model.id]}).capabilities.text_usage:undefined;
   if(component.capability==='embeddings.generate'&&(embeddingModel(model.id).provider!==model.provider||method.preparation.max_assets!==0||!method.components.some(c=>c.type==='tokens'&&c.direction==='input'&&c.input_mode==='embedding_batch'&&c.tokenizer===embeddingModel(model.id).token_count)))invalid('Embeddings requires the registered batch model and batch token calculation');
   if(component.pricing_mode==='estimated_actual'&&component.capability!=='embeddings.generate'&&(component.capability!=='text.generate'||!textUsage?.estimated_actual||!params.expected_output_tokens||(textUsage?.output_limit==='required'&&!params.max_output_tokens)))invalid('Estimated actual requires published input/output counters, a forecast and the model output-limit policy');
   if(component.capability==='text.generate'&&component.pricing_mode!=='estimated_actual'&&(!params.max_output_tokens||params.max_output_tokens.type!=='number'))invalid('Text model needs an executable max_output_tokens parameter');
   component.limits={max_assets:method.preparation.max_assets,...(component.capability==='text.generate'?{output_tokens:params.max_output_tokens?.maximum,input_tokens:Math.max(1,...method.components.filter(c=>c.result.kind==='quantity'&&c.result.unit==='tokens'&&(c.covers.includes('text_input')||c.type==='tokens'&&c.direction==='input')).map(c=>Number(c.maximum)))}:{}),...(component.capability==='image.generate'?{image_count:1,image_sizes:params.size?.values?.map(String),image_qualities:params.quality?.values?.map(String)}:{}),...(component.capability==='speech.synthesize'?{input_characters:100000}:{}),parameter_values:Object.fromEntries(Object.entries(params).filter(([,p])=>p.values).map(([key,p])=>[key,p.values!]))};
  }
  await published(tx,scope,component.rate_card_version_id,'rate_card');
 }
 const recipeId=id('recipe');return (await tx.query('INSERT INTO recipe_versions(id,organization_id,application_id,key,version,definition,created_at,actor_id,file_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[recipeId,scope.organization_id,scope.application_id,def.key,def.version,{...def,partial_policy:'successful_parts',settlement:def.components.every(c=>c.pricing_mode==='quoted_final')?'quoted_final':def.components.every(c=>c.billing)?'fixed':def.components.some(c=>c.billing||c.pricing_mode==='quoted_final')?'mixed':'actual_usage'},clock.now(),def.actor_id??'system',fileSource])).rows[0];
}
export async function listRecipes(tx:Tx,scope:Scope,publicOnly=false) {
 const rows=(await tx.query('SELECT * FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 ORDER BY key,version DESC',[scope.organization_id,scope.application_id])).rows;
 const catalog=new CatalogService(tx);
 for(const row of rows)for(const component of row.definition.components as RecipeComponent[])if(component.pricing_mode==='quoted_final'||component.pricing_mode==='estimated_actual'||component.pricing_mode==='actual_capped'){
  const route=(await catalog.get(scope,component.route_version_id)).payload as RouteDefinition;
  const models=(await catalog.get(scope,route.primary.catalog_version_id)).payload as CatalogDefinition;
  const model=models.models.find(m=>m.id===route.primary.model);
  if(model?.api)Object.assign(component,{service_settings:{kind:'api',input_schema:model.api.input_schema,output_schema:model.api.output_schema,files:model.api.files}});
  if(model?.calculation)Object.assign(component,{model_settings:{id:model.id,provider:model.provider,preview:model.preview,live_validation:model.live_validation,text_features:model.text_features,service_mode:route.primary.service_mode,parameters:model.calculation.parameters,preparation:model.calculation.preparation}});
 }
 if(publicOnly){const active=await activeFileReleases(tx,scope);return rows.filter(r=>!r.file_source||active.has(r.file_source.release_id)).map(({file_source,...row})=>row);}
 const active=await activeFileReleases(tx,scope);
 return rows.map(row=>row.file_source?{...row,file_active:active.has(row.file_source.release_id)}:row);
}
async function getRecipe(tx:Tx,scope:Scope,input:QuoteInput) {
 const key=input.recipe?.key??input.profile;if(!key)invalid('Recipe or profile required');
 const row=(await tx.query('SELECT * FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3 AND (file_source IS NULL OR file_source->>\'release_id\' IN (SELECT release_id FROM configuration_activations WHERE organization_id=$1 AND application_id=$2)) AND ($4::integer IS NULL OR version=$4) ORDER BY version DESC LIMIT 1',[scope.organization_id,scope.application_id,key,input.recipe?.version??null])).rows[0];
 if(!row)throw new DomainError('not_found','Published recipe/profile not found',404);return row;
}
function defaultItems(c:RecipeComponent):BillableItem[] {
 if(c.maximum_items)return c.maximum_items;
 if(c.capability==='text.generate')return [{dimension:'input.uncached',unit:'tokens',quantity:String(c.limits.input_tokens)},{dimension:'output.text',unit:'tokens',quantity:String(c.limits.output_tokens)}];
 if(c.capability==='image.generate'||c.capability==='image.edit')return [{dimension:'output.image',unit:'images',quantity:'1'}];
 if(c.capability==='speech.synthesize')return [{dimension:'audio.characters',unit:'characters',quantity:String(c.limits.input_characters)}];
 return [{dimension:'tool.search',unit:'calls',quantity:'1'}];
}
async function quoteComponent(tx:Tx,scope:Scope,clock:Clock,c:RecipeComponent,values:Record<string,number>,periodKey:string,payload?:RequestPayload,preparedAssets:InputAsset[]=[],apiFiles:PreparedApiFile[]=[]):Promise<QuotedComponent> {
 const originalRoute=(await published(tx,scope,c.route_version_id,'route')).payload as RouteDefinition;
 const defaults=await defaultExecutionPolicy(tx,scope);
 const named=originalRoute.execution_policy_version_id?await published(tx,scope,originalRoute.execution_policy_version_id,'execution_policy'):undefined;
 const route={...originalRoute,execution:resolveExecutionPolicy(originalRoute.execution,undefined,await executionLimits(tx),named?.payload??defaults.policy)};
 const policyVersion=named?.id??defaults.id;
 let card=(await published(tx,scope,c.rate_card_version_id,'rate_card')).payload as RateCard;
 let calculationSnapshot:QuotedComponent['calculation_snapshot'];let executionParameters:Record<string,unknown>|undefined;
 if(c.capability==='api.call'){
  if(!payload)throw new DomainError('single_call_required');
  const variants:execution.RouteVariant[]=[];let apiSnapshot:QuotedComponent['api_snapshot'];let customer='0';let maximum=0n;
  for(const target of [route.primary,...(route.fallback?[route.fallback]:[])]){
   const catalog=(await published(tx,scope,target.catalog_version_id,'catalog')).payload as CatalogDefinition,model=catalog.models.find(m=>m.id===target.model&&m.status==='active');
   if(!model?.api||!model.rate_card_version_id)throw new DomainError('api_operation_required');
   validateApiInput(model.api,payload.input,payload.parameters);const files=fileMetrics(apiFiles),measurements=apiMeasurements(model.api,payload.input,files)!;
   const providerMaximum=rateMaximum({state:'known',items:apiItems(model.api,measurements)},card,{at:clock.now().toISOString(),connection_id:target.connection_id,conditions:{...c.conditions,model:model.id}});
   if(providerMaximum.state!=='calculated')throw new DomainError('pricing_unavailable');if(providerMaximum.rounded_units>units(target.max_cost_units))throw new DomainError('route_cost_limit');
   const price=priceApi(model.api,measurements,card,{at:clock.now().toISOString(),connection_id:target.connection_id,conditions:{...c.conditions,model:model.id}});if(BigInt(price)>BigInt(model.api.pricing.max_units))throw new DomainError('api_price_limit');
   if(apiSnapshot&&hash(apiSnapshot.definition)!==hash(model.api))throw new DomainError('incompatible_fallback');
   apiSnapshot={definition:model.api,measurements,files};customer=model.api.billing_mode==='actual_capped'?model.api.pricing.max_units:price;
   const allowance=await quoteAllowance(tx,scope,clock,target.connection_id,apiItems(model.api,measurements));if(model.api.allowance_mode==='subscription'&&!allowance)throw new DomainError('allowance_subscription_required');
   variants.push({connection_id:target.connection_id,model:model.id,adapter_ref:model.adapter_ref,endpoint_scope:`${target.connection_id}:${model.id}`,max_cost_units:target.max_cost_units,...(target.limiter_key?{limiter_key:target.limiter_key}:{}),...(allowance?{allowance}:{})});
   if(BigInt(target.max_cost_units)>maximum)maximum=BigInt(target.max_cost_units);
  }
  if(units(route.platform_risk_budget_units)<maximum)throw new DomainError('platform_risk_budget_exhausted');
  return {...c,conditions:{...c.conditions,model:variants[0].model},count_resolved:evaluateCount(c.count,values),max_units:customer,estimated_units:customer,api_snapshot:apiSnapshot,maximum_items:apiItems(apiSnapshot!.definition,apiSnapshot!.measurements),route_deadline_seconds:resolveExecutionPolicy(route.execution,route.deadline_seconds===undefined?undefined:{deadline_seconds:route.deadline_seconds}).deadline_seconds,route:{execution_policy_version_id:policyVersion,execution:resolveExecutionPolicy(route.execution),...(apiSnapshot!.definition.billing_mode==='quoted_final'?{customer_price_units:customer}:{}),primary:variants[0],...(variants[1]?{fallback:variants[1]}:{}),period_budget_key:periodKey,request_risk_limit_units:route.platform_risk_budget_units,incident_risk_limit_units:route.platform_risk_budget_units}};
 }
 const selectedPrice=c.billing&&payload?fixedPrice(c.billing,payload.parameters??{}):undefined;
 const policy=selectedPrice?.estimation??c.estimation;
 const estimate=policy?estimateItems(policy,payload):null;
 const count=evaluateCount(c.count,values);let maximum=0n,expected=0n;const variants:execution.RouteVariant[]=[];
 for(const target of [route.primary,...(route.fallback?[route.fallback]:[])]) {
  const catalog=(await published(tx,scope,target.catalog_version_id,'catalog')).payload as CatalogDefinition;
  const model=catalog.models.find(m=>m.id===target.model&&m.status==='active');if(!model||!model.capabilities.includes(c.capability))throw new DomainError('unsupported_capability','Model cannot execute component',422);
  if(payload&&c.capability==='embeddings.generate'){if(!['openai','voyage'].includes(model.provider))throw new DomainError('unsupported_embedding_model');validateEmbeddingInput({model:model.id,texts:payload.input.texts as string[],parameters:model.calculation?normalizeParameters(model.calculation,payload.parameters??{}):payload.parameters});}
  if(payload&&c.capability==='text.generate'){const textInput={...payload.input,model:model.id,capability:c.capability,input:String(payload.input.text??''),response_schema:payload.input.response_schema?{name:'result',schema:payload.input.response_schema as Record<string,unknown>}:undefined} as ProviderInput;validateProviderText(model.provider,textInput);if(model.provider!=='fake'){const referenced=new Set((textInput.messages??[]).flatMap(message=>typeof message.content==='string'?[]:message.content).filter(block=>block.type==='image').map(block=>block.asset_id));if(preparedAssets.some(asset=>!referenced.has(asset.id)))throw new DomainError('unreferenced_input_asset');validateTextFeatures(model.text_features,textInput);for(const asset of preparedAssets)if(!model.text_features?.image_media_types.includes(`image/${asset.format}` as any))throw new DomainError('unsupported_model_image');}}
  if(c.pricing_mode==='quoted_final'||c.pricing_mode==='estimated_actual'||c.pricing_mode==='actual_capped'){
   if(!payload)throw new DomainError('single_call_required','Model final pricing requires a concrete single-call input',422);
   if(!model.calculation||!model.rate_card_version_id)throw new DomainError('model_calculation_missing');
   const modelCard=(await published(tx,scope,model.rate_card_version_id,'rate_card')).payload as RateCard;
   const params=normalizeParameters(model.calculation,payload.parameters??{});
   if(isAlternativeProvider(model.provider)){
    const {max_output_tokens,expected_output_tokens,...providerParams}=params;
    const candidate={...payload.input,capability:c.capability,model:model.id,input:String(payload.input.text??''),service_mode:target.service_mode,max_output_tokens:max_output_tokens as number,parameters:providerParams,assets:preparedAssets.map(a=>({filename:a.id,content_type:`image/${a.format}`,bytes:Buffer.from((a as PreparedAsset).base64,'base64')}))} as ProviderInput;
    validateAlternative(model.provider,candidate);
    if(model.provider==='google_cloud'&&target.service_mode!=='standard')throw new DomainError('unsupported_service_mode');
    if(c.pricing_mode!=='estimated_actual')throw new DomainError('unproven_provider_exposure','Alternative model forecasts are approximate; use estimated_actual until a capped exposure profile is accepted',422);
   }
   if(['replicate','quiver'].includes(model.provider)){
    const {max_output_tokens,...svgParameters}=params;
    if(model.calculation.preparation.mode==='transform')throw new DomainError('unsupported_svg_preparation','SVG references require original bytes',422);
    await validateSvgAssets(model.provider,{model:model.id,capability:c.capability,input:String(payload.input.prompt??''),max_output_tokens:max_output_tokens as number|undefined,parameters:svgParameters,assets:preparedAssets.map(a=>({filename:a.id,content_type:`image/${a.format}`,bytes:Buffer.from((a as PreparedAsset).base64,'base64')}))});
   }
   const breakdown=priceModel(model.calculation,{input:payload.input,parameters:params,assets:storage.inputAssetReferences(payload.input).map(id=>preparedAssets.find(asset=>asset.id===id)!).filter(Boolean)},modelCard,{at:clock.now().toISOString(),connection_id:target.connection_id,conditions:{...c.conditions,model:target.model}});
   const cap=units(target.max_cost_units);if(BigInt(breakdown.provider_estimate_units)>cap)throw new DomainError('route_cost_limit','Model estimate exceeds provider exposure cap',422);
   const cache_identity=c.pricing_mode==='estimated_actual'?cacheIdentity(scope,target.connection_id,target.model,payload.input,preparedAssets,model.calculation.preparation,params):undefined;
   const cache_forecast=c.pricing_mode==='estimated_actual'?await cacheForecast(tx,scope,clock,target.connection_id,target.model,cache_identity,breakdown.components.flatMap(r=>r.result.kind==='quantity'?[{dimension:r.result.dimension,unit:r.result.unit,quantity:r.value,conditions:r.result.conditions}]:[]),modelCard,{at:clock.now().toISOString(),connection_id:target.connection_id,conditions:{...c.conditions,model:target.model}},model.calculation.pricing,breakdown.price_units):undefined;
   if(cache_forecast)breakdown.price_units=cache_forecast.expected_estimate_units;
   if(target===route.primary){c={...c,rate_card_version_id:model.rate_card_version_id};card=modelCard;executionParameters=params;calculationSnapshot={catalog_version_id:target.catalog_version_id,model:target.model,method:model.calculation,breakdown};}
   else if(canonicalPreparation(model.calculation)!==canonicalPreparation(calculationSnapshot!.method)||(c.pricing_mode!=='estimated_actual'&&(model.rate_card_version_id!==c.rate_card_version_id||hash(params)!==hash(executionParameters))))throw new DomainError('incompatible_fallback','Final-price fallback must share rates, prepared-input rules and normalized parameters',422);
   if(cap>maximum)maximum=cap;
   variants.push({service_mode:target.service_mode,text_features:model.text_features,cache_identity,cache_forecast,...(['estimated_actual','actual_capped'].includes(c.pricing_mode??'')?{overdraft_allowed:c.pricing_mode==='estimated_actual',rate_card_version_id:model.rate_card_version_id,usage_pricing:model.calculation!.pricing,execution_parameters:params,maximum_items:model.calculation!.components.flatMap(r=>r.result.kind==='quantity'?[{dimension:r.result.dimension,unit:r.result.unit,quantity:r.maximum,conditions:r.result.conditions}]:[])}:{}),...(model.adapter_ref?{adapter_ref:model.adapter_ref}:{}),connection_id:target.connection_id,model:target.model,endpoint_scope:`${target.connection_id}:${target.model}`,max_cost_units:cap.toString(),...(target.limiter_key?{limiter_key:target.limiter_key}:{}),limit_tokens:breakdown.components.filter(r=>r.result.kind==='quantity'&&r.result.unit==='tokens').reduce((n,r)=>n+BigInt(r.value),0n).toString()});
   continue;
  }
  const rating=rateMaximum({state:'known',items:estimate?.maximum??defaultItems(c)},card,{at:clock.now().toISOString(),connection_id:target.connection_id,conditions:c.conditions});
  if(rating.state!=='calculated')throw new DomainError('pricing_unavailable',rating.reason,422);
  // Published route cap is an administrator-declared conservative bound for the complete permitted input.
  const cap=estimate?rating.rounded_units:(units(target.max_cost_units)>rating.rounded_units?units(target.max_cost_units):rating.rounded_units);
  if(estimate&&cap>units(target.max_cost_units))throw new DomainError('route_cost_limit','Estimated maximum exceeds route safety limit',422);
  const forecast=estimate?rateMaximum({state:'known',items:estimate.expected},card,{at:clock.now().toISOString(),connection_id:target.connection_id,conditions:c.conditions}):rating;
  if(forecast.state!=='calculated')throw new DomainError('pricing_unavailable',forecast.reason,422);
  if((estimate?forecast.rounded_units:cap)>expected)expected=estimate?forecast.rounded_units:cap;
  if(cap>maximum)maximum=cap;
  variants.push({service_mode:target.service_mode,text_features:model.text_features,...(model.adapter_ref?{adapter_ref:model.adapter_ref}:{}),connection_id:target.connection_id,model:target.model,endpoint_scope:`${target.connection_id}:${target.model}`,max_cost_units:cap.toString(),...(target.limiter_key?{limiter_key:target.limiter_key}:{}),limit_tokens:String((c.limits.input_tokens??0)+(c.limits.output_tokens??0))});
 }
 for(const variant of variants){const auth=await quoteAllowance(tx,scope,clock,variant.connection_id,calculationSnapshot?calculationSnapshot.method.components.flatMap(r=>r.result.kind==='quantity'?[{dimension:r.result.dimension,unit:r.result.unit,quantity:r.maximum}]:[]):estimate?.maximum??defaultItems(c));if(auth)variant.allowance=auth;}
 if(units(route.platform_risk_budget_units)<maximum)throw new DomainError('platform_risk_budget_exhausted','Route risk budget cannot cover an attempt',503);
 const customerPrice=(c.pricing_mode==='quoted_final'?calculationSnapshot?.breakdown.price_units:undefined)??(c.billing?(selectedPrice?.units??c.billing.prices.reduce((m,r)=>BigInt(r.units)>BigInt(m)?r.units:m,'0')):undefined);
 return {...c,...(calculationSnapshot?{calculation_snapshot:calculationSnapshot,execution_parameters:executionParameters}:{}),maximum_items:calculationSnapshot?calculationSnapshot.method.components.flatMap(r=>r.result.kind==='quantity'?[{dimension:r.result.dimension,unit:r.result.unit,quantity:r.maximum,conditions:r.result.conditions}]:[]):estimate?.maximum??defaultItems(c),count_resolved:count,max_units:c.pricing_mode==='estimated_actual'?calculationSnapshot!.breakdown.price_units:customerPrice??maximum.toString(),estimated_units:calculationSnapshot?.breakdown.price_units??customerPrice??expected.toString(),route:{execution_policy_version_id:policyVersion,execution:resolveExecutionPolicy(route.execution),...(customerPrice?{customer_price_units:customerPrice}:{}),...{primary:variants[0],...(variants[1]?{fallback:variants[1]}:{}),period_budget_key:periodKey,request_risk_limit_units:route.platform_risk_budget_units,incident_risk_limit_units:route.platform_risk_budget_units}},route_deadline_seconds:resolveExecutionPolicy(route.execution,route.deadline_seconds===undefined?undefined:{deadline_seconds:route.deadline_seconds}).deadline_seconds};
}
function canonicalPreparation(policy:ModelCalculation){return hash(policy.preparation)}
function budgetLimit(input:QuoteInput):bigint|null {
 const b=input.budget;if(!b)return null;if(b.credit_unit_id&&b.credit_unit_id!==CREDIT_UNIT)invalid('Unsupported credit unit');
 if(b.max_units!==undefined&&b.max_credits!==undefined)invalid('Specify one budget maximum');
 if(b.max_units!==undefined)return units(b.max_units);
 if(b.max_credits!==undefined){if(!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(b.max_credits))invalid('Credit limit requires at most six decimal places');const [whole,fraction='']=b.max_credits.split('.');return units((BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'))).toString());}
 invalid('Budget maximum required');
}
async function replay(tx:Tx,scope:Scope,command:string,key:string,input:unknown):Promise<string|null> {
 if(!key?.trim()||key.length>200)invalid('Idempotency key required');
 const row=(await tx.query('SELECT * FROM quoting_commands WHERE organization_id=$1 AND application_id=$2 AND command=$3 AND key=$4',[scope.organization_id,scope.application_id,command,key])).rows[0];
 if(!row)return null;if(row.account_id!==scope.account_id||row.payload_hash!==hash(input))throw new DomainError('idempotency_conflict');return row.resource_id;
}
async function remember(tx:Tx,scope:Scope,command:string,key:string,input:unknown,resource:string) {await tx.query('INSERT INTO quoting_commands(organization_id,application_id,account_id,command,key,payload_hash,resource_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...sv(scope),command,key,hash(input),resource]);}
async function rawQuote(tx:Tx,scope:Scope,quoteId:string) {const row=(await tx.query(`SELECT * FROM quotes WHERE ${scoped} AND id=$4`,[...sv(scope),quoteId])).rows[0];if(!row)throw new DomainError('not_found','Quote not found',404);return row;}
export async function getQuote(tx:Tx,scope:Scope,quoteId:string) {
 const q=await rawQuote(tx,scope,quoteId);const recipe=(await tx.query('SELECT key,version FROM recipe_versions WHERE id=$1',[q.recipe_id])).rows[0];
 return {id:q.id,wallet_id:q.wallet_id,recipe:recipe??null,kind:q.kind,input_hash:q.input_hash,credit_unit_id:CREDIT_UNIT,max_units:q.max_units,estimated_units:q.estimated_units,...(q.terms.settlement==='quoted_final'?{price_units:q.max_units}:{}),confidence:q.terms.estimate_only?'modeled':'conservative',breakdown:q.components.map((c:QuotedComponent)=>({component:c.key,count:c.count_resolved,max_units:(BigInt(c.max_units)*BigInt(c.count_resolved)).toString(),estimated_units:(BigInt(c.estimated_units)*BigInt(c.count_resolved)).toString(),route_version_id:c.route_version_id,rate_card_version_id:c.rate_card_version_id,...(c.route.primary.cache_forecast?{cache:c.route.primary.cache_forecast}:{})})),expires_at:q.expires_at,...q.terms};
}
export async function createQuote(tx:Tx,scope:Scope,clock:Clock,input:QuoteInput) {
 const wallet=await lock(tx,scope);const previous=await replay(tx,scope,'quote',input.idempotency_key,input);if(previous)return getQuote(tx,scope,previous);
 if(input.wallet_id&&input.wallet_id!==wallet)throw new DomainError('not_found','Wallet not found',404);
 if(input.kind==='pool')return createPoolQuote(tx,scope,clock,wallet,input);
 const recipe=await getRecipe(tx,scope,input);const def=recipe.definition as RecipeDefinition;const values=input.inputs??{};recipeInputs(def,values);
 const kind=input.kind??(input.profile?'single_call':'recipe');if(kind==='single_call'&&(def.components.length!==1||evaluateCount(def.components[0].count,values)!==1))invalid('Single-call profile must have one component');
 let preparedAssets:PreparedAsset[]=[];let preparedApiAssets:PreparedApiFile[]=[];
 const components:QuotedComponent[]=[];for(const component of def.components){
  if(component.capability==='api.call'){
   if(kind!=='single_call'||!input.input)throw new DomainError('single_call_required');
   const route=(await published(tx,scope,component.route_version_id,'route')).payload as RouteDefinition;const catalog=(await published(tx,scope,route.primary.catalog_version_id,'catalog')).payload as CatalogDefinition;const operation=catalog.models.find(m=>m.id===route.primary.model)?.api;if(!operation)throw new DomainError('api_operation_required');
   validateApiInput(operation,input.input,input.parameters);preparedApiAssets=await prepareApiFiles(tx,scope,clock,operation,input.input.asset_ids);
  }else if(component.pricing_mode==='quoted_final'||component.pricing_mode==='estimated_actual'||component.pricing_mode==='actual_capped'){
   if(kind!=='single_call'||!input.input)throw new DomainError('single_call_required');
   const route=(await published(tx,scope,component.route_version_id,'route')).payload as RouteDefinition;
   const catalog=(await published(tx,scope,route.primary.catalog_version_id,'catalog')).payload as CatalogDefinition;
   const method=catalog.models.find(m=>m.id===route.primary.model)?.calculation;if(!method)throw new DomainError('model_calculation_missing');
   preparedAssets=await prepareModelAssets(tx,scope,clock,method,storage.inputAssetIds(input.input));
  }
  components.push(await quoteComponent(tx,scope,clock,component,values,def.period_budget_key,kind==='single_call'&&input.input?{kind:input.capability??component.capability,input:input.input,parameters:input.parameters}:undefined,preparedAssets,preparedApiAssets));
 }
 if(kind==='single_call'){if(!input.input)invalid('Single-call input required');await validatePayload(tx,scope,clock,components[0],{kind:input.capability??components[0].capability,input:input.input!,parameters:components[0].execution_parameters??input.parameters});}
 const limits=await executionLimits(tx);
 resolveExecutionPolicy(def.execution,input.execution,limits);
 const billing=resolveBillingPolicy(def.billing,input.billing);
 for(const component of components){for(const target of [component.route.primary,...(component.route.fallback?[component.route.fallback]:[])])if(input.delivery?.stream&&input.input?.response_schema&&target.text_features?.schema_streaming===false)throw new DomainError('unsupported_schema_streaming');component.route.execution=resolveExecutionPolicy(def.execution,input.execution,limits,component.route.execution);component.route.billing=billing;component.route.priority=priorityValue(input.priority);component.route.delivery=DeliveryPolicy.parse(input.delivery??{});if(component.route.delivery.field_paths?.length)validateFieldPaths(input.input?.response_schema??component.response_schema??(input.input?.tools as {parameters:unknown}[]|undefined)?.[0]?.parameters,component.route.delivery.field_paths);if(input.execution?.deadline_seconds!==undefined&&input.execution.deadline_seconds>Math.min(def.deadline_seconds??86400,component.route_deadline_seconds))throw new DomainError('invalid_execution_policy','Requested deadline exceeds route or recipe limit',422);}
 const policy=components[0].route.execution!;
 const estimated=components.reduce((sum,c)=>sum+BigInt(c.estimated_units)*BigInt(c.count_resolved),0n);
 const max=units(components.reduce((sum,c)=>sum+BigInt(c.max_units)*BigInt(c.count_resolved),0n).toString());const limit=budgetLimit(input);if(limit!==null&&components.some(c=>c.pricing_mode==='estimated_actual'))throw new DomainError('budget_conflict','Estimated actual pricing has no fixed charge ceiling; omit the fixed budget or use a capped profile',409);if(limit!==null&&max>limit)throw new DomainError('budget_conflict','Calculated maximum exceeds authorized budget',409,{required_units:max.toString(),authorized_units:limit.toString()});
 const metadata=input.metadata??{};await storage.assertContentAllowed(tx,scope,{...metadata,operation_id:input.operation_id});
 if(input.operation_id){const op=await rawOperation(tx,scope,input.operation_id);if(op.admission_status!=='open')throw new DomainError('operation_admission_closed');if(op.external_project_id!==(metadata.external_project_id??null)||op.project_generation!==(metadata.project_generation??null))invalid('Amendment cannot change project binding');}
 const expires=new Date(clock.now().getTime()+900000);const content={kind:input.capability??components[0].capability,input:input.input??null,parameters:input.parameters??{},inputs:values};
 const stored=await storage.putInput(tx,scope,clock,{...metadata,content:{...content,...(preparedAssets.length?{prepared_assets:preparedAssets}:{}),...(preparedApiAssets.length?{prepared_api_assets:preparedApiAssets}:{})},expires_at:expires});
 const quoteId=id('quote');const deadline=Math.min(policy.deadline_seconds,def.deadline_seconds??86400,...components.map(c=>c.route_deadline_seconds));
 const terms={...(components.some(c=>c.pricing_mode==='estimated_actual')?{estimate_only:true,overdraft_allowed:true}:{}),settlement:components.every(c=>c.pricing_mode==='quoted_final')?'quoted_final':components.every(c=>c.billing)?'fixed':components.some(c=>c.billing||c.pricing_mode==='quoted_final')?'mixed':'actual_usage',partial_policy:'successful_parts',cancellation_policy:components.some(c=>c.billing||c.pricing_mode==='quoted_final')?'fixed_result_only_otherwise_confirmed_cost':'confirmed_active_attempt_cost',execution:{...policy,deadline_seconds:deadline},billing,deadline_seconds:deadline,content_ttl_seconds:def.content_ttl_seconds??3600,warnings:components.some(c=>c.pricing_mode)?['provider_cost_is_estimated']:['cache_hits_not_guaranteed','conservative_upper_bound']};
 await tx.query('INSERT INTO quotes(id,organization_id,application_id,account_id,wallet_id,recipe_id,kind,input_hash,input_ref,components,max_units,estimated_units,terms,external_project_id,project_generation,for_operation_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$18,$12,$13,$14,$15,$16,$17)',[quoteId,...sv(scope),wallet,recipe.id,kind,hash(content),stored.id,JSON.stringify(components),max.toString(),terms,metadata.external_project_id??null,metadata.project_generation??null,input.operation_id??null,clock.now(),expires,estimated.toString()]);
 await remember(tx,scope,'quote',input.idempotency_key,input,quoteId);return getQuote(tx,scope,quoteId);
}
async function createPoolQuote(tx:Tx,scope:Scope,clock:Clock,wallet:string,input:QuoteInput) {
 const pool=input.pool;if(!pool||!Array.isArray(pool.profiles)||!pool.profiles.length||pool.profiles.length>32)invalid('Reserve pool needs 1 to 32 profiles');
 if(input.input!==undefined||input.parameters!==undefined||input.recipe||input.profile||input.inputs||input.operation_id)invalid('A reserve pool names profiles and a reserve, not a call');
 const reserve=budgetLimit(input);if(reserve===null||reserve<=0n)invalid('Reserve pool needs a positive budget to hold');
 const profiles:PoolTerms['profiles']=[];
 for(const entry of pool.profiles){
  if(!entry?.profile||profiles.some(p=>p.profile===entry.profile))invalid('Pool profiles must be named once');
  // The version is pinned now: later calls are priced by the configuration the pool was opened with.
  const recipe=await getRecipe(tx,scope,{profile:entry.profile} as QuoteInput),def=recipe.definition as RecipeDefinition;
  if(def.components.length!==1||!('constant' in def.components[0].count)||def.components[0].count.constant!==1)invalid('Pool profiles must be single-call profiles');
  profiles.push({profile:entry.profile,version:recipe.version,max_calls:integer(entry.max_calls,1,256)});
 }
 const terms:PoolTerms={profiles,max_calls:pool.max_calls===undefined?profiles.reduce((n,p)=>n+p.max_calls,0):integer(pool.max_calls,1,profiles.reduce((n,p)=>n+p.max_calls,0))};
 const deadline=pool.deadline_seconds===undefined?3600:integer(pool.deadline_seconds,60,86400);
 const metadata=input.metadata??{};await storage.assertContentAllowed(tx,scope,metadata);
 const expires=new Date(clock.now().getTime()+900000),content={kind:'pool',pool:terms};
 const stored=await storage.putInput(tx,scope,clock,{...metadata,content,expires_at:expires});
 const quoteId=id('quote');
 await tx.query('INSERT INTO quotes(id,organization_id,application_id,account_id,wallet_id,recipe_id,kind,input_hash,input_ref,components,max_units,estimated_units,terms,external_project_id,project_generation,created_at,expires_at) VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15)',[quoteId,...sv(scope),wallet,'pool',hash(content),stored.id,'[]',reserve.toString(),{pool:terms,settlement:'actual_usage',partial_policy:'successful_parts',cancellation_policy:'confirmed_active_attempt_cost',execution:resolveExecutionPolicy(undefined,undefined,await executionLimits(tx)),billing:resolveBillingPolicy(undefined),deadline_seconds:deadline,content_ttl_seconds:3600,warnings:['reserve_is_not_a_charge_ceiling']},metadata.external_project_id??null,metadata.project_generation??null,clock.now(),expires]);
 await remember(tx,scope,'quote',input.idempotency_key,input,quoteId);return getQuote(tx,scope,quoteId);
}
async function validatePayload(tx:Tx,scope:Scope,clock:Clock,c:RecipeComponent,payload:RequestPayload) {
 if(payload.kind!==c.capability)throw new DomainError('request_exceeds_recipe','Capability mismatch',422);
 if(!payload.input||typeof payload.input!=='object'||Array.isArray(payload.input))invalid('Input object required');
 const input=payload.input,p=payload.parameters??{},limits=c.limits;
 if(c.capability==='api.call'){const snapshot=(c as QuotedComponent).api_snapshot;if(!snapshot)throw new DomainError('api_operation_required');validateApiInput(snapshot.definition,input,p);for(const assetId of (input.asset_ids??[]) as string[])await storage.getAsset(tx,scope,clock,assetId,true);return;}
 const modelPolicy=(c as QuotedComponent).calculation_snapshot?.method;
 if(modelPolicy)normalizeParameters(modelPolicy,p);
 const allowedInput=c.capability==='embeddings.generate'?['texts']:c.capability==='text.generate'?['messages','instructions','text','asset_ids','response_schema','tools','tool_choice','parallel_tool_calls']:c.capability.startsWith('image.')?['prompt','asset_ids']:c.capability==='speech.synthesize'?['text','voice','asset_ids']:['query'];
 for(const key of Object.keys(input))if(!allowedInput.includes(key))invalid(`Unsupported input field ${key}`);
 const special=c.capability==='text.generate'?['max_output_tokens']:c.capability.startsWith('image.')?['count','size','quality']:[];
 for(const [key,value] of Object.entries(p)){
  if(!modelPolicy&&!special.includes(key)&&!Object.hasOwn(limits.parameter_values??{},key))throw new DomainError('request_exceeds_recipe',`Parameter ${key} is not authorized`,422);
  if(!modelPolicy&&limits.parameter_values?.[key]&&!limits.parameter_values[key].some(allowed=>hash(allowed)===hash(value)))throw new DomainError('request_exceeds_recipe',`Parameter ${key} outside authorized values`,422);
 }
 if(input.asset_ids!==undefined&&(!Array.isArray(input.asset_ids)||input.asset_ids.some(a=>typeof a!=='string')))invalid('Invalid asset IDs');
 const assets=storage.inputAssetReferences(input);
 if(assets.length>(limits.max_assets??0))throw new DomainError('request_exceeds_recipe','Too many assets',422);
 for(const asset of assets)await storage.getAsset(tx,scope,clock,asset,true);
 if(input.response_schema){checkSchema(input.response_schema);if(c.response_schema&&hash(c.response_schema)!==hash(input.response_schema))throw new DomainError('request_exceeds_recipe','Result schema differs from recipe',422);}
 if(c.response_schema&&!input.response_schema)throw new DomainError('request_exceeds_recipe','Required result schema omitted',422);
 if(c.capability==='text.generate'){
  validateTextInput({...input,response_schema:input.response_schema?{name:'result',schema:input.response_schema as Record<string,unknown>}:undefined} as ProviderInput);
  if(!input.messages&&!input.text)invalid('Text or messages required');
  if(input.text!==undefined&&typeof input.text!=='string')invalid('Invalid text');if(input.instructions!==undefined&&typeof input.instructions!=='string')invalid('Invalid instructions');
  if(c.pricing_mode!=='estimated_actual')integer(p.max_output_tokens,1,limits.output_tokens);
  // UTF-8 bytes conservatively bound ordinary text tokens; allowance includes message framing.
  const bytes=Buffer.byteLength(JSON.stringify(input),'utf8')+128+(Array.isArray(input.messages)?input.messages.length*16:0);
  const imageTokens=assets.length*(limits.image_input_tokens_per_asset??0);
  if(!modelPolicy&&assets.length&&!limits.image_input_tokens_per_asset)invalid('Text image-token bound missing');
  if(!modelPolicy&&bytes+imageTokens>(limits.input_tokens??0))throw new DomainError('request_exceeds_recipe','Input exceeds conservative token bound',422);
 }else if(c.capability==='embeddings.generate'){
  if(!modelPolicy)invalid('Embeddings requires model pricing');validateEmbeddingInput({model:(c as QuotedComponent).route.primary.model,texts:input.texts as string[],parameters:normalizeParameters(modelPolicy!,p)});
 }else if(c.capability.startsWith('image.')){
  if(c.capability==='image.vectorize'){if(assets.length!==1||input.prompt!==undefined)invalid('Vectorization requires one raster asset and no prompt');}else if(typeof input.prompt!=='string'||!input.prompt.trim())invalid('Image prompt required');
  if(Buffer.byteLength(String(input.prompt??''))>10000||(!modelPolicy&&limits.input_tokens!==undefined&&Buffer.byteLength(JSON.stringify(input))+128>limits.input_tokens))throw new DomainError('request_exceeds_recipe','Image prompt too long',422);
  if(p.background==='transparent'&&p.output_format==='jpeg')throw new DomainError('request_exceeds_recipe','Transparent backgrounds require PNG or WebP',422);
  if((p.count??1)!==1||!modelPolicy&&(!limits.image_sizes?.includes(String(p.size))||!limits.image_qualities?.includes(String(p.quality))))throw new DomainError('request_exceeds_recipe','Image parameters outside recipe',422);
 }else if(c.capability==='speech.synthesize'){
  if(typeof input.text!=='string'||input.text.length>(limits.input_characters??0))throw new DomainError('request_exceeds_recipe','Speech character bound exceeded',422);
  if(input.voice!==undefined&&!limits.parameter_values?.voice?.includes(input.voice as string))throw new DomainError('request_exceeds_recipe','Voice not authorized',422);
 }else if(typeof input.query!=='string'||input.query.length>1000)invalid('Invalid search query');
}
async function availableRoutes(tx:Tx,scope:Scope,components:QuotedComponent[]) {
 for(const c of components){
  const period=(await tx.query("SELECT * FROM execution_budgets WHERE organization_id=$1 AND kind='period' AND budget_key=$2",[scope.organization_id,c.route.period_budget_key])).rows[0];
  if(!period||BigInt(period.limit_units)-BigInt(period.reserved_units)-BigInt(period.spent_units)<BigInt(c.route.primary.max_cost_units))throw new DomainError('platform_risk_budget_exhausted','Platform risk budget unavailable',503);
  let eligible=false;
  for(const target of [c.route.primary,...(c.route.fallback?[c.route.fallback]:[])]){
   const connection=(await tx.query('SELECT status,provider,credential_status FROM provider_connections WHERE id=$1 AND organization_id=$2 AND application_id=$3',[target.connection_id,scope.organization_id,scope.application_id])).rows[0];
   const budget=(await tx.query("SELECT * FROM execution_budgets WHERE organization_id=$1 AND kind='provider' AND budget_key=$2",[scope.organization_id,target.connection_id])).rows[0];
   const incident=(await tx.query('SELECT status FROM execution_incidents WHERE organization_id=$1 AND failure_scope=$2',[scope.organization_id,target.endpoint_scope])).rows[0];
   if(connection?.status==='enabled'&&(connection.provider==='fake'||['configured','verified'].includes(connection.credential_status))&&!['locked','auth_failed','budget_exhausted'].includes(incident?.status)&&budget&&BigInt(budget.limit_units)-BigInt(budget.reserved_units)-BigInt(budget.spent_units)>=BigInt(target.max_cost_units))eligible=true;
  }
  if(!eligible)throw new DomainError('provider_unavailable_before_acceptance','No funded unlocked route',503);
 }
}
async function rawOperation(tx:Tx,scope:Scope,operationId:string,forUpdate=false) {const row=(await tx.query(`SELECT * FROM operations WHERE ${scoped} AND id=$4 ${forUpdate?'FOR UPDATE':''}`,[...sv(scope),operationId])).rows[0];if(!row)throw new DomainError('not_found','Operation not found',404);return row;}
export async function getOperation(tx:Tx,scope:Scope,clock:Clock,operationId:string) {
 await lock(tx,scope);const op=await rawOperation(tx,scope,operationId);const reserve=await accounting.getReservation(tx,scope,operationId);const requests=await execution.getOperationRequests(tx,scope,operationId);
 const executing=requests.some(r=>!['succeeded','failed','canceled','refused'].includes(r.execution_status));const success=requests.some(r=>r.execution_status==='succeeded');
 const executionStatus=executing?'running':op.admission_status==='open'?'accepted':op.closed_reason==='cancel'?'canceled':success&&requests.some(r=>r.execution_status!=='succeeded')?'partial':requests.some(r=>r.execution_status==='failed')?'failed':requests.some(r=>r.execution_status==='canceled')?'canceled':requests.some(r=>r.execution_status==='refused')?'refused':'completed';
 return {id:op.id,audit_identity:op.audit_identity??null,quote_id:op.quote_id,created_at:op.created_at,admission_status:op.admission_status,execution_status:executionStatus,settlement_status:op.settlement_status,accepted_max_units:op.accepted_max_units,captured_units:reserve.captured_units,reserved_units:(BigInt(reserve.max_units)-BigInt(reserve.captured_units)-BigInt(reserve.released_units)).toString(),deadline_at:op.deadline_at,external_project_id:op.external_project_id,project_generation:op.project_generation,wallet:await accounting.getWallet(tx,scope,clock),requests:requests.map(r=>({id:r.id,component:r.component,execution_status:r.execution_status,settlement_status:r.settlement_status}))};
}
export async function acceptQuote(tx:Tx,scope:Scope,clock:Clock,input:{quote_id:string;client_operation_key:string;idempotency_key:string}) {
 await lock(tx,scope);const prior=await replay(tx,scope,'accept',input.idempotency_key,input);if(prior)return getOperation(tx,scope,clock,prior);
 if(!input.client_operation_key?.trim())invalid('Client operation key required');const q=await rawQuote(tx,scope,input.quote_id);
 const existing=(await tx.query(`SELECT * FROM operations WHERE ${scoped} AND client_operation_key=$4`,[...sv(scope),input.client_operation_key])).rows[0];
 if(existing){if(existing.quote_id!==q.id)throw new DomainError('idempotency_conflict');await remember(tx,scope,'accept',input.idempotency_key,input,existing.id);return getOperation(tx,scope,clock,existing.id);}
 const bound=(await tx.query('SELECT operation_id FROM quote_bindings WHERE quote_id=$1',[q.id])).rows[0];if(bound)throw new DomainError('quote_already_bound');
 if(new Date(q.expires_at)<=clock.now())throw new DomainError('quote_expired');if(q.for_operation_id)invalid('Amendment quote cannot create an operation');
 await availableRoutes(tx,scope,q.components);await storage.assertContentAllowed(tx,scope,{external_project_id:q.external_project_id??undefined,project_generation:q.project_generation??undefined});
 await checkAdmissionBackpressure(tx,scope,clock,(q.components as QuotedComponent[]).reduce((n,c)=>n+c.count_resolved,0));
 const operation=id('op'),deadline=new Date(clock.now().getTime()+q.terms.deadline_seconds*1000);
 // Subscription locks are ordered across recipes to avoid cross-account deadlocks.
 const allowanceTasks=(q.components as QuotedComponent[]).flatMap(c=>c.route.primary.allowance?Array.from({length:c.count_resolved},(_,i)=>({c,i,auth:c.route.primary.allowance!})):[]).sort((a,b)=>a.auth.subscription_id.localeCompare(b.auth.subscription_id));
 for(const {c,i,auth} of allowanceTasks){const hold=await new AllowanceService(tx,clock).reserve(scope,auth.subscription_id,`${operation}:${c.key}:${i}`,auth.demands);(c.allowance_reservations??=[])[i]=hold.id;}
 await accounting.reserve(tx,scope,clock,{operation_id:operation,max_units:q.max_units,idempotency_key:`operation:${operation}:reserve`});
 await tx.query('INSERT INTO operations(id,organization_id,application_id,account_id,quote_id,client_operation_key,components,accepted_max_units,external_project_id,project_generation,deadline_at,content_ttl_seconds,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[operation,...sv(scope),q.id,input.client_operation_key,JSON.stringify(q.components),q.max_units,q.external_project_id,q.project_generation,deadline,q.terms.content_ttl_seconds,clock.now()]);
 await tx.query('INSERT INTO quote_bindings(quote_id,operation_id,bound_at) VALUES($1,$2,$3)',[q.id,operation,clock.now()]);
 await storage.bindInput(tx,scope,clock,q.input_ref,{operation_id:operation,external_project_id:q.external_project_id??undefined,project_generation:q.project_generation??undefined,expires_at:deadline});
 if(q.kind!=='single_call')await storage.discardInput(tx,scope,clock,q.input_ref);
 await emit(tx,scope,'operation.accepted',{type:'operation',id:operation},{quote_id:q.id,accepted_max_units:q.max_units});
 await remember(tx,scope,'accept',input.idempotency_key,input,operation);return getOperation(tx,scope,clock,operation);
}
export async function createRequest(tx:Tx,scope:Scope,clock:Clock,input:RequestPayload&{operation_id:string;component:string;client_request_key:string;idempotency_key:string}) {
 await lock(tx,scope);const previous=await replay(tx,scope,'request',input.idempotency_key,input);if(previous)return execution.getRequest(tx,scope,previous);
 if(!input.client_request_key?.trim())invalid('Client request key required');
 const op=await rawOperation(tx,scope,input.operation_id,true);const digest=hash({component:input.component,kind:input.kind,input:input.input,parameters:input.parameters??{}});
 const prior=(await tx.query(`SELECT * FROM execution_requests WHERE ${scoped} AND operation_id=$4 AND client_request_key=$5`,[...sv(scope),op.id,input.client_request_key])).rows[0];
 if(prior){if(prior.input_hash!==digest)throw new DomainError('idempotency_conflict');await remember(tx,scope,'request',input.idempotency_key,input,prior.id);return prior;}
 if(op.admission_status!=='open')throw new DomainError('operation_admission_closed');if(new Date(op.deadline_at)<=clock.now())throw new DomainError('operation_admission_closed','Operation deadline elapsed');
 let component=(op.components as QuotedComponent[]).find(c=>c.key===input.component);if(!component)throw new DomainError('request_exceeds_recipe','Unknown component',422);
 const count=(await tx.query('SELECT count(*)::integer n FROM execution_requests WHERE operation_id=$1 AND component=$2',[op.id,input.component])).rows[0].n;if(count>=component.count_resolved)throw new DomainError('request_exceeds_recipe','Component call count exceeded',422);
 const acceptedQuote=await rawQuote(tx,scope,op.quote_id);
 if(acceptedQuote.kind==='single_call'&&hash({kind:input.kind,input:input.input,parameters:input.parameters??{},inputs:{}})!==acceptedQuote.input_hash)throw new DomainError('idempotency_conflict','Input differs from single-call quote');
 await validatePayload(tx,scope,clock,component,{...input,parameters:component.execution_parameters??input.parameters});
 if(component.billing){const price=fixedPrice(component.billing,input.parameters??{});if(BigInt(price.units)>BigInt(component.max_units))throw new DomainError('request_exceeds_recipe');component={...component,max_units:price.units,estimated_units:price.units,route:{...component.route,customer_price_units:price.units}};}
 return admitRequest(tx,scope,clock,{operation:op,quote:acceptedQuote,component,allowance:component.allowance_reservations?.[count],call:input,digest,deadline_at:new Date(op.deadline_at),content_ttl_seconds:op.content_ttl_seconds});
}
/** Claims the request's maximum from the operation reserve and queues it; the caller has authorized and validated the call. */
async function admitRequest(tx:Tx,scope:Scope,clock:Clock,a:{operation:any;quote:any;component:QuotedComponent;allowance?:string;call:RequestPayload&{client_request_key:string;idempotency_key:string};digest:string;deadline_at:Date;content_ttl_seconds:number;request_id?:string}) {
 const {operation:op,quote,call}=a;let component=a.component;
 const binding={operation_id:op.id,external_project_id:op.external_project_id??undefined,project_generation:op.project_generation??undefined};await storage.assertContentAllowed(tx,scope,binding);
 const quoteContent=component.pricing_mode?(await storage.getInput(tx,scope,clock,quote.input_ref)).content:undefined;
 const stored=await storage.putInput(tx,scope,clock,{...binding,content:{kind:call.kind,input:call.input,parameters:component.execution_parameters??call.parameters??{},...(quoteContent?.prepared_assets?{prepared_assets:quoteContent.prepared_assets}:{}),...(quoteContent?.prepared_api_assets?{prepared_api_assets:quoteContent.prepared_api_assets}:{})},expires_at:a.deadline_at});const request=a.request_id??id('req');
 await accounting.claim(tx,scope,clock,{operation_id:op.id,request_id:request,max_units:component.max_units,idempotency_key:`request:${request}:claim`});
 if(a.allowance)component={...component,route:{...component.route,initial_allowance_reservation_id:a.allowance}};
 const result=await execution.enqueue(tx,scope,clock,{priority:component.route.priority,capability:component.capability,id:request,component:component.key,client_request_key:call.client_request_key,input_hash:a.digest,input_ref:stored.id,route:component.route,max_units:component.max_units,deadline_at:a.deadline_at,content_ttl_seconds:a.content_ttl_seconds,...binding});
 await storage.holdInputAssets(tx,scope,clock,request,storage.inputAssetIds(call.input));
 await tx.query('INSERT INTO request_authorizations(request_id,quote_id,component,accepted_at) VALUES($1,$2,$3,$4)',[request,quote.id,component,quote.created_at]);
 if(quote.kind==='single_call')await storage.discardInput(tx,scope,clock,quote.input_ref);
 await remember(tx,scope,'request',call.idempotency_key,call,request);return result;
}
async function finishIfSettled(tx:Tx,scope:Scope,clock:Clock,operationId:string) {
 const op=await rawOperation(tx,scope,operationId,true);if(op.admission_status!=='closed'||op.settlement_status==='settled')return;
 const reserve=await accounting.getReservation(tx,scope,operationId);if(reserve.claims.some((c:any)=>c.status==='open'))return;
 if(reserve.status==='open')await accounting.releaseReservation(tx,scope,clock,{operation_id:operationId,idempotency_key:`operation:${operationId}:release`});
 await tx.query("UPDATE operations SET settlement_status='settled',settled_at=$2 WHERE id=$1",[operationId,clock.now()]);await emit(tx,scope,'operation.settled',{type:'operation',id:operationId});
}
export async function settleRequest(tx:Tx,scope:Scope,clock:Clock,input:{request_id:string;charged_units:string;reason:string;idempotency_key:string}) {
 try {
  await lock(tx,scope);const allowanceRequest=await execution.getRequest(tx,scope,input.request_id);await releaseUnsentAllowance(tx,scope,clock,allowanceRequest.route.initial_allowance_reservation_id,input.reason);const request=await execution.getRequest(tx,scope,input.request_id);const result=await accounting.settleClaim(tx,scope,clock,{...input,allow_overdraft:request.route.primary.overdraft_allowed===true});await finishIfSettled(tx,scope,clock,request.operation_id);return result;
 }catch(error){
  // Never persist exception messages: provider input or secrets may appear in them.
  const kind=error instanceof DomainError?'domain':'infrastructure',at=clock.now();
  afterRollback(tx,async db=>{await db.query(`INSERT INTO execution_settlement_errors(id,request_id,organization_id,application_id,account_id,error_kind,occurred_at)
   SELECT $1,id,organization_id,application_id,account_id,$6,$7 FROM execution_requests
   WHERE id=$2 AND organization_id=$3 AND application_id=$4 AND account_id=$5`,[id('settlement_error'),input.request_id,scope.organization_id,scope.application_id,scope.account_id,kind,at])});
  throw error;
 }
}
async function closeOperation(tx:Tx,scope:Scope,clock:Clock,input:{operation_id:string;idempotency_key:string},mode:'complete'|'cancel'|'finish_partial') {
 await lock(tx,scope);const prior=await replay(tx,scope,mode,input.idempotency_key,input);if(prior)return getOperation(tx,scope,clock,prior);
 const op=await rawOperation(tx,scope,input.operation_id,true),requests=await execution.getOperationRequests(tx,scope,op.id);
 const closingPriority:Record<string,number>={complete:1,finish_partial:2,cancel:3};
 const active=requests.some(r=>!['succeeded','failed','canceled','refused'].includes(r.execution_status));
 // Closing admission does not stop accepted work. While that work is active,
 // callers may strengthen cancellation, but cannot undo it or rewrite a terminal result.
 if(op.admission_status==='closed'&&(!active||closingPriority[mode]<=(closingPriority[op.closed_reason]??0))){
  await remember(tx,scope,mode,input.idempotency_key,input,op.id);return getOperation(tx,scope,clock,op.id);
 }
 for(const c of op.components as QuotedComponent[]){const count=(await tx.query('SELECT count(*)::integer n FROM execution_requests WHERE operation_id=$1 AND component=$2',[op.id,c.key])).rows[0].n;for(const reservationId of (c.allowance_reservations??[]).slice(count))await releaseUnsentAllowance(tx,scope,clock,reservationId,`Operation ${mode}`);}
 await tx.query("UPDATE operations SET admission_status='closed',closed_reason=$2,closed_at=COALESCE(closed_at,$3) WHERE id=$1",[op.id,mode,clock.now()]);
 if(mode!=='complete')for(const r of requests) {
  if(mode==='finish_partial'&&r.first_dispatched_at)continue;
  await execution.cancelRequest(tx,scope,clock,r.id,(t,s,i)=>settleRequest(t,s,clock,i));
 }
 await finishIfSettled(tx,scope,clock,op.id);await emit(tx,scope,'operation.completed',{type:'operation',id:op.id},{reason:mode});await remember(tx,scope,mode,input.idempotency_key,input,op.id);return getOperation(tx,scope,clock,op.id);
}
export const complete=(tx:Tx,scope:Scope,clock:Clock,input:{operation_id:string;idempotency_key:string})=>closeOperation(tx,scope,clock,input,'complete');
export const cancel=(tx:Tx,scope:Scope,clock:Clock,input:{operation_id:string;idempotency_key:string})=>closeOperation(tx,scope,clock,input,'cancel');
export const finishPartial=(tx:Tx,scope:Scope,clock:Clock,input:{operation_id:string;idempotency_key:string})=>closeOperation(tx,scope,clock,input,'finish_partial');
export async function invoke(tx:Tx,scope:Scope,clock:Clock,input:QuoteInput&{quote_id?:string}) {
 await lock(tx,scope);const previous=await replay(tx,scope,'invoke',input.idempotency_key,input);
 if(previous){if(previous.startsWith('req_'))return poolInvocationResult(tx,scope,previous);const operation=await getOperation(tx,scope,clock,previous);return invocationResult(operation);}
 if(input.operation_id)return invokeInPool(tx,scope,clock,input);
 const quoteId=input.quote_id??String((await createQuote(tx,scope,clock,{...input,kind:'single_call',idempotency_key:`invoke:${input.idempotency_key}:quote`})).id);
 const quote=await rawQuote(tx,scope,quoteId);if(!input.quote_id&&!input.budget&&!quote.terms.estimate_only)invalid('Invocation requires an explicit budget');if(input.quote_id&&((input.execution!==undefined&&hash(resolveExecutionPolicy(quote.terms.execution,input.execution))!==hash(quote.terms.execution))||(input.billing!==undefined&&hash(resolveBillingPolicy(quote.terms.billing,input.billing))!==hash(quote.terms.billing))))throw new DomainError('idempotency_conflict','Policy differs from accepted quote');if(input.quote_id&&input.priority!==undefined&&priorityValue(input.priority)!==(quote.components[0].route.priority??0))throw new DomainError('idempotency_conflict','Priority differs from accepted quote');if(quote.kind!=='single_call')invalid('Invocation requires single-call quote');
 const stored=await storage.getInput(tx,scope,clock,quote.input_ref);const payload=stored.content;
 if((input.input!==undefined||input.parameters!==undefined||input.capability!==undefined||input.inputs!==undefined)&&hash({kind:input.capability??payload.kind,input:input.input??payload.input,parameters:input.parameters??payload.parameters,inputs:input.inputs??payload.inputs})!==quote.input_hash)throw new DomainError('idempotency_conflict','Input differs from quote');
 const limit=budgetLimit(input);if(limit!==null&&quote.terms.estimate_only)throw new DomainError('budget_conflict','Estimated actual pricing has no fixed charge ceiling; omit the fixed budget or use a capped profile',409);if(limit!==null&&BigInt(quote.max_units)>limit)throw new DomainError('budget_conflict');
 const operation=await acceptQuote(tx,scope,clock,{quote_id:quoteId,client_operation_key:`invoke:${input.idempotency_key}`,idempotency_key:`invoke:${input.idempotency_key}:accept`});
 const component=(quote.components as QuotedComponent[])[0];await createRequest(tx,scope,clock,{operation_id:operation.id,component:component.key,client_request_key:'single',idempotency_key:`invoke:${input.idempotency_key}:request`,kind:payload.kind,input:payload.input,parameters:payload.parameters});
 await complete(tx,scope,clock,{operation_id:operation.id,idempotency_key:`invoke:${input.idempotency_key}:complete`});
 await remember(tx,scope,'invoke',input.idempotency_key,input,operation.id);return invocationResult(await getOperation(tx,scope,clock,operation.id));
}
/**
 * A call inside a reserve pool. It is priced like an ordinary invocation of its profile and claims
 * that amount from the pool. When the pool cannot hold the claim, the shortfall comes from free
 * credits, as it would for a call made without the pool.
 */
async function invokeInPool(tx:Tx,scope:Scope,clock:Clock,input:QuoteInput&{quote_id?:string}) {
 const op=await rawOperation(tx,scope,input.operation_id!,true),poolQuote=await rawQuote(tx,scope,op.quote_id);
 if(poolQuote.kind!=='pool')invalid('Invocation operation must be a reserve pool');
 if(input.quote_id||input.recipe||input.inputs||input.kind&&input.kind!=='single_call')invalid('A pool call names its profile and is priced when it is made');
 if(op.admission_status!=='open')throw new DomainError('operation_admission_closed');if(new Date(op.deadline_at)<=clock.now())throw new DomainError('operation_admission_closed','Operation deadline elapsed');
 const terms=poolQuote.terms.pool as PoolTerms,allowed=terms.profiles.find(p=>p.profile===input.profile);
 if(!allowed)throw new DomainError('request_exceeds_recipe','Profile is not part of the reserve pool',422);
 const used=(await tx.query('SELECT count(*) FILTER (WHERE component=$2)::integer own,count(*)::integer total FROM execution_requests WHERE operation_id=$1',[op.id,allowed.profile])).rows[0];
 if(used.own>=allowed.max_calls)throw new DomainError('request_exceeds_recipe','Profile call limit of the reserve pool reached',422);
 if(used.total>=terms.max_calls)throw new DomainError('request_exceeds_recipe','Call limit of the reserve pool reached',422);
 const project=op.external_project_id?{external_project_id:op.external_project_id,project_generation:op.project_generation}:undefined;
 if(input.metadata&&hash(input.metadata)!==hash(project??{}))invalid('A pool call keeps the project binding of its pool');
 const priced=await createQuote(tx,scope,clock,{...input,kind:'single_call',operation_id:undefined,profile:undefined,recipe:{key:allowed.profile,version:allowed.version},metadata:project,idempotency_key:`invoke:${input.idempotency_key}:quote`});
 const quote=await rawQuote(tx,scope,String(priced.id));
 await availableRoutes(tx,scope,quote.components);await checkAdmissionBackpressure(tx,scope,clock,1);
 const request=id('req'),component:QuotedComponent={...(quote.components as QuotedComponent[])[0],key:allowed.profile},auth=component.route.primary.allowance;
 const allowance=auth?(await new AllowanceService(tx,clock).reserve(scope,auth.subscription_id,`${op.id}:${request}`,auth.demands)).id:undefined;
 const reserve=await accounting.getReservation(tx,scope,op.id);
 const unclaimed=BigInt(reserve.max_units)-BigInt(reserve.captured_units)-BigInt(reserve.released_units)-reserve.claims.filter((c:any)=>c.status==='open').reduce((n:bigint,c:any)=>n+BigInt(c.max_units),0n);
 const shortfall=BigInt(component.max_units)-unclaimed;
 if(shortfall>0n){
  await accounting.amendReservation(tx,scope,clock,{operation_id:op.id,additional_units:shortfall.toString(),idempotency_key:`pool:${request}:top-up`});
  await tx.query('UPDATE operations SET accepted_max_units=accepted_max_units+$2::bigint WHERE id=$1',[op.id,shortfall.toString()]);
 }
 await tx.query('INSERT INTO quote_bindings(quote_id,operation_id,bound_at) VALUES($1,$2,$3)',[quote.id,op.id,clock.now()]);
 const payload=(await storage.getInput(tx,scope,clock,quote.input_ref)).content;
 const call={kind:payload.kind,input:payload.input,parameters:payload.parameters,client_request_key:`invoke:${input.idempotency_key}`,idempotency_key:`invoke:${input.idempotency_key}:request`};
 await admitRequest(tx,scope,clock,{operation:op,quote,component,allowance,call,digest:hash({component:allowed.profile,kind:call.kind,input:call.input,parameters:call.parameters??{}}),deadline_at:new Date(Math.min(new Date(op.deadline_at).getTime(),clock.now().getTime()+quote.terms.deadline_seconds*1000)),content_ttl_seconds:quote.terms.content_ttl_seconds,request_id:request});
 await remember(tx,scope,'invoke',input.idempotency_key,input,request);return poolInvocationResult(tx,scope,request);
}
async function poolInvocationResult(tx:Tx,scope:Scope,requestId:string) {
 const r=await execution.getRequest(tx,scope,requestId),auth=(await tx.query('SELECT quote_id FROM request_authorizations WHERE request_id=$1',[requestId])).rows[0];
 return {operation_id:r.operation_id,request_id:r.id,quote_id:auth.quote_id,accepted_max_units:r.max_units,execution_status:r.execution_status,deadline_at:r.deadline_at,events_url:`/v1/events?operation_id=${r.operation_id}`};
}
function invocationResult(op:Awaited<ReturnType<typeof getOperation>>) {return {operation_id:op.id,request_id:op.requests[0]?.id,quote_id:op.quote_id,accepted_max_units:op.accepted_max_units,execution_status:op.requests[0]?.execution_status??op.execution_status,deadline_at:op.deadline_at,events_url:`/v1/events?operation_id=${op.id}`};}
/** Financial authorization survives content deletion for native outcome reconciliation. */
export async function getSettlementContext(tx:Tx,scope:Scope,_clock:Clock,requestId:string,variant?:execution.RouteVariant) {
 await execution.getRequest(tx,scope,requestId);const auth=(await tx.query('SELECT * FROM request_authorizations WHERE request_id=$1',[requestId])).rows[0];if(!auth)throw new DomainError('not_found','Request authorization missing',404);
 const accepted=await published(tx,scope,variant?.rate_card_version_id??auth.component.rate_card_version_id,'rate_card');
 const current=(await tx.query("SELECT * FROM configuration_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3 AND kind='rate_card' AND status='published' AND (file_source IS NULL OR file_source->>'release_id' IN (SELECT release_id FROM configuration_activations WHERE organization_id=$1 AND application_id=$2)) ORDER BY version DESC LIMIT 1",[scope.organization_id,scope.application_id,accepted.key])).rows[0]??accepted;
 return {component:auth.component,accepted_rate_card:accepted.payload as RateCard,current_rate_card:current.payload as RateCard,accepted_rate_card_version_id:accepted.id,current_rate_card_version_id:current.id,accepted_at:auth.accepted_at};
}
export async function getExecutionContext(tx:Tx,scope:Scope,clock:Clock,requestId:string,variant?:execution.RouteVariant) {
 const context=await getSettlementContext(tx,scope,clock,requestId,variant);const request=await execution.getRequest(tx,scope,requestId);
 const input=await storage.getInput(tx,scope,clock,request.input_ref);return {...context,payload:input.content};
}
export async function amend(tx:Tx,scope:Scope,clock:Clock,input:{operation_id:string;quote_id:string;idempotency_key:string}) {
 await lock(tx,scope);const previous=await replay(tx,scope,'amend',input.idempotency_key,input);if(previous)return getOperation(tx,scope,clock,previous);
 const op=await rawOperation(tx,scope,input.operation_id,true);if(op.admission_status!=='open')throw new DomainError('operation_admission_closed');
 if((await rawQuote(tx,scope,op.quote_id)).kind==='pool')invalid('A reserve pool grows with its calls and is not amended');
 const quote=await rawQuote(tx,scope,input.quote_id);if(quote.for_operation_id!==op.id)invalid('Amendment quote must name operation');if(new Date(quote.expires_at)<=clock.now())throw new DomainError('quote_expired');
 if((await tx.query('SELECT 1 FROM quote_bindings WHERE quote_id=$1',[quote.id])).rowCount)throw new DomainError('quote_already_bound');
 if(op.external_project_id!==quote.external_project_id||op.project_generation!==quote.project_generation)invalid('Cannot change project binding');
 const usage=(await tx.query('SELECT component,count(*)::integer n FROM execution_requests WHERE operation_id=$1 GROUP BY component',[op.id])).rows;
 for(const used of usage){const updated=(quote.components as QuotedComponent[]).find(c=>c.key===used.component);if(!updated||updated.count_resolved<used.n)throw new DomainError('request_exceeds_recipe','Amendment excludes accepted work',422);}
 await availableRoutes(tx,scope,quote.components);
 const extraCalls=(quote.components as QuotedComponent[]).reduce((n,c)=>n+c.count_resolved,0)-(op.components as QuotedComponent[]).reduce((n,c)=>n+c.count_resolved,0);
 await checkAdmissionBackpressure(tx,scope,clock,extraCalls);
 const oldComponents=op.components as QuotedComponent[],newComponents=quote.components as QuotedComponent[];
 const subscriptions=[...new Set([...oldComponents,...newComponents].flatMap(c=>c.route.primary.allowance?[c.route.primary.allowance.subscription_id]:[]))].sort();
 await tx.query('SELECT id FROM provider_subscriptions WHERE id=ANY($1::text[]) AND organization_id=$2 AND application_id=$3 ORDER BY id FOR UPDATE',[subscriptions,scope.organization_id,scope.application_id]);
 for(const c of oldComponents){const used=usage.find(u=>u.component===c.key)?.n??0;for(const hold of (c.allowance_reservations??[]).slice(used))await releaseUnsentAllowance(tx,scope,clock,hold,'Operation amended');}
 for(const c of newComponents){const used=usage.find(u=>u.component===c.key)?.n??0;c.allowance_reservations=oldComponents.find(v=>v.key===c.key)?.allowance_reservations?.slice(0,used)??[];if(c.route.primary.allowance){const auth=c.route.primary.allowance;for(let i=used;i<c.count_resolved;i++)c.allowance_reservations[i]=(await new AllowanceService(tx,clock).reserve(scope,auth.subscription_id,`${op.id}:${quote.id}:${c.key}:${i}`,auth.demands)).id;}}
 const maximum=BigInt(quote.max_units),old=BigInt(op.accepted_max_units);
 if(maximum>old)await accounting.amendReservation(tx,scope,clock,{operation_id:op.id,additional_units:(maximum-old).toString(),idempotency_key:`amend:${quote.id}`});
 if(maximum<old)await accounting.reduceReservation(tx,scope,clock,{operation_id:op.id,new_max_units:quote.max_units,idempotency_key:`reduce:${quote.id}`});
 await tx.query('INSERT INTO quote_bindings(quote_id,operation_id,bound_at) VALUES($1,$2,$3)',[quote.id,op.id,clock.now()]);
 await tx.query('UPDATE operations SET quote_id=$2,components=$3,accepted_max_units=$4 WHERE id=$1',[op.id,quote.id,JSON.stringify(quote.components),quote.max_units]);
 await storage.bindInput(tx,scope,clock,quote.input_ref,{operation_id:op.id,external_project_id:op.external_project_id??undefined,project_generation:op.project_generation??undefined,expires_at:new Date(op.deadline_at)});
 if(quote.kind==='recipe')await storage.discardInput(tx,scope,clock,quote.input_ref);
 await remember(tx,scope,'amend',input.idempotency_key,input,op.id);await emit(tx,scope,'operation.amended',{type:'operation',id:op.id},{quote_id:quote.id,accepted_max_units:quote.max_units});return getOperation(tx,scope,clock,op.id);
}
/** Close abandoned admission at the accepted deadline; sent work still settles normally. */
export async function closeExpiredOperations(tx:Tx,clock:Clock,scope?:Scope):Promise<number> {
 if(!scope){const accounts=(await tx.query("SELECT DISTINCT organization_id,application_id,account_id FROM operations WHERE admission_status='open' AND deadline_at<=$1",[clock.now()])).rows;return forAvailableExecutionAccounts(tx,accounts,s=>closeExpiredOperations(tx,clock,s));}await lockExecutionAccount(tx,scope);
 const rows=(await tx.query("SELECT id,organization_id,application_id,account_id FROM operations WHERE admission_status='open' AND deadline_at<=$1 AND ($2::text IS NULL OR (organization_id=$2 AND application_id=$3 AND account_id=$4)) ORDER BY id",[clock.now(),scope?.organization_id??null,scope?.application_id??null,scope?.account_id??null])).rows;
 for(const row of rows)await cancel(tx,row,clock,{operation_id:row.id,idempotency_key:`deadline:${row.id}`});
 return rows.length;
}
