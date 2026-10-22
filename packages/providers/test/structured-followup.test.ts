import {it,expect} from 'vitest';
import {AnthropicAdapter,OpenAIAdapter,type ProviderInput} from '../src/index.js';
const schema={type:'object',properties:{note:{type:['string','null']}},additionalProperties:false};
const input:ProviderInput={capability:'text.generate',model:'claude-opus-5-5',input:'choose',max_output_tokens:100,tools:[{name:'save',parameters:schema}],tool_choice:{type:'named',name:'save'}};
const usage={input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0};
it('LF-A07 emulates forced tools through schema and restores optional nullable arguments',async()=>{
 let sent:any;const deltas:string[]=[];
 const adapter=new AnthropicAdapter({apiKey:'fixture',models:[input.model],fetch:async(_url,init)=>{sent=JSON.parse(String(init.body));return Response.json({stop_reason:'end_turn',usage,content:[{type:'text',text:JSON.stringify({tool_call:{name:'save',arguments:{note:{present:true,value:null}}}})}]});}});
 const result=await adapter.execute(input,{attempt_id:'a',onUsage:async()=>{}});
 expect(sent.tools).toBeUndefined();expect(sent.output_config.format.type).toBe('json_schema');
 expect(result).toMatchObject({outcome:'success',output:{tool_call:{name:'save',arguments:{note:null},execution_method:'schema'}}});
});
it('LF-A07 preserves refusal instead of attempting a tool or another request',async()=>{
 let calls=0;const adapter=new AnthropicAdapter({apiKey:'fixture',models:[input.model],fetch:async()=>{calls++;return Response.json({stop_reason:'refusal',usage,content:[{type:'text',text:'No'}]});}});
 expect(await adapter.execute(input,{attempt_id:'a',onUsage:async()=>{}})).toMatchObject({outcome:'refused'});expect(calls).toBe(1);
});
it('LF-A04 LF-A06 emits restored content only and keeps validation details',async()=>{
 const make=(text:string)=>new OpenAIAdapter({apiKey:'fixture',models:['fixture'],fetch:async()=>Response.json({status:'completed',usage:{input_tokens:1,output_tokens:2},output:[{type:'message',content:[{type:'output_text',text}]}]})});
 const structured={...input,model:'fixture',tools:undefined,tool_choice:undefined,response_schema:{name:'result',schema}};
 expect(await make('{"note":{"present":false}}').execute(structured,{attempt_id:'a',onUsage:async()=>{}})).toMatchObject({outcome:'success',output:{text:'{}'}});
 expect(await make('{"note":{"present":true,"value":1}}').execute(structured,{attempt_id:'a',onUsage:async()=>{}})).toMatchObject({outcome:'failure',failure:{kind:'defect',validation:{path:'/note',reason:'anyOf'}}});
});
