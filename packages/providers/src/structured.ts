import {providerSchema,validateStructured} from '../../contracts/schema.js';
import {validateToolCall,validateToolCalls} from './text-input.js';
import type {ProviderInput,ProviderResult} from './contracts.js';
type Output=Extract<ProviderResult,{outcome:'success'}>['output'];
export function structuredTransport(provider:string,input:ProviderInput,attemptId:string){
 const emulate=!!input.tools&&(input.tool_execution==='schema'||provider==='anthropic'&&/^claude-(?:opus-5[.-]5|fable-5[.-]1|mythos-5[.-]1)/.test(input.model));
 if(emulate){
  const tools=input.tools!.filter(t=>input.tool_choice?.type!=='named'||t.name===input.tool_choice.name);
  const original={type:'object',properties:{tool_call:{anyOf:tools.map(t=>({type:'object',properties:{name:{type:'string',const:t.name,description:t.description},arguments:t.parameters},required:['name','arguments'],additionalProperties:false}))}},required:['tool_call'],additionalProperties:false};
  const compiled=providerSchema(original);
  return {input:{...input,tools:undefined,tool_choice:undefined,response_schema:{name:'tool_call',schema:compiled.schema}},buffered:true,restore(output:Output){
   const value=compiled.restore(JSON.parse(output.text??'')) as any;
   const call=validateToolCall(input,[{...value.tool_call,id:`${attemptId}:tool`,execution_method:'schema'}]);
   return {...output,content_type:'application/json',text:JSON.stringify(call.arguments),tool_call:call};
  }};
 }
 if(input.tools){
  const compiled=new Map(input.tools.map(tool=>[tool.name,providerSchema(tool.parameters)]));
  return {input:{...input,tools:input.tools.map(t=>({...t,parameters:compiled.get(t.name)!.schema}))},buffered:[...compiled.values()].some(s=>s.transformed),restore(output:Output){
   const calls=output.tool_calls??(output.tool_call?[output.tool_call]:[]);
   const restored=calls.map(call=>({...call,arguments:compiled.get(call.name)!.restore(call.arguments) as Record<string,unknown>,execution_method:'native' as const}));validateToolCalls(input,restored);
   return restored.length===1?{...output,text:JSON.stringify(restored[0].arguments),tool_call:restored[0]}:restored.length?{...output,text:JSON.stringify(restored),tool_calls:restored}:output;
  }};
 }
 if(input.response_schema){const compiled=providerSchema(input.response_schema.schema);return {input:{...input,response_schema:{...input.response_schema,schema:compiled.schema}},buffered:compiled.transformed,restore(output:Output){const value=compiled.restore(JSON.parse(output.text??''));validateStructured(value,input.response_schema!.schema);return {...output,content_type:'application/json',text:JSON.stringify(value)};}};}
 return {input,buffered:false,restore:(output:Output)=>output};
}
