import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {OpenAIAdapter,normalizeOpenAI,type ProviderInput} from '../src/index.js';
import {parseConfiguration} from '../../configuration/src/index.js';
import {validateCatalog} from '../../catalog/src/index.js';
import {normalizeParameters,validateModelRateCoverage,validateModelPriceSamples} from '../../model-pricing/src/index.js';
import {rateUsage} from '../../pricing/src/index.js';
const bundle=JSON.parse(readFileSync(new URL('../../../configurations/ai/openai-luna6.json',import.meta.url),'utf8'));
const card=bundle.resources[0].payload,model=bundle.resources[1].payload.models[0];
const context={at:'2026-09-26T00:00:00Z'};
const input:ProviderInput={capability:'text.generate',model:'gpt-6-luna',input:'hello',output_limit_policy:'provider_default'};
const adapter=new OpenAIAdapter({apiKey:'fixture',models:[input.model]});
const usage=(n:number)=>({input_tokens:n,input_tokens_details:{cached_tokens:100,cache_write_tokens:200},output_tokens:1000,output_tokens_details:{reasoning_tokens:800}});
describe('GPT-6 Luna',()=>{
 it('publishes a coherent model, calculation and rate card',()=>{
  parseConfiguration(bundle);validateCatalog({models:[model]});validateModelRateCoverage(model.calculation,card,context);validateModelPriceSamples(model.calculation,card,context);
  expect(normalizeParameters(model.calculation,{})).toEqual({reasoning_effort:'medium',expected_output_tokens:4096,service_tier:'default'});
 });
 it.each(['none','low','medium','high','xhigh','max'])('maps %s to Responses reasoning.effort',effort=>{
  const value={...input,parameters:{reasoning_effort:effort,service_tier:'default'}};adapter.validate(value);
  const request=adapter.request(value,true);expect(request.url).toBe('https://api.openai.com/v1/responses');
  expect(request.body).toMatchObject({model:input.model,reasoning:{effort},service_tier:'default',stream:true,store:false});
  expect(request.body).not.toHaveProperty('reasoning_effort');expect((request.body as any).max_output_tokens).toBeUndefined();
 });
 it.each([{reasoning_effort:'ultra'},{reasoning_effort:'max',reasoning:{effort:'low'}},{service_tier:'fast'},{service_tier:'flex'},{temperature:1}])('rejects unsupported or unpriced parameters %j',parameters=>{
  expect(()=>adapter.validate({...input,parameters})).toThrow();
 });
 it.each([[272000,'short','0.027696'],[272001,'long','0.0551422']] as const)('rates all dimensions at the %i input boundary', (n,window,cost)=>{
  const normalized=normalizeOpenAI(usage(n),input);expect(normalized.state).toBe('known');
  if(normalized.state!=='known')throw Error('usage');
  expect(normalized.items.every(v=>v.conditions?.context_window===window)).toBe(true);
  expect(normalized.breakdown?.reasoning_tokens).toBe('800');
  expect(normalized.items.find(v=>v.dimension==='output.text')?.quantity).toBe('1000');
  const rated=rateUsage(normalized,card,context);expect(rated.state).toBe('calculated');expect(rated.state==='calculated'&&rated.exact_amount).toBe(cost);
 });
 it('does not guess missing cache writes',()=>{
  const raw=usage(1000);delete (raw.input_tokens_details as any).cache_write_tokens;
  expect(normalizeOpenAI(raw,input).state).toBe('unknown');
 });
 it('executes a streamed response and records reasoning once without calling OpenAI',async()=>{
  const deltas:string[]=[],observations:unknown[]=[];
  const terminal={id:'fixture-response',status:'completed',usage:usage(1000),output:[{type:'message',content:[{type:'output_text',text:'Hello'}]}]};
  const a=new OpenAIAdapter({apiKey:'fixture',models:[input.model],fetch:async(_url,init)=>{
   expect(JSON.parse(String(init.body)).reasoning).toEqual({effort:'max'});
   return new Response([{type:'response.output_text.delta',delta:'Hello'},{type:'response.completed',response:terminal}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }});
  const result=await a.execute({...input,stream:true,parameters:{reasoning_effort:'max'}},{attempt_id:'fixture',onUsage:async v=>{observations.push(v)},onDelta:async v=>{deltas.push(v)}});
  expect(result).toMatchObject({outcome:'success',output:{text:'Hello'},usage:{breakdown:{reasoning_tokens:'800'}}});expect(deltas).toEqual(['Hello']);expect(observations).toHaveLength(1);
 });
});
