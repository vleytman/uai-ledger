import {readFile} from 'node:fs/promises';
import {createPool,transaction} from '../packages/db/src/index.js';
import {CatalogService} from '../packages/catalog/src/index.js';
import {publishRecipe} from '../packages/quoting/src/index.js';
import {imagePresets,imageOutputTokens} from '../packages/quoting/src/openai-image-presets.js';
import {systemClock} from '../packages/contracts/src/index.js';
const pool=createPool();
try{const config=JSON.parse(await readFile('.data/demo-config.json','utf8'));const result=await transaction(pool,async tx=>{
 const scope=(await tx.query('SELECT organization_id,application_id,id account_id FROM accounts WHERE id=$1',[config.account_id])).rows[0];const catalog=new CatalogService(tx);const versions=await catalog.list(scope);
 const create=async(kind:any,key:string,payload:any,display_name?:string)=>{const draft=await catalog.createDraft(scope,{kind,key,version:Math.max(0,...versions.filter(v=>v.kind===kind&&v.key===key).map(v=>v.version))+1,payload,display_name,author:'fixed-image-pricing',comment:'Official OpenAI rates checked 2026-09-19; no markup; fixed base price includes input allowance'});const v=await catalog.publish(scope,draft.id,draft.revision,kind==='rate_card'?[{usage:{state:'known',items:payload.rates.map((r:any)=>({dimension:r.dimension,unit:r.unit,quantity:'1',conditions:r.conditions}))},context:{at:systemClock.now().toISOString()}}]:[]);versions.push(v);return v};
 const base=(await tx.query("SELECT * FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key='check.openai.image' ORDER BY version DESC LIMIT 1",[scope.organization_id,scope.application_id])).rows[0];if(!base)throw new Error('Existing demo OpenAI image profile required');
 const c=base.definition.components[0],route=versions.find(v=>v.id===c.route_version_id)!;
 const specs=[{key:'image2',model:'gpt-image-2-2026-04-21',quality:['low','medium','high']},{key:'sunburst',model:'gpt-image-2.5-sunburst-2026-09-08',quality:['low','medium','high','xhigh','max']},{key:'flare',model:'gpt-image-2.5-flare-2026-09-08',quality:['low','medium','high','xhigh','max']}];
 const models=await create('catalog','openai.fixed.images',{models:specs.map(s=>({id:s.model,provider:'openai',capabilities:['image.generate'],allowed_parameters:['size','quality','background','output_format'],status:'active'}))});
 const source='https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency';
 const card=await create('rate_card','openai.fixed.images.provider',{id:'openai-image-20260919',currency:'USD',source,checked_at:'2026-09-19T00:00:00Z',rates:[['input.uncached','text','5'],['input.cache_read','text','1.25'],['input.uncached','image','8'],['input.cache_read','image','2'],['output.image','image','30']].map(([dimension,modality,amount],i)=>({id:`r${i}`,dimension,conditions:{modality},unit:'tokens',unit_size:'1000000',amount,effective_from:'2026-09-19T00:00:00Z'}))},'OpenAI Image 2 / 2.5 provider costs');
 const presets=imagePresets(),sizes=[...new Set(presets.filter(p=>p.supported).map(p=>p.size))];const published=[];
 for(const spec of specs){
  const prices=sizes.flatMap(size=>spec.quality.map(quality=>{const tokens=imageOutputTokens(spec.model,size,quality);const maximum=tokens;const estimation={version:1 as const,tokenizer:'o200k_base' as const,source,rules:[{dimension:'input.uncached',unit:'tokens' as const,source:'input_tokens' as const,maximum:1000,conditions:{modality:'text'}},{dimension:'output.image',unit:'tokens' as const,source:'fixed' as const,maximum,conditions:{modality:'image'}}]};return {parameters:{size,quality},units:String(5000000+maximum*30000),estimation};}));
  const maximum=prices.reduce((a,b)=>BigInt(a.units)>BigInt(b.units)?a:b);const providerCap=maximum.units;
  const routing=await create('route',`openai.fixed.${spec.key}.route`,{...route.payload,primary:{...(route.payload as any).primary,catalog_version_id:models.id,model:spec.model,max_cost_units:providerCap},platform_risk_budget_units:String(BigInt(providerCap)*4n)});
  const key=`fixed.openai.${spec.key}`,previous=(await tx.query('SELECT max(version) version FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3',[scope.organization_id,scope.application_id,key])).rows[0].version??0;
  await publishRecipe(tx,scope,systemClock,{...base.definition,key,version:previous+1,actor_id:'fixed-image-pricing',components:[{key:'image',capability:'image.generate',route_version_id:routing.id,rate_card_version_id:card.id,count:{constant:1},limits:{image_count:1,max_assets:0,input_tokens:1000,image_sizes:sizes,image_qualities:spec.quality,parameter_values:{output_format:['png','jpeg','webp'],background:['opaque','transparent']}},conditions:{model:spec.model},estimation:maximum.estimation,billing:{mode:'fixed',price_parameters:['size','quality'],source:'Fixed base price from published output estimate plus 1000 input tokens; no markup. '+source,prices}}]});
  published.push({profile:key,model:spec.model,combinations:prices.length});
 }
 return {published,presets};
});console.log(JSON.stringify(result,null,2));}finally{await pool.end()}
