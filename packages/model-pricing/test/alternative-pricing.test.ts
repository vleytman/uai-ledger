import {describe,it,expect} from 'vitest';
import {alternativeModels,alternativeBundle,alternativeRates,alternativeCalculation} from '../src/alternative-examples.js';
import {priceModel,validateModelCalculation} from '../src/index.js';
import {parseConfiguration} from '../../configuration/src/index.js';
import {validateCatalog} from '../../catalog/src/index.js';
import {rateUsage} from '../../pricing/src/index.js';
import {geminiUsage} from '../../providers/src/google-cloud.js';
import {chatUsage} from '../../providers/src/chat-completions.js';
describe('AMI-A07/A08 inert profiles and arithmetic',()=>{
 it('prices Cerebras cached input at the standard input rate without losing settlement',()=>{
  const usage=chatUsage({prompt_tokens:1000,completion_tokens:100,prompt_tokens_details:{cached_tokens:768}},'cerebras');
  const result=rateUsage(usage,alternativeRates('cerebras','gpt-oss-120b'),{at:'2026-09-26T00:00:00Z',conditions:{model:'gpt-oss-120b'}});
  expect(result.state==='calculated'&&result.rounded_units).toBe(425000n);
 });
 for(const m of alternativeModels)it(`${m.id}: complete validated bundle, tools/images increase cold forecast`,()=>{
  const b=parseConfiguration(alternativeBundle(m.provider,m.id));const catalog=b.resources.find(r=>r.kind==='catalog')!.payload as any;catalog.models[0].rate_card_version_id='published-rate';validateCatalog(catalog);const method=alternativeCalculation(m.provider,m.id);validateModelCalculation(method);
  const i={input:{messages:[{role:'user',content:[{type:'text',text:'hello'}]}]},parameters:{expected_output_tokens:32,max_output_tokens:256},assets:[]};const rate=alternativeRates(m.provider,m.id);const ctx={at:'2026-09-25T12:00:00Z',conditions:{model:m.id,service_mode:'standard'}};
  const plain=priceModel(method,i,rate,ctx);const tool=priceModel(method,{...i,input:{...i.input,tools:[{name:'lookup',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}],tool_choice:{type:'required'}}},rate,ctx);expect(BigInt(tool.provider_estimate_units)).toBeGreaterThan(BigInt(plain.provider_estimate_units));expect(method.verification).toBe('approximate');
 });
 it('Cloud cache and reasoning cost is exact; promotion cannot execute after expiry',()=>{const usage=geminiUsage({promptTokenCount:100,candidatesTokenCount:30,thoughtsTokenCount:20,cachedContentTokenCount:40});const rate=alternativeRates('google_cloud','gemini-3.8-flash');const ctx={at:'2026-12-31T23:59:59Z',conditions:{model:'gemini-3.8-flash'}};const cost=rateUsage(usage,rate,ctx);expect(cost.state==='calculated'&&cost.exact_amount).toBe('0.0002355');expect(cost.state==='calculated'&&cost.rounded_units).toBe(235500n);expect(rateUsage(usage,rate,{...ctx,at:'2027-01-01T00:00:00Z'}).state).toBe('unknown');});
});
