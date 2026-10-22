import type {ModelCalculation} from '../../../packages/model-pricing/src/index';
export interface DemoComponent {
 pricing_mode?:'quoted_final'|'estimated_actual';
 model_settings?:{id:string;provider?:string;preview?:boolean;live_validation?:string;service_mode?:string;text_features?:import('../../../packages/catalog/src/index').ModelDefinition['text_features'];parameters:ModelCalculation['parameters'];preparation:ModelCalculation['preparation']};
 billing?:{mode:'fixed';price_parameters:string[];prices:Array<{parameters:Record<string,string>;units:string}>};
 key:string;
 capability:'text.generate'|'image.generate';
 count:{constant:number};
 limits:{input_tokens?:number;output_tokens?:number;image_sizes?:string[];image_qualities?:string[];parameter_values?:Record<string,(string|number|boolean)[]>};
}
export interface DemoRecipe {key:string;version:number;definition:{components:DemoComponent[];inputs?:Record<string,unknown>}}
export function usableRecipes(rows:DemoRecipe[]):DemoRecipe[]{
 return rows.filter(row=>{
  const components=row.definition?.components;
  if(Object.keys(row.definition?.inputs??{}).length||!Array.isArray(components)||components.some(c=>c.count?.constant!==1))return false;
  if(components.length===1)return ['text.generate','image.generate'].includes(components[0].capability);
  return components.length===2&&components.some(c=>c.key==='description'&&c.capability==='text.generate')&&components.some(c=>c.key==='image'&&c.capability==='image.generate');
 });
}
export function latestRecipes(rows:DemoRecipe[]):DemoRecipe[]{
 const latest=new Map<string,DemoRecipe>();for(const row of rows)if(!latest.has(row.key)||latest.get(row.key)!.version<row.version)latest.set(row.key,row);return usableRecipes([...latest.values()]);
}
export function componentParameters(component:DemoComponent,overrides:Record<string,string|number|boolean>={}):Record<string,string|number|boolean>{
 if(component.model_settings){
  const parameters:Record<string,string|number|boolean>={};
  for(const [key,spec]of Object.entries(component.model_settings.parameters)){
   const raw=Object.hasOwn(overrides,key)?overrides[key]:spec.default;
   if(raw!==undefined)parameters[key]=spec.type==='number'?Number(raw):spec.type==='boolean'?raw===true||raw==='true':String(raw);
  }
  return parameters;
 }
 const limits=component.limits,parameters:Record<string,string|number|boolean>={};
 for(const [key,values] of Object.entries(limits.parameter_values??{}))if(values.length)parameters[key]=values[0];
 if(component.capability==='text.generate'){
  if(!Number.isSafeInteger(limits.output_tokens)||limits.output_tokens!<1)throw new Error('В профиле не задан допустимый предел ответа.');
  return {...parameters,max_output_tokens:Math.min(1000,limits.output_tokens!)};
 }
 if(!limits.image_sizes?.length||!limits.image_qualities?.length)throw new Error('В профиле не заданы параметры изображения.');
 return {...parameters,count:1,size:limits.image_sizes[0],quality:limits.image_qualities[0],...overrides};
}
export function componentInput(component:DemoComponent,prompt:string,assetIds:string[]=[]):Record<string,unknown>{return component.capability==='text.generate'?{messages:[{role:'user',content:assetIds.length?[{type:'text',text:prompt},...assetIds.map(asset_id=>({type:'image',asset_id}))]:prompt}]}:{prompt,...(assetIds.length?{asset_ids:assetIds}:{})};}

/** Friendly names are presentation only; selection and quoting always keep the recipe key. */
export function recipeLabel(recipe:DemoRecipe):string {
 const model=recipe.definition.components.length===1?recipe.definition.components[0].model_settings?.id:undefined;
 const preview=recipe.definition.components.some(c=>c.model_settings?.preview)?' · Preview':'';
 return model?model.replace(/-\d{4}-\d{2}-\d{2}$/,'').replace(/^gpt-/,'GPT ').replace(/image-/,'Image ').replace(/-(sunburst|flare|sol|terra)/g,(_,v:string)=>' '+v[0].toUpperCase()+v.slice(1)).replace(/-/g,' ')+preview:recipe.key;
}
export function primaryRecipes(recipes:DemoRecipe[],capability:string){return recipes.filter(r=>r.definition.components.length===1&&r.definition.components[0].capability===capability&&['quoted_final','estimated_actual'].includes(r.definition.components[0].pricing_mode??'')&&r.definition.components[0].model_settings);}
export function preferredRecipe(recipes:DemoRecipe[],capability:string){return primaryRecipes(recipes,capability)[0]??recipes.find(r=>r.definition.components.length===1&&r.definition.components[0].capability===capability);}
