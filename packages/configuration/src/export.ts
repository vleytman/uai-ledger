import {DomainError,hash} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';
import type {CatalogScope} from '../../catalog/src/index.js';
import {parseConfiguration,type Bindings} from './index.js';
import type {AdoptionBaseline} from './adoption.js';
/** Export configuration only. Runtime settings and credentials never enter the document. */
export async function exportLegacyConfiguration(tx:Tx,scope:CatalogScope,bundleKey:string){
 const versions=(await tx.query('SELECT * FROM configuration_versions WHERE organization_id=$1 AND application_id=$2 ORDER BY version DESC',[scope.organization_id,scope.application_id])).rows;
 const recipes=(await tx.query('SELECT DISTINCT ON(key) * FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 ORDER BY key,version DESC',[scope.organization_id,scope.application_id])).rows.filter(r=>!r.file_source);
 const byId=new Map(versions.map(v=>[v.id,v])),selected=new Map<string,any>(),names=new Map<string,string>(),bindings:Bindings={connections:{},budgets:{}};
 const baselines:AdoptionBaseline[]=[],resources:any[]=[];
 const baseline=(row:any,kind:AdoptionBaseline['kind'])=>({kind,key:row.key,id:row.id,hash:hash(JSON.parse(JSON.stringify(row)))});
 const select=(id:string,kind:string):string=>{
  const row=byId.get(id);if(!row||row.kind!==kind||row.status!=='published')throw new DomainError('export_dependency_missing',`${kind} dependency missing`);
  if(row.file_source)throw new DomainError('export_file_dependency','Export legacy profiles separately from existing file bundles');
  if(selected.has(id))return `@${kind}:${names.get(id)}`;
  const latest=versions.find(v=>v.kind===kind&&v.key===row.key),name=latest?.id===id?row.key:`${row.key}.history.v${row.version}`;
  names.set(id,name);selected.set(id,row);
  const payload=structuredClone(row.payload);
  if(kind==='catalog')for(const model of payload.models){model.adapter_ref??=`${model.provider}@1`;if(model.rate_card_version_id)model.rate_card_version_id=select(model.rate_card_version_id,'rate_card');}
  if(kind==='route')for(const target of [payload.primary,...(payload.fallback?[payload.fallback]:[])]){
   target.catalog_version_id=select(target.catalog_version_id,'catalog');const symbol=Object.entries(bindings.connections).find(([,v])=>v===target.connection_id)?.[0]??`connection${Object.keys(bindings.connections).length+1}`;bindings.connections[symbol]=target.connection_id;target.connection_id=`@connection:${symbol}`;
  }
  const resource:any={kind,key:name,...(row.display_name?{display_name:row.display_name}:{}),payload};
  if(kind==='rate_card')resource.samples=payload.rates.map((r:any)=>({usage:{state:'known',items:[{dimension:r.dimension,unit:r.unit,quantity:'1',...(r.conditions?{conditions:r.conditions}:{})}]},context:{at:r.effective_from,...(r.conditions?{conditions:r.conditions}:{})}}));
  resources.push(resource);if(name===row.key)baselines.push(baseline(row,kind as AdoptionBaseline['kind']));return `@${kind}:${name}`;
 };
 for(const row of recipes){
  const payload=structuredClone(row.definition);delete payload.key;delete payload.version;delete payload.actor_id;
  const symbol=Object.entries(bindings.budgets).find(([,v])=>v===payload.period_budget_key)?.[0]??`period${Object.keys(bindings.budgets).length+1}`;bindings.budgets[symbol]=payload.period_budget_key;payload.period_budget_key=`@budget:${symbol}`;
  for(const c of payload.components){c.route_version_id=select(c.route_version_id,'route');c.rate_card_version_id=select(c.rate_card_version_id,'rate_card');}
  resources.push({kind:'recipe',key:row.key,payload});baselines.push(baseline(row,'recipe'));
 }
 if(!recipes.length)throw new DomainError('no_legacy_profiles');
 return {document:parseConfiguration({schema_version:1,bundle_key:bundleKey,resources}),bindings,baselines};
}
