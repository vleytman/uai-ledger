import { describe,expect,it,vi } from 'vitest';
import { AnthropicAdapter,CartesiaAdapter,FakeAdapter,OpenAIAdapter,SerperAdapter,classifyFailure,normalizeAnthropic,normalizeOpenAI,sseEvents,type ProviderInput } from '../src/index.js';
const text:ProviderInput={capability:'text.generate',model:'fixture-text',input:'Hello',max_output_tokens:100};
const usage={input_tokens:100,input_tokens_details:{cached_tokens:20,cache_write_tokens:10},output_tokens:30,output_tokens_details:{reasoning_tokens:15}};
const response={id:'resp_fixture',status:'completed',usage,output:[{type:'message',content:[{type:'output_text',text:'Hello world'}]}]};
const ctx=()=>({attempt_id:'attempt_fixture',onUsage:vi.fn(async()=>{})});
describe('provider normalization',()=>{
  it('separates quota estimates from billing and never treats missing output estimates as zero',()=>{
   const adapter=new OpenAIAdapter({apiKey:'fixture',models:[text.model],maxInputTokens:1000});
   expect(adapter.estimateLimitUsage(text)).toEqual({requests:1,input_tokens:1000,output_tokens:100,tokens:1100});
   const uncapped={...text,max_output_tokens:undefined,output_limit_policy:'provider_default' as const};
   expect(adapter.estimateLimitUsage(uncapped)).toEqual({requests:1,input_tokens:1000});
   expect(adapter.estimateLimitUsage(uncapped,{expected_output_tokens:4096})).toEqual({requests:1,input_tokens:1000,output_tokens:4096,tokens:5096});
   expect(adapter.request(uncapped,false).body).not.toHaveProperty('expected_output_tokens');
   expect((adapter.request(uncapped,false).body as any).max_output_tokens).toBeUndefined();
   expect(adapter.estimateLimitUsage({...text,capability:'image.generate'})).toEqual({requests:1,images:1});
  });
  it.each([200,429])('reports safe quota headers on HTTP %i without exposing other headers',async status=>{
   const onRateLimits=vi.fn(async()=>{});const adapter=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch:async()=>Response.json(status===200?response:{error:{code:'rate_limit_exceeded'}},{status,headers:{'x-ratelimit-remaining-tokens':'123','retry-after':'2','set-cookie':'private'}})});
   await adapter.execute(text,{...ctx(),onRateLimits});
   expect(onRateLimits).toHaveBeenCalledOnce();expect(onRateLimits.mock.calls[0]).toEqual([expect.objectContaining({status,headers:{'x-ratelimit-remaining-tokens':'123','retry-after':'2'}})]);
  });
  it('subtracts OpenAI cache reads and writes once and does not add reasoning',()=>{const u=normalizeOpenAI(usage,text);expect(u).toMatchObject({state:'known',items:[{dimension:'input.uncached',quantity:'70'},{dimension:'input.cache_read',quantity:'20'},{dimension:'output.text',quantity:'30'},{dimension:'input.cache_write',quantity:'10'}],breakdown:{reasoning_tokens:'15'}});});
  it('treats Anthropic input as already uncached and splits cache write TTL',()=>{expect(normalizeAnthropic({input_tokens:10,output_tokens:20,cache_read_input_tokens:100,cache_creation_input_tokens:30,cache_creation:{ephemeral_5m_input_tokens:10,ephemeral_1h_input_tokens:20}})).toMatchObject({state:'known',items:[{quantity:'10'},{quantity:'100'},{quantity:'20'},{quantity:'10',conditions:{cache_ttl:'5m'}},{quantity:'20',conditions:{cache_ttl:'1h'}}]});});
  it('retains unknown cache TTL',()=>expect(normalizeAnthropic({input_tokens:1,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:3})).toMatchObject({state:'unknown',reason:'cache_write_ttl_unknown'}));
  it.each([null,{}, {input_tokens:0,output_tokens:0}, {input_tokens:10,input_tokens_details:{cached_tokens:15},output_tokens:2}])('missing or contradictory usage is unknown: %j',u=>expect(normalizeOpenAI(u,text).state).toBe('unknown'));
  it('keeps confirmed zero distinct from missing',()=>expect(normalizeOpenAI({input_tokens:0,input_tokens_details:{cached_tokens:0},output_tokens:0},text)).toMatchObject({state:'known',items:[{quantity:'0'},{quantity:'0'},{quantity:'0'}]}));
  it('requires write counters on current separately billed cache write families',()=>expect(normalizeOpenAI({input_tokens:10,input_tokens_details:{cached_tokens:0},output_tokens:1},{...text,model:'gpt-6-astra'}).state).toBe('unknown'));
  it('separates image input modalities without proportional attribution',()=>expect(normalizeOpenAI({input_tokens:30,input_tokens_details:{text_tokens:10,image_tokens:20},output_tokens:50},{...text,capability:'image.generate'})).toMatchObject({state:'known',items:[{quantity:'10',conditions:{modality:'text'}},{quantity:'20',conditions:{modality:'image'}},{dimension:'output.image',quantity:'50'}]}));
});
describe('HTTP adapter contract',()=>{
  it('audits usage before output validation even with malformed content',async()=>{const a=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch:async()=>Response.json({...response,output:[]})});const c=ctx();const r=await a.execute(text,c);expect(c.onUsage).toHaveBeenCalledOnce();expect(r).toMatchObject({outcome:'failure',failure:{kind:'defect'},usage:{state:'known'}});});
  it('propagates audit failures without hiding them as content errors',async()=>{const a=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch:async()=>Response.json(response)});await expect(a.execute(text,{attempt_id:'a',onUsage:async()=>{throw new Error('database unavailable');}})).rejects.toThrow('database unavailable');});
  it('sends structured constraints and never stores Responses content',async()=>{const fetch=vi.fn(async(_url:string,_init:RequestInit)=>Response.json(response));const a=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch});await a.execute({...text,instructions:'System',messages:[{role:'user',content:'User'}],response_schema:{name:'result',schema:{type:'object',properties:{},required:[],additionalProperties:false}}},ctx());expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({store:false,instructions:'System',input:[{role:'user',content:[{type:'input_text',text:'User'}]}],text:{format:{type:'json_schema'}}});});
  it('does not retry an unknown transport outcome',async()=>{const fetch=vi.fn(async()=>{throw new Error('connection reset');});const a=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch});expect(await a.execute(text,ctx())).toMatchObject({outcome:'unknown',usage:{state:'unknown'}});expect(fetch).toHaveBeenCalledOnce();});
  it('rejects unregistered endpoint/parameter before fetch',async()=>{const fetch=vi.fn();const a=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch});await expect(a.execute({...text,parameters:{baseURL:'https://bad.example'}},ctx())).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();});
  it('limits image requests to exactly one output',async()=>{const fetch=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({data:[{b64_json:'aGVsbG8='}],usage:{input_tokens:1,input_tokens_details:{text_tokens:1,image_tokens:0},output_tokens:1}}));const a=new OpenAIAdapter({apiKey:'fixture',models:['image'],fetch});expect((await a.execute({capability:'image.generate',model:'image',input:'draw'},ctx())).outcome).toBe('success');expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).n).toBe(1);});
  it('Cartesia binary output does not fabricate billed characters',async()=>{const a=new CartesiaAdapter({apiKey:'fixture',models:['sonic'],cartesiaVersion:'2026-08-14',fetch:async()=>new Response(new Uint8Array([1,2]))});expect(await a.execute({capability:'speech.synthesize',model:'sonic',input:'hello',parameters:{voice:'v',output_format:{container:'wav'}}},ctx())).toMatchObject({outcome:'success',usage:{state:'unknown'}});});
  it('Serper preserves reported credits and search content separately',async()=>{const a=new SerperAdapter({apiKey:'fixture',models:['search'],fetch:async()=>Response.json({credits:1,organic:[]})});expect(await a.execute({capability:'search',model:'search',input:'test'},ctx())).toMatchObject({outcome:'success',usage:{state:'known',items:[{quantity:'1',unit:'credits'}]}});});
  it.each([[429,{error:{code:'insufficient_quota'}},'quota'],[429,{},'transient'],[401,{},'auth'],[400,{},'invalid'],[503,{},'transient'],[undefined,{},'unknown']] as const)('classifies %s', (status,body,kind)=>expect(classifyFailure(status,body).kind).toBe(kind));
  it('fake scenarios are deterministic and record usage',async()=>{const a=new FakeAdapter([{outcome:'transient'},{outcome:'success',text:'done'}]);expect((await a.execute(text,ctx())).outcome).toBe('failure');expect(await a.execute(text,ctx())).toMatchObject({outcome:'success',output:{text:'done'}});expect(a.calls).toHaveLength(2);});
});
const streamResponse=(frames:unknown[])=>new Response(frames.map(f=>`data: ${JSON.stringify(f)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
describe('native streaming',()=>{
  it('OpenAI emits provider deltas and retains final usage',async()=>{const a=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch:async()=>streamResponse([{type:'response.output_text.delta',delta:'Hello '},{type:'response.output_text.delta',delta:'world'},{type:'response.completed',response}])});const onDelta=vi.fn(async(_delta:string)=>{});const r=await a.execute(text,{...ctx(),onDelta});expect(onDelta.mock.calls.map(c=>c[0])).toEqual(['Hello ','world']);expect(r).toMatchObject({outcome:'success',usage:{state:'known'}});});
  it('stream without terminal confirmation remains unknown',async()=>{const a=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch:async()=>streamResponse([{type:'response.output_text.delta',delta:'partial'}])});expect((await a.execute(text,{...ctx(),onDelta:async()=>{}})).outcome).toBe('unknown');});
  it('Anthropic merges cumulative usage rather than adding counters',async()=>{const a=new AnthropicAdapter({apiKey:'fixture',models:[text.model],fetch:async()=>streamResponse([{type:'message_start',message:{id:'m',usage:{input_tokens:10,cache_read_input_tokens:5,cache_creation_input_tokens:0,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hi'}},{type:'content_block_stop',index:0},{type:'message_delta',usage:{output_tokens:3},delta:{stop_reason:'end_turn'}},{type:'message_stop'}])});const r=await a.execute(text,{...ctx(),onDelta:async()=>{}});expect(r).toMatchObject({outcome:'success',usage:{state:'known',items:[{quantity:'10'},{quantity:'5'},{quantity:'3'}]}});});
  it('parses UTF8 events split across network chunks',async()=>{const encoded=new TextEncoder().encode('data: {"text":"Привет"}\n\n');let i=0;const response=new Response(new ReadableStream({pull(c){if(i===encoded.length)c.close();else c.enqueue(encoded.slice(i,i+=1));}}));const events=[];for await(const e of sseEvents(response))events.push(e);expect(events).toEqual([{event:'message',data:{text:'Привет'}}]);});
});

it('forwards a stable OpenAI cache routing key and rejects malformed keys before dispatch',async()=>{
 const transport=vi.fn(async()=>Response.json(response));
 const adapter=new OpenAIAdapter({apiKey:'fixture',models:[text.model],fetch:transport});
 const input={...text,parameters:{prompt_cache_key:'stable-test-key',prompt_cache_retention:'in_memory',service_tier:'default'}};
 await adapter.execute(input,ctx());
 expect(JSON.parse(String((transport.mock.calls as any)[0][1].body))).toMatchObject(input.parameters);
 for(const key of ['',12,'x'.repeat(65)])await expect(adapter.execute({...text,parameters:{prompt_cache_key:key}},ctx())).rejects.toMatchObject({code:'invalid_prompt_cache_key'});
 expect(transport).toHaveBeenCalledTimes(1);
});
