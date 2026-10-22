/** Reviewed inert profiles; publication and account bindings are separate operations. */
import {calculateQuantities,type ModelCalculation} from './index.js';
import {alternativeModel,alternativeFeatures,alternativeModels} from '../../providers/src/alternative-models.js';
import type {RateCard} from '../../pricing/src/index.js';
import type {FileConfiguration} from '../../configuration/src/index.js';
const checked='2026-09-25T00:00:00Z';
export function alternativeRates(provider:string,id:string):RateCard{
 const m=alternativeModel(provider,id),cloud=provider==='google_cloud';
 return {id:`ami.${provider}.${id.replaceAll('/','.')}`,currency:'USD',source:provider==='cerebras'?'https://api.cerebras.ai/public/v1/models; https://inference-docs.cerebras.ai/capabilities/prompt-caching':provider==='groq'?'https://console.groq.com/docs/models; https://console.groq.com/docs/prompt-caching':'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing',checked_at:checked,rates:[['input.uncached',m.inputRate],['output.text',m.outputRate],...(provider==='cerebras'?[['input.cache_read',m.inputRate]]:cloud?[['input.cache_read','0.075']]:id==='openai/gpt-oss-20b'?[['input.cache_read','0.0375']]:[])].map(([dimension,amount],i)=>({id:`r${i}`,dimension,unit:'tokens',unit_size:'1000000',amount,conditions:{model:id,...(cloud?{service_mode:'standard'}:{})},effective_from:checked,...(cloud?{effective_to:'2027-01-01T00:00:00Z'}:{})}))};
}
export function alternativeCalculation(provider:string,id:string):ModelCalculation{
 const m=alternativeModel(provider,id),cloud=provider==='google_cloud';
 const result=(dimension:string)=>({kind:'quantity' as const,dimension,unit:'tokens' as const,conditions:{model:id,...(cloud?{service_mode:'standard'}:{})}});
 const method:ModelCalculation={version:1,source:'Local UTF-8 serialized-context approximation, including compiled schema/tools and framing. Not the model tokenizer or a proven financial cap. Vision: Groq Qwen 2048 tokens/image per model card; other vision 4096/image is an uncalibrated forecast. CountTokens is not called by quotes.',verification:'approximate',verified_at:checked,
 parameters:{expected_output_tokens:{type:'number',minimum:1,maximum:m.output,default:1024,required:true},max_output_tokens:{type:'number',minimum:1,maximum:m.output,default:4096,required:true},temperature:{type:'number',minimum:0,maximum:2,default:1},top_p:{type:'number',minimum:0,maximum:1},seed:{type:'number',minimum:0,maximum:1000000000},...(id.includes('gpt-oss')?{reasoning_effort:{type:'string' as const,values:['low','medium','high']}}:provider==='groq'?{reasoning_effort:{type:'string' as const,values:['none','default','low','medium','high']}}:{}),...(cloud?{thinking_level:{type:'string' as const,values:['LOW','MEDIUM','HIGH'],default:'LOW'}}:{})},
 preparation:{mode:'preserve',max_assets:m.images,max_edge:4096,format:'png'},pricing:{safety_factor:'1',markup_percent:'0',rounding_units:'1'},
 components:[{key:'input',label:'Приблизительная оценка полного входа',covers:['text_input','image_input'],maximum:String(m.context),type:'tokens',direction:'input',tokenizer:'utf8_upper_bound',input_mode:'compiled_messages_json',overhead:256,per_message:32,per_asset:provider==='groq'?2048:4096,result:result('input.uncached')},
 {key:'output',label:'Ожидаемый выход, включая reasoning',covers:['text_output'],maximum:String(m.output),type:'tokens',direction:'output',policy:'estimated_parameter',limit_parameter:'expected_output_tokens',result:result('output.text')}],samples:[]};
 const sample={input:{messages:[{role:'user',content:[{type:'text',text:'Hello'}]}]},parameters:{expected_output_tokens:32,max_output_tokens:256},assets:[]};
 method.samples=[{name:'Локальная оценка, не вызов поставщика',input:sample,expected:Object.fromEntries(calculateQuantities(method,sample).map(v=>[v.key,v.value]))}];return method;
}
// This status does not validate a new installation's credentials, quota or SLA.
export function alternativeBundle(provider:string,id:string):FileConfiguration{
 const m=alternativeModel(provider,id),key=`ami.${provider}.${id.replaceAll('/','.')}`,rates=alternativeRates(provider,id),method=alternativeCalculation(provider,id),ref=(kind:string)=>`@${kind}:${key}`;
 return {schema_version:1,bundle_key:key,resources:[
 {key,kind:'rate_card',display_name:`${id} · ${provider}${provider==='google_cloud'?' Standard global':''}`,payload:{...rates,rates:rates.rates.map(r=>({...r}))},samples:[{usage:{state:'known',items:[{dimension:'input.uncached',quantity:'100',unit:'tokens'},{dimension:'output.text',quantity:'20',unit:'tokens'}]},context:{at:checked,conditions:{model:id,...(provider==='google_cloud'?{service_mode:'standard'}:{})}}}]},
 {key,kind:'catalog',payload:{models:[{id,provider,adapter_ref:`${provider}@1`,capabilities:['text.generate'],allowed_parameters:Object.keys(method.parameters),status:'active',preview:m.preview,live_validation:'passed',identity_kind:'snapshot',text_features:alternativeFeatures(provider,id),calculation:method as any,rate_card_version_id:ref('rate_card')}]}},
 {key,kind:'route',payload:{capability:'text.generate',primary:{catalog_version_id:ref('catalog'),model:id,connection_id:`@connection:${provider}`,max_cost_units:'1000000000',...(provider==='google_cloud'?{service_mode:'standard' as const}:{})},execution:{max_attempts:1},platform_risk_budget_units:'1000000000'}},
 {key,kind:'recipe',payload:{period_budget_key:'@budget:alternative-models',components:[{key:'text',capability:'text.generate',route_version_id:ref('route'),rate_card_version_id:ref('rate_card'),count:{constant:1},limits:{},pricing_mode:'estimated_actual'}]}}
 ]};
}
export {alternativeModels};
