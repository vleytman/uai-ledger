/** Inert publication examples. Importing this module does not publish or call a provider. */
import {calculateQuantities,type ModelCalculation} from './index.js';
import {RECRAFT_SIZES,RECRAFT_STYLES,RECRAFT_VECTORIZE} from '../../providers/src/svg-input.js';
import {embeddingModel} from '../../providers/src/embeddings.js';
const checked='2026-09-25T00:00:00Z';
function finish(p:ModelCalculation,input:Record<string,unknown>,parameters:Record<string,unknown>,references=0){
 const sample={input,parameters,assets:Array.from({length:references},(_,i)=>({id:`ref-${i}`,sha256:'0'.repeat(64),width:256,height:256,format:'png'}))};
 p.samples=[{name:'Локальный расчёт; провайдер не вызывался',input:sample,expected:Object.fromEntries(calculateQuantities(p,sample).map(c=>[c.key,c.value]))}];return p;
}
export function embeddingCalculation(model:string):ModelCalculation{
 const m=embeddingModel(model),voyage=m.provider==='voyage';
 return finish({version:1,source:voyage?'https://docs.voyageai.com/docs/embeddings; UTF-8 upper bound plus 64 tokens per string for retrieval prefix. No truncation.':'https://developers.openai.com/api/reference/resources/embeddings/methods/create; cl100k_base for complete batch.',verification: voyage?'approximate':'documented',verified_at:checked,
 parameters:{dimensions:{type:'number',minimum:1,maximum:m.max_dimensions,...(m.dimensions?{values:[...m.dimensions]}:{}),default:m.default_dimensions},...(voyage?{input_type:{type:'string' as const,values:['query','document'],default:'document'}}:{})},
 preparation:{mode:'preserve',max_assets:0,max_edge:4096,format:'png'},pricing:{safety_factor:'1',markup_percent:'0',rounding_units:'1'},
 components:[{key:'input',label:'Весь пакет',covers:['text_input'],maximum:'300000',type:'tokens',direction:'input',tokenizer:voyage?'utf8_upper_bound':'cl100k_base',input_mode:'embedding_batch',overhead:voyage?8192:0,per_message:0,per_asset:0,result:{kind:'quantity',dimension:'input.uncached',unit:'tokens'}}],samples:[]},{texts:['Синий круг','Blue circle']},{dimensions:m.default_dimensions,...(voyage?{input_type:'document'}:{})});
}
export function svgCalculation(provider:'replicate'|'quiver',model:string,vector=false):ModelCalculation{
 const quiver=provider==='quiver',styles=!quiver&&model!==RECRAFT_VECTORIZE;
 const sizes=model===RECRAFT_STYLES[1]?RECRAFT_SIZES.map(s=>s.split('x').map(n=>Number(n)*2).join('x')):RECRAFT_SIZES;
 const p:ModelCalculation={version:1,source:quiver?'https://docs.quiver.ai/developers/pricing; Input quantity is an explicit approximation (UTF-8 prompt plus 4096 per reference), not a token bound. Output uses requested maximum. Cache estimates are zero; actual cache usage must be reported.':'https://replicate.com/'+model+'; Per-output price. Separate style.creation component is explicitly included at zero in published per-image price; recheck before publication.',verification:quiver?'approximate':'documented',verified_at:checked,
 parameters:quiver?{max_output_tokens:{type:'number',minimum:1,maximum:65536,default:8192,required:true},...(vector?{auto_crop:{type:'boolean' as const,default:false}}:{reasoning_effort:{type:'string' as const,values:['low','medium','high','xhigh'],default:'medium'}})}:styles?{size:{type:'string',values:sizes,default:sizes[0]},style_match:{type:'string',values:['precise','flexible'],default:'precise'}}:{},
 preparation:{mode:'preserve',max_assets:vector?1:quiver?16:10,max_edge:4096,format:'png'},pricing:{safety_factor:'1',markup_percent:'0',rounding_units:'1'},
 components:quiver?[
 {key:'input',label:'Оценка входа',covers:['text_input','image_input'],maximum:'80000',type:'tokens',direction:'input',tokenizer:'utf8_upper_bound',input_mode:'prompt',overhead:64,per_message:0,per_asset:4096,result:{kind:'quantity',dimension:'input.uncached',unit:'tokens'}},
 ...(['cache_read','cache_write'] as const).map(key=>({key,label:key,covers:[key],maximum:'80000',type:'per_unit' as const,source:'constant' as const,constant:'0',step:'1',rounding:'ceil' as const,result:{kind:'quantity' as const,dimension:`input.${key}`,unit:'tokens' as const}})),
 {key:'output',label:'Лимит выхода, включая reasoning',covers:['image_output'],maximum:'65536',type:'tokens',direction:'output',policy:'requested_maximum',limit_parameter:'max_output_tokens',result:{kind:'quantity',dimension:'output.text',unit:'tokens'}}
 ]:[{key:'image',label:'Один SVG',covers:['text_input','image_input','image_output'],maximum:'1',type:'per_unit',source:'constant',constant:'1',step:'1',rounding:'ceil',result:{kind:'quantity',dimension:'output.image',unit:'images'}},...(styles?[{key:'style',label:'Создание стиля включено в цену изображения',covers:['style_creation'],maximum:'1',type:'per_unit' as const,source:'constant' as const,constant:'1',step:'1',rounding:'ceil' as const,result:{kind:'quantity' as const,dimension:'style.creation',unit:'calls' as const}}]:[])],samples:[]};
 return finish(p,vector?{asset_ids:['ref-0']}:{prompt:'Blue circle',...(styles?{asset_ids:['ref-0']}:{})},quiver?{max_output_tokens:8192}:{},vector||styles?1:0);
}
