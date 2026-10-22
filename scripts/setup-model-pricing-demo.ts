import {readFile} from 'node:fs/promises';
import {createPool,transaction} from '../packages/db/src/index.js';
import {CatalogService,type ConfigurationKind,type ConfigurationPayload,type RouteDefinition,type CatalogDefinition} from '../packages/catalog/src/index.js';
import {publishRecipe,type RecipeDefinition} from '../packages/quoting/src/index.js';
import {demoModels} from '../packages/model-pricing/src/demo-models.js';
import {Rational,type ModelCalculation} from '../packages/model-pricing/src/index.js';
import {rateUsage,type RateCard} from '../packages/pricing/src/index.js';
import {systemClock} from '../packages/contracts/src/index.js';
if(process.env.UAI_ENV!=='test')throw new Error('This setup is only for the local test installation');
const database=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(database.hostname)||database.pathname!=='/uai_local')throw new Error('Only the local uai_local test database is permitted');
const pool=createPool();
try {
 const conf=JSON.parse(await readFile('.data/demo-config.json','utf8'));
 const result=await transaction(pool,async tx=>{
  const scope=(await tx.query('SELECT organization_id,application_id,id account_id FROM accounts WHERE id=$1',[conf.account_id])).rows[0];
  if(!scope)throw new Error('Demo account not found');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${scope.organization_id}:${scope.application_id}:central-demo-models`]);
  const catalog=new CatalogService(tx),versions=await catalog.list(scope);
  const create=async(kind:ConfigurationKind,key:string,payload:ConfigurationPayload)=>{
   const draft=await catalog.createDraft(scope,{kind,key,version:Math.max(0,...versions.filter(v=>v.kind===kind&&v.key===key).map(v=>v.version))+1,payload,...(kind==='catalog'?{display_name:'OpenAI models · demo'}:kind==='rate_card'?{display_name:((payload as RateCard).id.replace(/^demo\./,'').replace(/-\d{4}-\d{2}-\d{2}$/,'').replace(/^gpt-/,'GPT-').replace(/image-/,'Image ').replace(/-(sunburst|flare|sol|terra|nano)/g,(_,v:string)=>' '+(v==='nano'?v:v[0].toUpperCase()+v.slice(1))))+' · provider costs'}:{}),author:'model-pricing-demo',comment:'Central per-model calculation; owner-selected safety 1.1 and markup 100%. No paid requests.'});
   const published=await catalog.publish(scope,draft.id,draft.revision,kind==='rate_card'?[{usage:{state:'known',items:(payload as RateCard).rates.map(r=>({dimension:r.dimension,unit:r.unit,quantity:'1',conditions:r.conditions}))},context:{at:systemClock.now().toISOString()}}]:[]);versions.push(published);return published;
  };
  const baseRecipe=async(key:string)=>{const row=(await tx.query('SELECT definition FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3 ORDER BY version DESC LIMIT 1',[scope.organization_id,scope.application_id,key])).rows[0];if(!row)throw new Error(`Missing base profile ${key}`);return row.definition as RecipeDefinition};
  const imageBase=await baseRecipe('fixed.openai.sunburst'),textBase=await baseRecipe('check.openai.nano');
  const specs:Array<ReturnType<typeof demoModels>[number]&{base:RecipeDefinition;cardId:string}>=[];
  for(const model of demoModels().filter(m=>!process.argv.includes('--text-only')||m.capability==='text.generate')){
   const card=await create('rate_card',`central.${model.key}.provider-rates`,model.card);
   specs.push({...model,base:model.capability==='image.generate'?imageBase:textBase,cardId:card.id});
  }
  const previousModels=process.argv.includes('--text-only')?(versions.filter(v=>v.kind==='catalog'&&v.key==='central.model-pricing.examples'&&v.status==='published').sort((a,b)=>b.version-a.version)[0]?.payload as CatalogDefinition|undefined)?.models.filter(m=>!specs.some(s=>s.id===m.id))??[]:[];
  const models=await create('catalog','central.model-pricing.examples',{models:[...previousModels,...specs.map(s=>({id:s.id,provider:s.provider,capabilities:[s.capability],status:'active' as const,identity_kind:s.identity_kind,allowed_parameters:Object.keys(s.method.parameters),calculation:s.method,rate_card_version_id:s.cardId}))]});
  const published=[];
  for(const spec of specs){
   const card=versions.find(v=>v.id===spec.cardId)!.payload as RateCard;
   let maximum=Rational.from('0');
   for(const c of (spec.method as ModelCalculation).components){if(c.result.kind==='usd'){maximum=maximum.add(Rational.from(c.maximum));continue}const rated=rateUsage({state:'known',items:[{dimension:c.result.dimension,unit:c.result.unit,quantity:c.maximum,conditions:c.result.conditions}]},card,{at:systemClock.now().toISOString(),conditions:{model:spec.id}});if(rated.state!=='calculated')throw new Error(rated.reason);maximum=maximum.add(Rational.from(rated.exact_amount));}
   // Explicit platform exposure allowance is separate from the customer's price and model markup.
   const cap=maximum.mul(Rational.from('2000000000')).ceil();
   const previousRoute=versions.find(v=>v.id===spec.base.components[0].route_version_id)!.payload as RouteDefinition;
   const target=(t:RouteDefinition['primary'])=>({...t,catalog_version_id:models.id,model:spec.id,max_cost_units:cap.toString()});
   const route=await create('route',`central.${spec.key}.route`,{...previousRoute,primary:target(previousRoute.primary),...(previousRoute.fallback?{fallback:target(previousRoute.fallback)}:{}),platform_risk_budget_units:(cap*4n).toString()});
   const key=`priced.openai.${spec.key}`,version=1+Number((await tx.query('SELECT COALESCE(max(version),0) v FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3',[scope.organization_id,scope.application_id,key])).rows[0].v);
   await publishRecipe(tx,scope,systemClock,{key,version,period_budget_key:spec.base.period_budget_key,actor_id:'model-pricing-demo',components:[{key:spec.capability==='text.generate'?'text':'image',capability:spec.capability,route_version_id:route.id,rate_card_version_id:'',count:{constant:1},limits:{},pricing_mode:spec.capability==='text.generate'?'estimated_actual':'quoted_final'}]});
   published.push({profile:key,version,model:spec.id,components:spec.method.components.length,table_rows:spec.method.components.find(c=>c.type==='lookup')?.rows.length??0,safety_factor:spec.method.pricing.safety_factor,markup_percent:spec.method.pricing.markup_percent});
  }
  return {catalog_version_id:models.id,published};
 });console.log(JSON.stringify(result,null,2));
}finally{await pool.end()}
