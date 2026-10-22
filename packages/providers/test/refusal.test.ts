import {it,expect} from 'vitest';
import {OpenAIAdapter,AnthropicAdapter} from '../src/index.js';
it.each(['openai','anthropic'])('UI-A05 %s normalizes refusal without retry or schema parsing',async provider=>{
 let calls=0;
 const body=provider==='openai'?{id:'provider-request',status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'Declined'}]}]}:{id:'provider-request',stop_reason:'refusal',content:[{type:'text',text:'Declined'}]};
 const options={apiKey:'fixture',models:['fixture'],fetch:async()=>{calls++;return new Response(JSON.stringify(body),{status:200})}};
 const adapter=provider==='openai'?new OpenAIAdapter(options):new AnthropicAdapter(options);
 const result=await adapter.execute({capability:'text.generate',model:'fixture',input:'fixture',max_output_tokens:20,response_schema:{name:'result',schema:{type:'object',properties:{},additionalProperties:false}}},{attempt_id:'attempt',onUsage:async()=>{}});
 expect(result).toMatchObject({outcome:'refused',refusal:'Declined',usage:{state:'unknown'}});expect(calls).toBe(1);
});
