import {canonical,DomainError,type Clock} from '../../contracts/src/index.js';
import type {SqlExecutor} from '../../db/src/index.js';
import {getAttemptUsage,rateUsage,type RateCard,type RatingContext} from '../../pricing/src/index.js';
import type {BillableItem,UsageConditions} from '../../providers/src/contracts.js';
import type {CatalogScope,ConfigurationVersion,RouteDefinition} from './index.js';

function baseItems(capability:string):BillableItem[]{
 const pairs:Record<string,string[][]>={'embeddings.generate':[['input.uncached','tokens']],'text.generate':[['input.uncached','tokens'],['output.text','tokens']],'image.generate':[['output.image','images']],'image.vectorize':[['output.image','images']],'image.edit':[['output.image','images']],'speech.synthesize':[['audio.characters','characters']],search:[['tool.search','calls']]};
 return (pairs[capability]??[]).map(([dimension,unit])=>({dimension,unit,quantity:'1'}));
}
function contexts(component:any):UsageConditions[]{
 const bounds:Record<string,unknown[]>={...(component.limits?.parameter_values??{}),...(component.limits?.image_sizes?{size:component.limits.image_sizes}:{}),...(component.limits?.image_qualities?{quality:component.limits.image_qualities}:{})};
 let result:UsageConditions[]=[component.conditions??{}];
 for(const [key,values] of Object.entries(bounds)){if(!Array.isArray(values)||!values.length||result.length*values.length>4096)throw new DomainError('pricing_coverage_bounds','Pricing condition combinations exceed the supported bound',422);result=result.flatMap(context=>values.map(value=>({...context,[key]:value!==null&&typeof value==='object'?canonical(value):String(value)})));}
 return result;
}
/** Coverage follows immutable recipe rate-profile bindings. Unbound routes use capability matching. */
export async function verifyPublicationCoverage(db:SqlExecutor,scope:CatalogScope,version:ConfigurationVersion,clock:Clock){
 const card=version.payload as RateCard;
 const configurations=(await db.query<ConfigurationVersion>("SELECT * FROM configuration_versions WHERE organization_id=$1 AND application_id=$2 AND status='published'",[scope.organization_id,scope.application_id])).rows;
 const recipes=(await db.query('SELECT definition FROM recipe_versions WHERE organization_id=$1 AND application_id=$2',[scope.organization_id,scope.application_id])).rows;
 const cards=new Map(configurations.filter(v=>v.kind==='rate_card').map(v=>[v.id,v]));
 const components=recipes.flatMap(r=>r.definition.components as any[]);
 const boundIds=new Set(components.map(c=>c.route_version_id));
 const selectedComponents=components.filter(c=>cards.get(c.rate_card_version_id)?.key===version.key);
 const selectedIds=new Set(selectedComponents.map(c=>c.route_version_id));
 const routes=configurations.filter(v=>v.kind==='route'&&(selectedIds.has(v.id)||(!boundIds.has(v.id)&&baseItems((v.payload as RouteDefinition).capability).some(i=>card.rates.some(r=>r.dimension===i.dimension&&r.unit===i.unit)))));
 // Test each interval at its start, including the first supported future interval.
 const start=Math.max(clock.now().getTime(),Math.min(...card.rates.map(r=>Date.parse(r.effective_from))));
 const times=[...new Set([start,...card.rates.flatMap(r=>[Date.parse(r.effective_from),...(r.effective_to?[Date.parse(r.effective_to)]:[])]).filter(t=>t>=start)])].sort((a,b)=>a-b);
 const check=(items:BillableItem[],context:Omit<RatingContext,'at'>,source:string)=>{for(const time of times){const result=rateUsage({state:'known',items},card,{...context,at:new Date(time).toISOString()});if(result.state!=='calculated')throw new DomainError('rate_coverage_missing',`${source}: ${result.reason} at ${new Date(time).toISOString()}`,422);}};
 const targets=new Set<string>();
 for(const row of routes){const route=row.payload as RouteDefinition;const registered=selectedComponents.filter(c=>c.route_version_id===row.id);for(const target of [route.primary,...(route.fallback?[route.fallback]:[])]){
  const catalog=configurations.find(v=>v.id===target.catalog_version_id&&v.kind==='catalog');
  const model=(catalog?.payload as any)?.models?.find((m:any)=>m.id===target.model);
  const modelItems:BillableItem[]=model?.api?model.api.measurements.map((m:any)=>({dimension:m.key,unit:m.unit,quantity:m.maximum})):model?.calculation?.components?.filter((c:any)=>c.result.kind==='quantity').map((c:any)=>({dimension:c.result.dimension,unit:c.result.unit,quantity:c.maximum,conditions:c.result.conditions}))??[];
  const defaults=modelItems.length?modelItems:baseItems(route.capability);
  targets.add(`${target.connection_id}\u0000${target.model}`);
  if(!registered.length)check(defaults,{connection_id:target.connection_id,conditions:{model:target.model}},`route ${row.id}`);
  for(const component of registered)for(const condition of contexts(component))check((component.estimation?.rules?.map((r:any)=>({dimension:r.dimension,unit:r.unit,quantity:String(r.maximum),conditions:r.conditions}))??component.maximum_items??defaults).map((item:BillableItem)=>({...item,conditions:{...item.conditions,...condition}})),{connection_id:target.connection_id,conditions:{...condition,model:target.model}},`recipe component ${component.key}`);
 }}
 // Replay authoritative known usage, including new cache/quality dimensions absent from recipes.
 // Unknown observations are not coverage evidence and remain unknown in accounting.
 const observations=(await db.query('SELECT DISTINCT ON(account_id,attempt_id) account_id,attempt_id,connection_id,model FROM provider_usage_observations WHERE organization_id=$1 AND application_id=$2 ORDER BY account_id,attempt_id,revision DESC,observed_at DESC',[scope.organization_id,scope.application_id])).rows;
 for(const row of observations){if(!targets.has(`${row.connection_id}\u0000${row.model}`))continue;const usage=await getAttemptUsage(db,{...scope,account_id:row.account_id},row.attempt_id);if(usage.state==='known')check(usage.items,{connection_id:row.connection_id,conditions:{model:row.model}},`saved usage ${row.attempt_id}`);}
}
