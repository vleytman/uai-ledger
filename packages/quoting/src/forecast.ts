import type {z} from 'zod';
import {ForecastBody,ForecastResponse} from '../../contracts/forecast.js';
import {CREDIT_UNIT,DomainError,type Clock,type Scope} from '../../contracts/src/index.js';
import type {SqlExecutor} from '../../db/src/index.js';
import {CatalogService,type CatalogDefinition,type RouteDefinition} from '../../catalog/src/index.js';
import {Rational,normalizeParameters} from '../../model-pricing/src/index.js';
import {rateUsage,type RateCard} from '../../pricing/src/index.js';
import type {RecipeDefinition} from './index.js';
import {fixedPrice} from './fixed-pricing.js';
function fail(message:string):never{throw new DomainError('forecast_unavailable',message,422)}
/** Read-only: deliberately does not call quote creation, input preparation, allowance or wallet code. */
export async function forecastCalls(db:SqlExecutor,scope:Scope,clock:Clock,body:z.input<typeof ForecastBody>):Promise<z.infer<typeof ForecastResponse>>{
 const input=ForecastBody.parse(body),at=clock.now().toISOString(),catalog=new CatalogService(db,clock);
 if(input.account_id!==scope.account_id)throw new DomainError('not_found','Account not found',404);
 const config=async(id:string,kind:string)=>{const value=await catalog.get(scope,id);if(value.kind!==kind||value.status!=='published')fail('Published configuration required');return value;};
 const calls:z.infer<typeof ForecastResponse>['calls']=[];
 for(const call of input.calls){
  const row=(await db.query(`SELECT * FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3
   AND (file_source IS NULL OR file_source->>'release_id' IN (SELECT release_id FROM configuration_activations WHERE organization_id=$1 AND application_id=$2))
   AND ($4::integer IS NULL OR version=$4) ORDER BY version DESC LIMIT 1`,[scope.organization_id,scope.application_id,call.profile,call.version??null])).rows[0];
  if(!row)fail('Published profile not found');
  const definition=row.definition as RecipeDefinition,component=definition.components[0];
  if(definition.components.length!==1||!('constant' in component.count)||component.count.constant!==1)fail('Only single-call profiles are supported');
  const routeVersion=await config(component.route_version_id,'route'),route=routeVersion.payload as RouteDefinition;
  const modelVersion=await config(route.primary.catalog_version_id,'catalog'),model=(modelVersion.payload as CatalogDefinition).models.find(m=>m.id===route.primary.model&&m.status==='active');
  if(!model)fail('Active model required');
  const method=model!.calculation,params=method?normalizeParameters(method,call.parameters??{}):call.parameters??{};
  const rateVersion=await config(model!.rate_card_version_id??component.rate_card_version_id,'rate_card'),card=rateVersion.payload as RateCard;
  const required=method?.components.flatMap(c=>c.result.kind==='quantity'?[c.result]:[])??component.maximum_items;
  if(method?.components.some(c=>c.result.kind==='usd'))fail('This profile requires a concrete input for its USD formula');
  if(!required?.length)fail('Profile does not declare billable volumes');
  const keys=new Set(call.volumes.map(v=>JSON.stringify([v.dimension,v.unit,v.conditions??{}])));
  if(keys.size!==call.volumes.length||!call.volumes.some(v=>BigInt(v.quantity)>0n))fail('Expected volumes must be distinct and nonzero in aggregate');
  const pairs=new Set(required.map(v=>`${v.dimension}:${v.unit}`));
  for(const volume of call.volumes)if(!pairs.has(`${volume.dimension}:${volume.unit}`))fail('Volume is not declared by the profile');
  for(const requiredItem of required)if(!call.volumes.some(v=>v.dimension===requiredItem.dimension&&v.unit===requiredItem.unit))fail(`Missing volume ${requiredItem.dimension}`);
  let heuristic=false;
  const ranges=call.volumes.map(v=>{
   const q=BigInt(v.quantity),variable=v.unit==='tokens';if(variable&&(v.low===undefined||v.high===undefined))heuristic=true;
   const low=v.low===undefined?(variable?q/2n:q):BigInt(v.low),high=v.high===undefined?(variable?q*2n:q):BigInt(v.high);
   if(low>q||high<q||high>9223372036854775807n)fail('Expected quantity must lie inside its range');
   return {...v,low:low.toString(),high:high.toString()};
  });
  const provider_cost={expected_units:'0',low_units:'0',high_units:'0'},customer_charge={...provider_cost};
  for(const [output,quantity] of [['expected_units','quantity'],['low_units','low'],['high_units','high']] as const){
   const rated=rateUsage({state:'known',items:ranges.map(v=>({dimension:v.dimension,unit:v.unit,quantity:v[quantity],conditions:v.conditions}))},card,{at,connection_id:route.primary.connection_id,conditions:{...Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)])),...component.conditions,model:model!.id}},'ceil');
   if(rated.state!=='calculated')fail(rated.reason);
   if(rated.state!=='calculated')throw Error('unreachable');
   provider_cost[output]=(rated.rounded_units*BigInt(call.count)).toString();
   let charge=Rational.from(rated.exact_amount).mul(Rational.from('1000000000'));
   if(component.billing)charge=Rational.from(fixedPrice(component.billing,params).units);
   else if(method){charge=charge.mul(Rational.from('1').add(Rational.from(method.pricing.markup_percent).div(Rational.from('100'))));if(component.pricing_mode==='quoted_final')charge=charge.mul(Rational.from(method.pricing.safety_factor));}
   customer_charge[output]=(charge.round(Rational.from(method?.pricing.rounding_units??'1'),'ceil').integer()*BigInt(call.count)).toString();
  }
  const reasons=['caller_supplied_volumes',...(heuristic?['heuristic_token_range']:[]),...(model!.identity_kind==='alias'?['model_alias_revision_unknown']:[]),...(route.fallback?['fallback_not_included']:[])];
  const category=heuristic||method?.verification==='approximate'?'low' as const:'modeled' as const;
  calls.push({profile:call.profile,version:row.version,count:call.count,model:model!.id,provider:model!.provider,versions:{profile_id:row.id,route_id:routeVersion.id,catalog_id:modelVersion.id,rate_card_id:rateVersion.id},provider_cost,customer_charge,confidence:{category,reasons},assumptions:['One successful attempt per call; retries and technical defects are excluded.','Published rates at estimated_at; no provider discount or allowance benefit inferred.',...(heuristic?['Unspecified token ranges use half to twice the expected volume.']:[]),...(component.pricing_mode==='quoted_final'?['Final-price profile applies safety factor and markup to the caller-supplied quantities.']:[])]});
 }
 const total=(key:'provider_cost'|'customer_charge')=>Object.fromEntries(['expected_units','low_units','high_units'].map(field=>[field,calls.reduce((sum,call)=>sum+BigInt(call[key][field as keyof typeof call.provider_cost]),0n).toString()]));
 return ForecastResponse.parse({credit_unit_id:CREDIT_UNIT,currency:'USD',estimated_at:at,method_version:'lf-forecast-1',range_is_charge_cap:false,provider_cost:total('provider_cost'),customer_charge:total('customer_charge'),confidence:{category:calls.some(c=>c.confidence.category==='low')?'low':'modeled',reasons:[...new Set(calls.flatMap(c=>c.confidence.reasons))]},assumptions:['No reservation or spending authorization. The range is a forecast, not a guaranteed maximum charge.'],calls});
}
