import {describe,it,expect,vi} from 'vitest';
import {openAILimitUsage,validLimitUsage} from '../src/limit-usage.js';
import {OpenAIAdapter,type ProviderInput} from '../src/index.js';
const input:ProviderInput={capability:'text.generate',model:'fixture-text',input:'Example',max_output_tokens:4096};
describe('Confirmed execution counters',()=>{
 it('keeps token counters independent of cache pricing and rejects inconsistent or unsafe totals',()=>{
  expect(openAILimitUsage({input_tokens:20,output_tokens:6000,total_tokens:6020})).toEqual({requests:1,input_tokens:20,output_tokens:6000,tokens:6020});
  expect(openAILimitUsage({input_tokens:'0',output_tokens:'0'})).toEqual({requests:1,input_tokens:0,output_tokens:0,tokens:0});
  for(const raw of [{input_tokens:1},{output_tokens:1},{input_tokens:-1,output_tokens:1},{input_tokens:1.2,output_tokens:1},{input_tokens:1,output_tokens:2,total_tokens:4},{input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:1}])expect(openAILimitUsage(raw)).toBeUndefined();
 });
 it('whitelists counter metadata and never substitutes zero for missing information',()=>{
  expect(validLimitUsage({requests:1,tokens:5,output:'private text',api_key:'private secret'})).toEqual({requests:1,tokens:5});
  expect(validLimitUsage({requests:1})).toEqual({requests:1});
  for(const value of [{tokens:1},{requests:1,tokens:-1},{requests:1,tokens:Infinity},{requests:1,tokens:'5'}])expect(validLimitUsage(value)).toBeUndefined();
 });
 it('returns explicit raw counters even if monetary cache attribution is unavailable',async()=>{
  const adapter=new OpenAIAdapter({apiKey:'synthetic',models:[input.model],fetch:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Complete response'}]}],usage:{input_tokens:20,output_tokens:6000,total_tokens:6020}})});
  const result=await adapter.execute(input,{attempt_id:'test',onUsage:vi.fn()});
  expect(result).toMatchObject({outcome:'success',usage:{state:'unknown'},limit_usage:{requests:1,input_tokens:20,output_tokens:6000,tokens:6020}});
 });
 it('retains counters on a technical defect but leaves absent usage unknown',async()=>{
  const adapter=new OpenAIAdapter({apiKey:'synthetic',models:[input.model],fetch:async()=>Response.json({status:'completed',output:[],usage:{input_tokens:1,output_tokens:2}})});
  expect(await adapter.execute(input,{attempt_id:'test',onUsage:vi.fn()})).toMatchObject({outcome:'failure',limit_usage:{tokens:3}});
  const rejected=new OpenAIAdapter({apiKey:'synthetic',models:[input.model],fetch:async()=>Response.json({error:{code:'rate_limit'}},{status:429})});
  expect((await rejected.execute(input,{attempt_id:'test',onUsage:vi.fn()})).limit_usage).toBeUndefined();
 });
});
