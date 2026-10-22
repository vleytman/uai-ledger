import {writeFile,mkdir} from 'node:fs/promises';
import {embeddingCalculation,svgCalculation} from '../packages/model-pricing/src/logopanel-examples.js';
import {RECRAFT_STYLES,RECRAFT_VECTORIZE,QUIVER_MODELS} from '../packages/providers/src/svg-input.js';
import {embeddingModels} from '../packages/providers/src/embeddings.js';
import {validateModelCalculation} from '../packages/model-pricing/src/index.js';
import {parseConfiguration} from '../packages/configuration/src/index.js';
const checked='2026-09-25T00:00:00Z';
const models=[...Object.entries(embeddingModels).map(([model,m])=>({provider:m.provider,model,vector:false,embedding:true})),...[...RECRAFT_STYLES,RECRAFT_VECTORIZE].map(model=>({provider:'replicate',model,vector:model===RECRAFT_VECTORIZE,embedding:false})),...QUIVER_MODELS.flatMap(model=>[false,true].map(vector=>({provider:'quiver',model,vector,embedding:false})))];
await mkdir('configurations/ai/logopanel',{recursive:true});
for(const {provider,model,vector,embedding} of models){
 const short=model.replace('recraft-ai/','')+(provider==='quiver'&&vector?'-vectorize':''),key=`files.logopanel.${short}`,capability=embedding?'embeddings.generate':vector?'image.vectorize':'image.generate';
 const method=embedding?embeddingCalculation(model):svgCalculation(provider as 'quiver'|'replicate',model,vector);validateModelCalculation(method);
 const prices=provider==='quiver'?(model==='arrow-2'?['4','0.4','5','20']:['6','0.6','7.5','30']):embedding?[model.includes('small')?'0.02':model.includes('large')?'0.13':'0.06']:vector?['0.01']:model.includes('pro')?['0.12','0']:['0.05','0'];
 const source=provider==='quiver'?'https://docs.quiver.ai/developers/pricing':provider==='replicate'?`https://replicate.com/${model}`:provider==='voyage'?'https://docs.voyageai.com/docs/pricing':'https://developers.openai.com/api/docs/pricing';
 const rates=method.components.map((c,i)=>{if(c.result.kind!=='quantity')throw Error('quantity');return {id:c.key,dimension:c.result.dimension,unit:c.result.unit,unit_size:c.result.unit==='tokens'?'1000000':'1',amount:prices[i],effective_from:checked}});
 const document={schema_version:1,bundle_key:key,resources:[
 {kind:'rate_card',key:key+'.rates',payload:{id:key,currency:'USD',source:`${source}; checked 2026-09-25. Standard prices, no free allowance assumed. Recheck before publication.`,checked_at:checked,rates},samples:[{usage:{state:'known',items:rates.map(r=>({dimension:r.dimension,unit:r.unit,quantity:'1'}))},context:{at:checked,conditions:{model}}}]},
 {kind:'catalog',key:key+'.model',payload:{models:[{id:model,provider,adapter_ref:`${provider}@1`,identity_kind:'alias',capabilities:[capability],allowed_parameters:Object.keys(method.parameters),status:'active',calculation:method,rate_card_version_id:'@rate_card:'+key+'.rates'}]}},
 {kind:'route',key:key+'.route',payload:{capability,primary:{catalog_version_id:'@catalog:'+key+'.model',model,connection_id:'@connection:primary',max_cost_units:provider==='quiver'?'5000000000':embedding?'100000000':'200000000'},platform_risk_budget_units:provider==='quiver'?'10000000000':'1000000000'}},
 {kind:'recipe',key,payload:{period_budget_key:'@budget:period',execution:{max_attempts:1},components:[{key:'call',capability,route_version_id:'@route:'+key+'.route',rate_card_version_id:'@rate_card:'+key+'.rates',count:{constant:1},limits:{},pricing_mode:embedding?'estimated_actual':provider==='quiver'?'actual_capped':'quoted_final'}]}}
 ]};
 parseConfiguration(document);await writeFile(`configurations/ai/logopanel/${short}.json`,JSON.stringify(document,null,2)+'\n');
}
