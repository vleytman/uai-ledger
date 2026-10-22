import {describe,it,expect,vi} from 'vitest';
import {createRegisteredAdapter} from '../src/registry.js';
import {alternativeModels,alternativeFeatures} from '../src/alternative-models.js';
import {chatUsage} from '../src/chat-completions.js';
import {geminiUsage,RefreshingToken} from '../src/google-cloud.js';
import type {ProviderInput,AdapterContext} from '../src/contracts.js';
import {validateProviderText,validateTextFeatures} from '../src/text-input.js';
const schema={type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false};
const tools=[{name:'lookup',parameters:schema}];
const input=(model:string):ProviderInput=>({capability:'text.generate',model,input:'Hello',max_output_tokens:128});
const context=():AdapterContext=>({attempt_id:'fixture',onUsage:vi.fn(async()=>{})});
function adapter(provider:string,model:string,body:unknown){const transport=vi.fn(async(_url:string,_init:RequestInit)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}}));return {adapter:createRegisteredAdapter(provider,{apiKey:'fixture',models:[model],fetch:transport,googleProject:'fixture-project',googleLocation:'global',googleToken:{get:async()=> 'fixture-token'}}),transport};}
const answer=(provider:string,text='hello')=>provider==='google_cloud'?{responseId:'response-1',candidates:[{finishReason:'STOP',content:{parts:[{text}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:5}}:{id:'response-1',choices:[{finish_reason:'stop',message:{content:text}}],usage:{prompt_tokens:100,completion_tokens:25}};
function callAnswer(provider:string){const a:any=answer(provider);if(provider==='google_cloud')a.candidates[0].content.parts=[{functionCall:{id:'call-1',name:'lookup',args:{value:'blue'}},thoughtSignature:'opaque-signature'}];else a.choices=[{finish_reason:'tool_calls',message:{tool_calls:[{id:'call-1',function:{name:'lookup',arguments:'{"value":"blue"}'}}]}}];return a;}
describe('AMI-A01–A06 alternative transports',()=>{
 for(const m of alternativeModels){
  it(`${m.provider}/${m.id}: text, schema and native forced call round-trip`,async()=>{
   const {adapter:a,transport}=adapter(m.provider,m.id,answer(m.provider));let result=await a.execute(input(m.id),context());expect(result.outcome).toBe('success');expect(result.usage.state).toBe('known');
   expect(()=>a.validate({...input(m.id),model:'not-a-model'})).toThrow();expect(()=>a.validate({...input(m.id),parameters:{paid_tool:true}})).toThrow();expect(()=>a.validate({...input(m.id),service_mode:'priority' as any})).toThrow();
   transport.mockImplementation(async()=>new Response(JSON.stringify(answer(m.provider,'{"value":"blue"}'))));result=await a.execute({...input(m.id),response_schema:{name:'result',schema}},context());expect(result.outcome).toBe('success');
   transport.mockImplementation(async()=>new Response(JSON.stringify(callAnswer(m.provider))));result=await a.execute({...input(m.id),tools,tool_choice:{type:'named',name:'lookup'}},context());expect(result.outcome).toBe('success');if(result.outcome!=='success')return;
   const call=result.output.tool_call!;expect(call.id).toBe('call-1');expect(call.execution_method).toBe('native');
   const next:ProviderInput={...input(m.id),messages:[{role:'user',content:[{type:'text',text:'Find blue'}]},{role:'assistant',content:[{type:'tool_call',...call}]},{role:'user',content:[{type:'tool_result',call_id:call.id,result:{found:true}}]}]};
   transport.mockImplementation(async()=>new Response(JSON.stringify(answer(m.provider))));result=await a.execute(next,context());expect(result.outcome).toBe('success');const body=JSON.parse(transport.mock.calls.at(-1)![1]!.body as string);if(m.provider==='google_cloud'){expect(body.contents[1].parts[0].thoughtSignature).toBe('opaque-signature');expect(body.contents[2].parts[0].functionResponse.name).toBe('lookup');}else expect(body.messages.at(-1)).toMatchObject({role:'tool',tool_call_id:'call-1'});
  });
  it(`${m.id}: images allowed by model, detail and bytes checked`,async()=>{
   const {adapter:a,transport}=adapter(m.provider,m.id,answer(m.provider));const i:ProviderInput={...input(m.id),assets:[{filename:'image-1',bytes:new Uint8Array([1,2,3]),content_type:'image/png'}],messages:[{role:'user',content:[{type:'image',asset_id:'image-1'}]}]};
   if(!m.images){expect(()=>a.validate(i)).toThrow();expect(transport).not.toHaveBeenCalled();}else {await a.execute(i,context());const wire=String(transport.mock.calls[0][1]?.body);expect(wire).toContain('AQID');expect(wire).toContain('image/png');expect(()=>a.validate({...i,assets:[{...i.assets![0],bytes:new Uint8Array(m.imageBytes+1)}]})).toThrow();}
  });
  it(`${m.id}: streaming terminal usage, split UTF8 and final frame without delimiter`,async()=>{
   const chunks=m.provider==='google_cloud'?[{candidates:[{index:0,content:{parts:[{text:'Привет'}]}}]}, {candidates:[{index:0,finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2}}]:[{choices:[{index:0,delta:{content:'Привет'}}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:2}}];
   const bytes=new TextEncoder().encode(chunks.map(d=>'data: '+JSON.stringify(d)).join('\r\n\r\n'));
   const {adapter:a,transport}=adapter(m.provider,m.id,{});transport.mockImplementation(async()=>new Response(new ReadableStream({start(c){for(let n=0;n<bytes.length;n+=7)c.enqueue(bytes.slice(n,n+7));c.close();}})));
   const delta=vi.fn(async()=>{}),ctx={...context(),onDelta:delta};const result=await a.execute({...input(m.id),stream:true},ctx);expect(result.outcome).toBe('success');expect(result.usage.state).toBe('known');expect(delta).toHaveBeenCalledWith('Привет');
  });
 }
 it('assembles fragmented tool arguments and rejects unfinished streams',async()=>{
  const {adapter:a,transport}=adapter('groq','openai/gpt-oss-20b',{});const frames=[{choices:[{index:0,delta:{tool_calls:[{index:0,id:'c1',function:{name:'lookup',arguments:'{"value":'}}]}}]},{choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"ok"}'}}]},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:1,completion_tokens:2}}];
  transport.mockImplementation(async()=>new Response(frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')));const r=await a.execute({...input('openai/gpt-oss-20b'),stream:true,tools,tool_choice:{type:'required'}},context());expect(r.outcome==='success'&&r.output.tool_call?.arguments).toEqual({value:'ok'});
  transport.mockImplementation(async()=>new Response('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));expect((await a.execute({...input('openai/gpt-oss-20b'),stream:true},context())).outcome).toBe('unknown');
 });
 it('rejects unsupported schema streaming and foreign signatures before dispatch',async()=>{
  const {adapter:a,transport}=adapter('groq','qwen/qwen3.8-27b',{});await expect(a.execute({...input('qwen/qwen3.8-27b'),stream:true,response_schema:{name:'result',schema}},context())).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
  expect(()=>validateProviderText('groq',{...input('qwen/qwen3.8-27b'),messages:[{role:'assistant',content:[{type:'tool_call',id:'c1',name:'lookup',arguments:{},continuation:{provider:'google_cloud',model:'gemini-3.8-flash',thought_signature:'opaque'}}]},{role:'user',content:[{type:'tool_result',call_id:'c1',result:{}}]}]})).toThrow('incompatible_continuation');
 });
 it('rejects orphan/duplicate results, parallel calls and missing usage remains unknown',()=>{
  const i=input('gpt-oss-120b');expect(()=>validateProviderText('cerebras',{...i,messages:[{role:'user',content:[{type:'tool_result',call_id:'x',result:{}}]}]})).toThrow();expect(()=>validateTextFeatures(alternativeFeatures('cerebras',i.model),{...i,parallel_tool_calls:true})).toThrow();expect(chatUsage({prompt_tokens:1},'groq').state).toBe('unknown');expect(geminiUsage({promptTokenCount:1}).state).toBe('unknown');
 });
});
describe('AMI-A08/A10/A11 usage, auth and failure boundaries',()=>{
 it.each([400,401,403,429,500,503])('Google HTTP %s has zero billable quantities, without invented token counters',async status=>{
  const {adapter:a,transport}=adapter('google_cloud','gemini-3.8-flash',{});transport.mockImplementation(async()=>new Response('{}',{status}));const ctx=context(),r=await a.execute(input('gemini-3.8-flash'),ctx);
  expect(r.usage).toEqual({state:'known',items:[{dimension:'input.uncached',quantity:'0',unit:'tokens',conditions:{service_mode:'standard'}},{dimension:'output.text',quantity:'0',unit:'tokens',conditions:{service_mode:'standard'}}],breakdown:{http_status:String(status),billing_basis:'google_cloud_non_200_not_billable'}});
  expect(ctx.onUsage).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledTimes(1);
 });
 it('keeps Google missing 200 usage and transport loss unknown, and does not assume other providers have free errors',async()=>{
  const {adapter:a,transport}=adapter('google_cloud','gemini-3.8-flash',{});expect((await a.execute(input('gemini-3.8-flash'),context())).usage.state).toBe('unknown');
  transport.mockImplementation(async()=>{throw new Error('connection lost')});const lost=await a.execute(input('gemini-3.8-flash'),context());expect(lost.outcome).toBe('unknown');expect(lost.usage.state).toBe('unknown');
  const chat=adapter('groq','openai/gpt-oss-20b',{});chat.transport.mockImplementation(async()=>new Response('{}',{status:429}));expect((await chat.adapter.execute(input('openai/gpt-oss-20b'),context())).usage.state).toBe('unknown');
 });
 it.each([['cerebras','qwen-3.8-27b','length'],['groq','openai/gpt-oss-20b','length'],['google_cloud','gemini-3.8-flash','MAX_TOKENS']])('records %s output truncation with known usage and no retry',async(provider,model,finish)=>{
  const body:any=answer(provider);if(provider==='google_cloud')body.candidates[0].finishReason=finish;else body.choices[0].finish_reason=finish;
  const {adapter:a,transport}=adapter(provider,model,body),ctx=context();const result=await a.execute(input(model),ctx);
  expect(result.outcome).toBe('failure');expect(result.usage).toMatchObject({state:'known',breakdown:{finish_reason:finish}});
  if(result.outcome==='failure')expect(result.failure.validation).toEqual({path:'max_output_tokens',reason:'output_limit_reached'});
  expect(transport).toHaveBeenCalledTimes(1);expect(ctx.onUsage).toHaveBeenCalledOnce();
 });
 it('does not double-count chat reasoning or Gemini cache',()=>{const chat=chatUsage({prompt_tokens:100,completion_tokens:30,completion_tokens_details:{reasoning_tokens:20},prompt_tokens_details:{cached_tokens:40}},'groq');expect(chat.state==='known'&&chat.items.map(i=>i.quantity)).toEqual(['60','40','30']);const cloud=geminiUsage({promptTokenCount:100,candidatesTokenCount:30,thoughtsTokenCount:20,cachedContentTokenCount:40});expect(cloud.state==='known'&&cloud.items.map(i=>i.quantity)).toEqual(['60','40','50']);});
 it('coalesces concurrent refresh and refreshes expiry',async()=>{let now=0;const refresh=vi.fn(async()=>({value:'token',expires:now+120000}));const token=new RefreshingToken(refresh,()=>now);await Promise.all(Array.from({length:20},()=>token.get()));expect(refresh).toHaveBeenCalledTimes(1);now=90000;await token.get();expect(refresh).toHaveBeenCalledTimes(2);});
 it.each([401,403,429,500,502,504])('does not retry generation on HTTP %s',async status=>{const {adapter:a,transport}=adapter('google_cloud','gemini-3.8-flash',{});transport.mockImplementation(async()=>new Response('{}',{status,headers:{'retry-after':'2'}}));const r=await a.execute(input('gemini-3.8-flash'),context());expect(transport).toHaveBeenCalledTimes(1);expect(r.outcome).toBe('failure');if(r.outcome==='failure')expect(r.failure.kind).toBe(status<429?'auth':'transient');});
 it('never sends after refresh failure and permits a later refresh',async()=>{
  let failed=true;const refresh=vi.fn(async()=>{if(failed)throw new Error('fixture auth unavailable');return {value:'fixture-token',expires:Date.now()+120000};});const token=new RefreshingToken(refresh),transport=vi.fn(async()=>new Response(JSON.stringify(answer('google_cloud'))));
  const a=createRegisteredAdapter('google_cloud',{apiKey:'fixture',models:['gemini-3.8-flash'],googleProject:'fixture-project',googleLocation:'global',googleToken:token,fetch:transport});
  const result=await a.execute(input('gemini-3.8-flash'),context());expect(result.outcome==='failure'&&result.failure).toMatchObject({kind:'auth',sent:false});expect(transport).not.toHaveBeenCalled();
  failed=false;expect((await a.execute(input('gemini-3.8-flash'),context())).outcome).toBe('success');expect(refresh).toHaveBeenCalledTimes(2);expect(transport).toHaveBeenCalledTimes(1);
 });
 it('returns multiple calls only with explicit supported parallel choice',async()=>{
  const body=callAnswer('groq');body.choices[0].message.tool_calls.push({id:'call-2',function:{name:'lookup',arguments:'{\"value\":\"green\"}'}});
  const {adapter:a}=adapter('groq','openai/gpt-oss-20b',body),i={...input('openai/gpt-oss-20b'),tools,tool_choice:{type:'auto' as const},parallel_tool_calls:true};
  const r=await a.execute(i,context());expect(r.outcome==='success'&&r.output.tool_calls?.map(c=>c.id)).toEqual(['call-1','call-2']);expect((await a.execute({...i,parallel_tool_calls:false},context())).outcome).toBe('failure');expect((await a.execute({...i,tool_choice:{type:'required'}},context())).outcome).toBe('failure');
 });
 it('keeps refusal and unavailable usage separate',async()=>{const {adapter:a}=adapter('google_cloud','gemini-3.8-flash',{promptFeedback:{blockReason:'SAFETY'}});const r=await a.execute(input('gemini-3.8-flash'),context());expect(r.outcome).toBe('refused');expect(r.usage.state).toBe('unknown');});
});
