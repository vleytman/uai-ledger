import {readFile} from 'node:fs/promises';
import {createPool,transaction} from '../packages/db/src/index.js';
import {CatalogService} from '../packages/catalog/src/index.js';
import {publishRecipe} from '../packages/quoting/src/index.js';
import {systemClock} from '../packages/contracts/src/index.js';
const pool=createPool();
try{const conf=JSON.parse(await readFile('.data/demo-config.json','utf8'));
const result=await transaction(pool,async tx=>{
 const scope=(await tx.query('SELECT organization_id,application_id,id account_id FROM accounts WHERE id=$1',[conf.account_id])).rows[0];if(!scope)throw new Error('Demo account missing');
 const catalog=new CatalogService(tx);const versions=await catalog.list(scope);
 const create=async(kind:any,key:string,payload:any,display_name?:string)=>{const version=Math.max(0,...versions.filter(v=>v.kind===kind&&v.key===key).map(v=>v.version))+1;const draft=await catalog.createDraft(scope,{kind,key,version,payload,display_name,author:'precise-estimation',comment:'Проверены официальные ставки 2026-09-19; версия оценки 1'});const published=await catalog.publish(scope,draft.id,draft.revision,kind==='rate_card'?[{usage:{state:'known',items:payload.rates.map((r:any)=>({dimension:r.dimension,unit:r.unit,quantity:'1'}))},context:{at:systemClock.now().toISOString()}}]:[]);versions.push(published);return published};
 const recipes=(await tx.query('SELECT DISTINCT ON(key) * FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 ORDER BY key,version DESC',[scope.organization_id,scope.application_id])).rows;
 const base=recipes.find(r=>r.key==='check.openai.text');if(!base)throw new Error('Existing OpenAI profile required');
 const baseComponent=base.definition.components[0],baseRoute=versions.find(v=>v.id===baseComponent.route_version_id)!;
 const oldModels=versions.find(v=>v.id===(baseRoute.payload as any).primary.catalog_version_id)!;
 const models=await create('catalog','check.openai.precise.models',{models:[...(oldModels.payload as any).models,...['gpt-4.1-nano-2025-04-14','gpt-4.1-2025-04-14'].map(id=>({id,provider:'openai',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'}))]});
 const textPolicy=(limit=1000,output=128)=>({version:1,tokenizer:'o200k_base',source:'https://developers.openai.com/api/docs/models/gpt-4.1; expected output is a configurable 64-token assumption',rules:[{dimension:'input.uncached',unit:'tokens',source:'input_tokens',maximum:limit},{dimension:'output.text',unit:'tokens',source:'output_tokens',maximum:output,expected:Math.min(64,output)}]});
 const imagePolicy={version:1,tokenizer:'o200k_base',source:'https://developers.openai.com/api/docs/guides/image-generation#models-prior-to-gpt-image-2; Mini model page low square 0.005 USD retained as 625-token ceiling',rules:[{dimension:'input.uncached',unit:'tokens',source:'input_tokens',maximum:12000,conditions:{modality:'text'}},{dimension:'input.uncached',unit:'tokens',source:'fixed',maximum:0,conditions:{modality:'image'}},{dimension:'output.image',unit:'tokens',source:'fixed',maximum:625,expected:272,conditions:{modality:'image'}}]};
 const updated=[];
 for(const r of recipes.filter(r=>['check.openai.text','check.openai.image','check.openai.description-image'].includes(r.key))){
  const def=structuredClone(r.definition);def.version=r.version+1;def.actor_id='precise-estimation';
  for(const c of def.components){if(c.capability==='text.generate')c.estimation=textPolicy(c.limits.input_tokens,c.limits.output_tokens);else {if(JSON.stringify(c.limits.image_sizes)!=='["1024x1024"]'||JSON.stringify(c.limits.image_qualities)!=='["low"]')throw new Error('Image table applies only to low square');c.estimation=imagePolicy;} }
  await publishRecipe(tx,scope,systemClock,def);updated.push({key:def.key,version:def.version});
 }
 for(const model of [{key:'nano',id:'gpt-4.1-nano-2025-04-14',input:'0.10',cache:'0.025',output:'0.40'},{key:'full',id:'gpt-4.1-2025-04-14',input:'2.00',cache:'0.50',output:'8.00'}]){
  const card=await create('rate_card',`check.openai.${model.key}.prices`,{id:`openai-${model.key}-20260919`,currency:'USD',source:`https://developers.openai.com/api/docs/models/${model.key==='nano'?'gpt-4.1-nano':'gpt-4.1'}`,checked_at:systemClock.now().toISOString(),rates:[['input.uncached',model.input],['input.cache_read',model.cache],['output.text',model.output]].map(([dimension,amount])=>({id:dimension,dimension,unit:'tokens',unit_size:'1000000',amount,effective_from:'2026-09-19T00:00:00Z'}))},model.id);
  const route=await create('route',`check.openai.${model.key}.route`,{...structuredClone(baseRoute.payload),primary:{...(baseRoute.payload as any).primary,catalog_version_id:models.id,model:model.id,max_cost_units:'5000000'}});
  const key=`check.openai.${model.key}`,prior=recipes.find(r=>r.key===key);await publishRecipe(tx,scope,systemClock,{...structuredClone(base.definition),key,version:(prior?.version??0)+1,actor_id:'precise-estimation',components:[{...structuredClone(baseComponent),route_version_id:route.id,rate_card_version_id:card.id,conditions:{model:model.id},estimation:textPolicy()}]});updated.push({key,model:model.id});
 }
 return updated;
});console.log(JSON.stringify(result));}finally{await pool.end()}
