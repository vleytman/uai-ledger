/** Local demo configuration. Provider prices checked against OpenAI model pages on 2026-09-19. */
import {imageCalculationExample,textCalculationExample} from './examples.js';
import {calculateQuantities,type ModelCalculation} from './index.js';
import {demoImagePresets} from '../../quoting/src/openai-image-presets.js';
import type {RateCard} from '../../pricing/src/index.js';
const checked='2026-09-19T00:00:00Z';
export function demoModels(){
 const images=[{key:'image2',id:'gpt-image-2-2026-04-21',qualities:['low','medium','high']},{key:'sunburst',id:'gpt-image-2.5-sunburst-2026-09-08',qualities:['low','medium','high','xhigh','max']},{key:'flare',id:'gpt-image-2.5-flare-2026-09-08',qualities:['low','medium','high','xhigh','max']}];
 const texts=[{key:'sol',id:'gpt-5.6-sol',input:'4',cached:'0.4',write:'5',output:'20'},{key:'terra',id:'gpt-5.6-terra',input:'2',cached:'0.2',write:'2.5',output:'12'},{key:'nano',id:'gpt-4.1-nano-2025-04-14',input:'0.1',cached:'0.025',output:'0.4'},{key:'gpt41',id:'gpt-4.1-2025-04-14',input:'2',cached:'0.5',output:'8'}];
 const rates=(id:string,entries:Array<[string,string,Record<string,string>?]>):RateCard=>({id:`demo.${id}`,currency:'USD',source:`https://developers.openai.com/api/docs/models/${id.replace(/-\d{4}-\d{2}-\d{2}$/,'')} Standard API, short context, checked 2026-09-19.`,checked_at:checked,rates:entries.map(([dimension,amount,conditions],i)=>({id:`rate-${i}`,dimension,amount,unit:'tokens',unit_size:'1000000',effective_from:checked,...(conditions?{conditions}:{})}))});
 const finish=(method:ModelCalculation)=>{method.pricing={safety_factor:'1.1',markup_percent:'100',rounding_units:'1'};method.samples=method.samples.map(sample=>({...sample,expected:Object.fromEntries(calculateQuantities(method,sample.input).map(c=>[c.key,c.value]))}));return method};
 return [
  ...images.map(s=>({key:s.key,id:s.id,provider:'openai',identity_kind:'snapshot' as const,capability:'image.generate' as const,method:finish(imageCalculationExample(s.id,s.qualities,'30',demoImagePresets().map(p=>p.size))),card:rates(s.id,[['input.uncached','5',{modality:'text'}],['input.uncached','8',{modality:'image'}],['output.image','30',{modality:'image'}]])})),
  ...texts.map(s=>{
   const method=textCalculationExample();
   delete method.parameters.max_output_tokens;
   method.parameters.expected_output_tokens={type:'number',minimum:128,maximum:131072,values:[128,512,1024,2048,4096,8192,16384,32768,65536,131072],default:4096,required:true};
   method.samples=method.samples.map(sample=>({...sample,input:{...sample.input,parameters:{expected_output_tokens:4096}}}));
   method.components[0].maximum='16000';
   const output=method.components.find(c=>c.type==='tokens'&&c.direction==='output')!;
   if(output.type==='tokens'&&output.direction==='output'){output.policy='estimated_parameter';output.limit_parameter='expected_output_tokens';delete output.expected;output.maximum='131072';output.label='Expected answer tokens'}
   // A cold cache can bill all input at the cache-write rate on these models.
   if(s.write)method.components[0].result={kind:'quantity',dimension:'input.cache_write',unit:'tokens'};
   method.source=`${rates(s.id,[]).source} Input o200k_base estimate with framing allowance. Text only, no tools, <=16000 estimated input tokens, below long-context threshold. Expected output tokens are an estimate only, never an API output limit. Actual usage is billed with markup; safety applies only to the estimate. ${s.write?'Input estimate assumes cold cache writes at 1.25x; actual usage keeps uncached/read/write separate.':''}`;
   return {key:s.key,id:s.id,provider:'openai',identity_kind:s.write?'alias' as const:'snapshot' as const,capability:'text.generate' as const,method:finish(method),card:rates(s.id,[['input.uncached',s.input],['input.cache_read',s.cached],['output.text',s.output],...(s.write?[['input.cache_write',s.write] as [string,string]]:[])])};
  })
 ];
}
