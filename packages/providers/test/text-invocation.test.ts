import {describe,it,expect} from 'vitest';
import {OpenAIAdapter,AnthropicAdapter,type ProviderInput} from '../src/index.js';
const schema={type:'object',properties:{count:{type:'integer',minimum:1}},required:['count'],additionalProperties:false};
const input:ProviderInput={capability:'text.generate',model:'fixture',input:'',max_output_tokens:100,messages:[{role:'user',content:[{type:'text',text:'before'},{type:'image',asset_id:'image'},{type:'text',text:'after'}]}],assets:[{filename:'image',content_type:'image/png',bytes:Buffer.from('original bytes')}],tools:[{name:'select',parameters:schema}],tool_choice:{type:'required'}};
const usage={input_tokens:10,output_tokens:4,input_tokens_details:{cached_tokens:0},cache_read_input_tokens:0,cache_creation_input_tokens:0};
for(const provider of ['openai','anthropic'] as const)describe(`UI-I03 ${provider} text contract`,()=>{
 function setup(calls:any[]=[{id:'call',name:'select',arguments:{count:1}}],stream=false){
  let sent:any;const body=provider==='openai'?{status:'completed',usage,output:calls.map(c=>({type:'function_call',call_id:c.id,name:c.name,arguments:JSON.stringify(c.arguments)}))}:{stop_reason:'tool_use',usage,content:calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:c.arguments}))};
  const Adapter=provider==='openai'?OpenAIAdapter:AnthropicAdapter;
  const adapter=new Adapter({apiKey:'fixture',models:['fixture'],fetch:async(_url,init)=>{sent=JSON.parse(String(init.body));return Response.json(body)}});
  const invoke=(value=input)=>adapter.execute(value,{attempt_id:'attempt',onUsage:async()=>{},...(stream?{onDelta:async()=>{}}:{})});
  return {adapter,invoke,sent:()=>sent};
 }
 it('preserves image bytes and position and requests exactly one call',async()=>{
  const test=setup(),result=await test.invoke();expect(result).toMatchObject({outcome:'success',output:{tool_call:{id:'call',name:'select',arguments:{count:1}}}});
  const body=test.sent(),blocks=(provider==='openai'?body.input:body.messages)[0].content;
  expect(blocks[0].text).toBe('before');expect(blocks[2].text).toBe('after');
  const base64=provider==='openai'?blocks[1].image_url.split(',')[1]:blocks[1].source.data;
  expect(Buffer.from(base64,'base64')).toEqual(input.assets![0].bytes);
  if(provider==='openai'){expect(body.parallel_tool_calls).toBe(false);expect(body.tool_choice).toBe('required');}
  else expect(body.tool_choice).toEqual({type:'any',disable_parallel_tool_use:true});
 });
 it('maps named selection',async()=>{
  const test=setup();await test.invoke({...input,tool_choice:{type:'named',name:'select'}});
  expect(test.sent().tool_choice).toMatchObject({type:provider==='openai'?'function':'tool',name:'select'});
 });
 it.each([[],[{id:'a',name:'select',arguments:{count:1}},{id:'b',name:'select',arguments:{count:2}}],[{id:'a',name:'other',arguments:{count:1}}],[{id:'a',name:'select',arguments:{count:0}}],[{id:'a',name:'select',arguments:{count:1,extra:true}}]].map(calls=>({calls})))('rejects missing, multiple or invalid calls: %j',async ({calls})=>{
  expect(await setup(calls).invoke()).toMatchObject({outcome:'failure',failure:{kind:'defect'}});
 });
 it('rejects undefined tool choice before transport',async()=>{
  const test=setup();await expect(test.invoke({...input,tool_choice:undefined})).rejects.toMatchObject({code:'invalid_tool_choice'});expect(test.sent()).toBeUndefined();
 });
});
it('Anthropic assembles streamed tool arguments across fragments',async()=>{
 const events=[{type:'message_start',message:{id:'response',usage}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool',name:'select',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"cou'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'nt":1}'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:4}},{type:'message_stop'}];
 const adapter=new AnthropicAdapter({apiKey:'fixture',models:['fixture'],fetch:async()=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''))});
 expect(await adapter.execute(input,{attempt_id:'a',onDelta:async()=>{},onUsage:async()=>{}})).toMatchObject({outcome:'success',output:{tool_call:{name:'select',arguments:{count:1}}}});
});
it('rejects unsupported published capabilities, unused images and unsupported cache TTL before transport',async()=>{
 const {validateTextFeatures}=await import('../src/text-input.js');
 expect(()=>validateTextFeatures(undefined,input)).toThrow();
 expect(()=>validateTextFeatures({tools:false,schema:false,image_media_types:['image/png'],image_detail:['auto'],cache:'none'},input)).toThrow();
 const adapter=new AnthropicAdapter({apiKey:'fixture',models:['fixture'],fetch:async()=>{throw Error('Transport must not run')}});
 await expect(adapter.execute({...input,messages:[{role:'user',content:[{type:'text',text:'hello',cache:{boundary:'stable_prefix',ttl_seconds:600}}]}],assets:[]},{attempt_id:'a',onUsage:async()=>{}})).rejects.toMatchObject({code:'unsupported_cache_ttl'});
 await expect(adapter.execute({...input,messages:[{role:'user',content:'hello'}]},{attempt_id:'a',onUsage:async()=>{}})).rejects.toMatchObject({code:'unreferenced_input_asset'});
});
