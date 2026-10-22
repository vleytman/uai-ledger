import {describe,it,expect} from 'vitest';
import {imageQuotaEstimate} from '../src/image-quota-estimate.js';
import {imageCalculationExample} from '../../model-pricing/src/examples.js';
import {priceModel} from '../../model-pricing/src/index.js';
import {imageOutputTokens} from '../../quoting/src/openai-image-presets.js';
import {quotaDemands} from '../../queue/src/quota-demands.js';
import type {RateCard} from '../../pricing/src/index.js';
const at='2026-09-20T00:00:00Z';
// Synthetic rates, not assertions about live provider prices.
const card:RateCard={id:'test',currency:'USD',source:'test',checked_at:at,rates:[
 {id:'text',dimension:'input.uncached',unit:'tokens',unit_size:'1000000',amount:'5',conditions:{modality:'text'},effective_from:at},
 {id:'references',dimension:'input.uncached',unit:'tokens',unit_size:'1000000',amount:'8',conditions:{modality:'image'},effective_from:at},
 {id:'output',dimension:'output.image',unit:'tokens',unit_size:'1000000',amount:'30',conditions:{modality:'image'},effective_from:at}
]};
describe('image quota estimate from accepted pricing table',()=>{
 it.each(['gpt-image-2-2026-04-21','gpt-image-2.5-sunburst-2026-09-08','gpt-image-2.5-flare-2026-09-08'])('covers table sizes, qualities and references for %s',model=>{
  const qualities=model.includes('2.5')?['low','medium','high','xhigh','max']:['low','medium','high'];
  const policy=imageCalculationExample(model,qualities,'30');
  for(const size of policy.parameters.size.values!){for(const quality of qualities){for(const count of [0,2,16]){
   const request={input:{prompt:'Draw a banana cafe logo'},parameters:{size,quality},assets:Array.from({length:count},(_,i)=>({id:String(i),sha256:'0'.repeat(64),width:1024,height:1024,format:'png'}))};
   const breakdown=priceModel(policy,request,card,{at},{checkSamples:false});
   const estimate=imageQuotaEstimate(model,breakdown,card,{at})!;
   expect(estimate.output_tokens).toBe(imageOutputTokens(model,String(size),quality));
   expect(estimate.input_tokens).toBe(Number(breakdown.components[0]!.value)+1024*count);
   expect(quotaDemands([{key:'ipm',metric:'images',capacity:'150',window_ms:60000},{key:'tpm',metric:'tokens',capacity:'3000000',window_ms:60000}],estimate).map(d=>d.amount)).toEqual([1,estimate.input_tokens!+estimate.output_tokens!]);
  }}}
 });
 it('uses table values, excludes margin and fails closed without a token rate',()=>{
  const model='gpt-image-2.5-flare-2026-09-08',policy=imageCalculationExample(model,['medium'],'30');
  policy.pricing={safety_factor:'1.1',markup_percent:'100',rounding_units:'1000'};
  const breakdown=priceModel(policy,{input:{prompt:'A logo'},parameters:{size:'1024x1024',quality:'medium'},assets:[]},card,{at});
  breakdown.components.find(c=>c.key==='image')!.value='0.03';
  expect(imageQuotaEstimate(model,breakdown,card,{at})!.output_tokens).toBe(1000);
  expect(imageQuotaEstimate(model,breakdown,{...card,rates:card.rates.filter(r=>r.id!=='output')},{at})).toBeUndefined();
  expect(imageQuotaEstimate('unknown-model',breakdown,card,{at})).toBeUndefined();
 });
});
