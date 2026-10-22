/** Human labels are presentation only. Immutable configuration keys remain unchanged. */
export function modelLabel(id:string):string {
 return id.replace(/-\d{4}-\d{2}-\d{2}$/,'').replace(/^gpt-/,'GPT-').replace(/image-/,'Image ').replace(/-(sunburst|flare|sol|terra)/g,(_,v:string)=>' '+v[0].toUpperCase()+v.slice(1)).replace(/-(nano|mini)/g,' $1');
}
const demoModels:Record<string,string>={image2:'GPT-Image 2',sunburst:'GPT-Image 2.5 Sunburst',flare:'GPT-Image 2.5 Flare',sol:'GPT-5.6 Sol',terra:'GPT-5.6 Terra',nano:'GPT-4.1 nano',gpt41:'GPT-4.1'};
export function configurationLabel(row:any):string {
 if(row.display_name?.trim())return /^gpt-/.test(row.display_name)?modelLabel(row.display_name):row.display_name;
 const key=String(row.key??'');
 const central=key.match(/^central\.([^.]+)\.provider-rates$/);
 if(central&&demoModels[central[1]])return `${demoModels[central[1]]} · provider costs`;
 const known:Record<string,string>={
  'central.model-pricing.examples':'OpenAI models · demo',
  'openai.fixed.images':'OpenAI image models · fixed prices',
  'qa.model-pricing.admin':'Pricing editor · test models',
  'fixture-models':'Local test models',
  'fixture-pricing':'Local test prices',
  'check.openai.models':'OpenAI models · initial tests',
  'check.openai.precise.models':'OpenAI models · usage estimates',
  'check.cartesia.single.catalog':'Cartesia · speech models',
  'check.cartesia.single.rates':'Cartesia · speech pricing',
  'check.serper.single.catalog':'Serper · search models',
  'check.serper.single.rates':'Serper · search pricing',
 };
 if(known[key])return known[key];
 if(row.payload?.models){const names=row.payload.models.map((m:any)=>modelLabel(m.id));return names.length<=2?names.join(' / '):`${names.slice(0,2).join(' / ')} + ${names.length-2} models`;}
 const models=[...new Set<string>((row.payload?.rates??[]).map((r:any)=>r.conditions?.model).filter(Boolean))];
 if(models.length)return `${models.map(modelLabel).join(' / ')} · provider costs`;
 return key.replace(/[._-]+/g,' ').replace(/^./,v=>v.toUpperCase());
}
export function currentConfigurationVersions(rows:any[]){
 const latest=new Map<string,number>();
 for(const r of rows)if(r.status==='published')latest.set(r.key,Math.max(latest.get(r.key)??0,r.version));
 return rows.filter(r=>r.status!=='published'||r.file_active===true||r.version===latest.get(r.key));
}

/** Known local fixtures and QA catalogs are hidden, not deleted. */
export function isTestConfiguration(row:any):boolean {
 const payload=row.payload??{};
 return /^(fixture(?:[.-]|$)|qa[.-])/.test(String(row.key??'')) ||
  (payload.models?.length>0 && payload.models.every((model:any)=>model.provider==='fake')) ||
  /synthetic fixture/i.test(String(payload.source??''));
}
const providerNames:Record<string,string>={openai:'OpenAI',anthropic:'Anthropic',cartesia:'Cartesia',serper:'Serper',fake:'Local test adapter'};
export function configurationProvider(row:any,view:string,connections:any[],routes:any[]):string {
 const connectionMap=new Map(connections.map(connection=>[connection.id,connection.provider]));
 const routeMap=new Map(routes.map(route=>[route.id,route]));
 const providersForRoute=(route:any):string[]=>{
  const payload=route?.payload??{};
  const variants=[payload.primary,payload.fallback].filter(Boolean);
  return variants.length?variants.map(variant=>connectionMap.get(variant.connection_id)??'Unknown provider'):['Unknown provider'];
 };
 const providers=view==='routes'?providersForRoute(row):(row.definition??row.payload)?.components?.flatMap((component:any)=>providersForRoute(routeMap.get(component.route_version_id)))??[];
 const names=[...new Set<string>(providers)].map(provider=>providerNames[provider]??provider).sort();
 return names.length>1?'Multiple providers · '+names.join(' / '):names[0]??'Unknown provider';
}
