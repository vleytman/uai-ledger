/** Configuration examples, evaluated by the same generic engine as admin-created models. */
import {imagePresets,imageOutputTokens} from '../../quoting/src/openai-image-presets.js';
import {Rational,calculateQuantities,type ModelCalculation} from './index.js';
const checked='2026-09-19T00:00:00Z';
export function imageCalculationExample(model:string,qualities:string[],outputUsdPerMillion:string,allowedSizes?:string[]):ModelCalculation {
 const sizes=allowedSizes??[...new Set(imagePresets().filter(p=>p.supported).map(p=>p.size))];
 const rows=sizes.flatMap(size=>qualities.map(quality=>({parameters:{size,quality},value:Rational.from(imageOutputTokens(model,size,quality)).mul(Rational.from(outputUsdPerMillion)).div(Rational.from('1000000')).decimal()})));
 const maximum=rows.reduce((a,b)=>Rational.from(a).compare(Rational.from(b.value))>=0?a:b.value,'0');
 const policy:ModelCalculation={version:1,source:'OpenAI public output calculator, checked 2026-09-19. Text framing +6/+10 per reference and 1024 image input tokens per 1024-square reference are empirical estimates from 15 direct requests on Sunburst/Flare. Other sizes, qualities and Image 2 are estimates, not guarantees. https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency',verification:'approximate',verified_at:checked,
  parameters:{size:{type:'string',values:sizes,default:'1024x1024',required:true},quality:{type:'string',values:qualities,default:'medium',required:true},output_format:{type:'string',values:['png','jpeg','webp'],default:'png'},background:{type:'string',values:['opaque','transparent'],default:'opaque'}},
  preparation:{max_assets:16,max_edge:1024,fit:'contain',format:'png',allowed_dimensions:['1024x1024']},
  pricing:{safety_factor:'1',markup_percent:'0',rounding_units:'1'},
  components:[
   {key:'text',label:'Input text',covers:['text_input'],maximum:'12000',type:'tokens',direction:'input',tokenizer:'o200k_base',input_mode:'prompt',overhead:6,per_message:0,per_asset:10,result:{kind:'quantity',dimension:'input.uncached',unit:'tokens',conditions:{modality:'text'}}},
   {key:'references',label:'Input references',covers:['image_input'],maximum:'16384',type:'formula',expression:{op:'multiply',args:[{op:'field',path:'input.asset_count'},{op:'constant',value:'1024'}]},result:{kind:'quantity',dimension:'input.uncached',unit:'tokens',conditions:{modality:'image'}}},
   {key:'image',label:'Output image',covers:['image_output'],maximum,type:'lookup',parameters:['size','quality'],rows,result:{kind:'usd'}}
  ],samples:[]};
 const prompts=['A blue cup.','Нарисуй синюю чашку рядом с апельсином на светлом столе. Мягкий утренний свет, без надписей.'];
 for(const count of [0,1,2,16]){const input={input:{prompt:prompts[count===0?1:0]},parameters:{size:'1024x1024',quality:'medium'},assets:Array.from({length:count},(_,i)=>({id:`reference-${i}`,sha256:'sha256:'+'0'.repeat(64),width:1024,height:1024,format:'png'}))};policy.samples.push({name:`Prepared 1024-square references: ${count}`,input,expected:Object.fromEntries(calculateQuantities(policy,input).map(c=>[c.key,c.value]))});}
 return policy;
}
export function textCalculationExample():ModelCalculation {
 const policy:ModelCalculation={version:1,source:'Full serialized input tokenization with o200k_base plus explicit framing allowance. Approximation for Responses, no cache discount or tools. Output forecast 128, executed maximum chosen in parameters.',verification:'approximate',verified_at:checked,parameters:{max_output_tokens:{type:'number',minimum:1,maximum:512,default:128,required:true}},preparation:{max_assets:0,max_edge:1024,format:'png'},pricing:{safety_factor:'1',markup_percent:'0',rounding_units:'1'},components:[
  {key:'input',label:'Input context',covers:['text_input'],maximum:'4000',type:'tokens',direction:'input',tokenizer:'o200k_base',input_mode:'messages_json',overhead:16,per_message:4,per_asset:0,result:{kind:'quantity',dimension:'input.uncached',unit:'tokens'}},
  {key:'output',label:'Expected answer',covers:['text_output'],maximum:'512',type:'tokens',direction:'output',policy:'configured_expected',expected:128,limit_parameter:'max_output_tokens',result:{kind:'quantity',dimension:'output.text',unit:'tokens'}}
 ],samples:[]};
 for(const prompt of ['Hello','Привет, ответь одной фразой.']){const input={input:{messages:[{role:'user',content:prompt}]},parameters:{max_output_tokens:128},assets:[]};policy.samples.push({name:prompt,input,expected:Object.fromEntries(calculateQuantities(policy,input).map(c=>[c.key,c.value]))});}return policy;
}
