import {describe,it,expect} from 'vitest';
import {AnthropicAdapter,type ProviderInput} from '../src/index.js';
const model='claude-haiku-5-5';
const schema={type:'object',properties:{seat:{type:'string',enum:['north','south']},instruction:{type:'string',minLength:1},note:{type:'string'}},required:['seat','instruction'],additionalProperties:false};
const base:ProviderInput={capability:'text.generate',model,input:'move',max_output_tokens:256};
const usage={input_tokens:10,output_tokens:4,cache_read_input_tokens:0,cache_creation_input_tokens:0};
async function send(input:ProviderInput,reply:Record<string,unknown>={stop_reason:'end_turn',usage,content:[{type:'text',text:'{"seat":"north","instruction":"go","note":{"present":false}}'}]}){
 let body:any;const adapter=new AnthropicAdapter({apiKey:'fixture',models:[input.model],fetch:async(_url,init)=>{body=JSON.parse(String(init.body));return Response.json(reply)}});
 const result=await adapter.execute(input,{attempt_id:'attempt',onUsage:async()=>{}});return {body,result};
}
const effort=(value:string)=>({...base,parameters:{reasoning_effort:value}});
describe('Claude Haiku 5.5 reasoning effort',()=>{
 it('leaves the request unchanged without the parameter, so the model keeps its own default',async()=>{
  const {body}=await send(base);
  expect(body).toEqual({model,messages:[{role:'user',content:[{type:'text',text:'move'}]}],max_tokens:256,stream:false});
 });
 it.each(['low','medium','high','xhigh','max'])('sends %s as output_config.effort without thinking or the internal name',async value=>{
  const {body}=await send(effort(value));
  expect(body.output_config).toEqual({effort:value});expect(body).not.toHaveProperty('thinking');expect(body).not.toHaveProperty('reasoning_effort');
 });
 it('puts effort and the response format into one output_config',async()=>{
  const {body,result}=await send({...effort('low'),response_schema:{name:'move',schema}});
  expect(Object.keys(body.output_config).sort()).toEqual(['effort','format']);
  expect(body.output_config).toMatchObject({effort:'low',format:{type:'json_schema',schema:{required:['seat','instruction','note'],additionalProperties:false}}});
  expect(result).toMatchObject({outcome:'success',output:{text:'{"seat":"north","instruction":"go"}'}});
 });
 it('sends none as disabled thinking with no effort, also next to a response format',async()=>{
  const plain=await send(effort('none'));
  expect(plain.body.thinking).toEqual({type:'disabled'});expect(plain.body).not.toHaveProperty('output_config');expect(plain.body).not.toHaveProperty('reasoning_effort');
  const structured=await send({...effort('none'),response_schema:{name:'move',schema}});
  expect(structured.body.thinking).toEqual({type:'disabled'});expect(Object.keys(structured.body.output_config)).toEqual(['format']);
 });
 it.each([
  [model,'ultra'],[model,'adaptive'],[model,''],[model,3],
  ['claude-opus-5-5','low'],['claude-sonnet-5-5','none'],['claude-haiku-4-5','low'],
 ])('rejects %s with reasoning_effort %j before sending',async(name,value)=>{
  let calls=0;const adapter=new AnthropicAdapter({apiKey:'fixture',models:[name],fetch:async()=>{calls++;return Response.json({})}});
  await expect(adapter.execute({...base,model:name,parameters:{reasoning_effort:value}},{attempt_id:'a',onUsage:async()=>{}})).rejects.toMatchObject({code:'invalid_reasoning_effort'});
  expect(calls).toBe(0);
 });
});
describe('Anthropic strict tools',()=>{
 it('marks every native tool strict with the provider-compatible schema and restores optional arguments',async()=>{
  const tools=[{name:'seat_move',description:'Move a seat',parameters:schema},{name:'pass',parameters:{type:'object',properties:{},additionalProperties:false}}];
  const {body,result}=await send({...effort('low'),tools,tool_choice:{type:'named',name:'seat_move'}},{stop_reason:'tool_use',usage,content:[{type:'tool_use',id:'call',name:'seat_move',input:{seat:'south',instruction:'wait',note:{present:true,value:'n'}}}]});
  expect(body.tools.map((t:any)=>t.strict)).toEqual([true,true]);
  const wire=body.tools[0].input_schema;
  // Strict mode rejects string and numeric constraints; the provider schema carries only the supported subset.
  expect(JSON.stringify(wire)).not.toMatch(/minLength|maximum|minimum|pattern|format"/);
  expect(wire).toMatchObject({type:'object',required:['seat','instruction','note'],additionalProperties:false,properties:{seat:{type:'string',enum:['north','south']}}});
  expect(body.tool_choice).toEqual({type:'tool',name:'seat_move',disable_parallel_tool_use:true});expect(body.output_config).toEqual({effort:'low'});
  expect(result).toMatchObject({outcome:'success',output:{tool_call:{name:'seat_move',arguments:{seat:'south',instruction:'wait',note:'n'},execution_method:'native'}}});
 });
});
