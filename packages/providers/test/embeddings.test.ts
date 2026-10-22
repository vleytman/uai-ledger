import {it,expect} from 'vitest';
import {OpenAIAdapter,type ProviderInput} from '../src/index.js';
import {validateEmbeddingOutput,embeddingUsage,validateEmbeddingInput} from '../src/embeddings.js';
import {inputTokens} from '../../model-pricing/src/tokenization.js';
const input:ProviderInput={capability:'embeddings.generate',model:'text-embedding-3-small',input:'',texts:['first','second'],parameters:{dimensions:2}};
const data=[{index:1,embedding:[.3,.4]},{index:0,embedding:[.1,.2]}];
it('UI-A19 sends one atomic batch, restores index order and retains batch usage',async()=>{
 let sent:any,calls=0;const observations:any[]=[];
 const adapter=new OpenAIAdapter({apiKey:'fixture',models:[input.model],fetch:async(url,init)=>{calls++;expect(url).toBe('https://api.openai.com/v1/embeddings');sent=JSON.parse(String(init.body));return Response.json({model:input.model,data,usage:{prompt_tokens:2,total_tokens:2}})}});
 const result=await adapter.execute(input,{attempt_id:'a',onUsage:async value=>{observations.push(value)}});
 expect(sent).toEqual({model:input.model,input:['first','second'],dimensions:2,encoding_format:'float'});expect(calls).toBe(1);expect(result).toMatchObject({outcome:'success',output:{embeddings:{model:input.model,dimensions:2,data:[data[1],data[0]]}},usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'2'}]}});expect(observations).toHaveLength(1);
 expect(adapter.estimateLimitUsage(input)).toEqual({requests:1,input_tokens:2,tokens:2});
});
it.each([[],[data[0]],[data[0],data[0]],[{index:0,embedding:[1]},data[0]],[{index:0,embedding:[NaN,2]},data[0]],[{index:4,embedding:[1,2]},data[0]]].map(bad=>({bad})))('UI-A19 rejects malformed or partial vectors atomically: %j',({bad})=>{
 expect(()=>validateEmbeddingOutput({model:input.model,data:bad},input)).toThrow();
});
it('rejects unknown model, invalid dimension and oversized input before sending',()=>{
 for(const changed of [{texts:[]},{texts:['']},{texts:Array(129).fill('x')},{texts:Array(11).fill('x'),parameters:{}},{model:'text-embedding-ada-002'},{parameters:{dimensions:1537}},{texts:['x'.repeat(32769)]}])expect(()=>validateEmbeddingInput({...input,...changed})).toThrow();
 expect(()=>validateEmbeddingOutput({model:input.model,dimensions:3,data},input)).toThrow();
 expect(embeddingUsage({prompt_tokens:10,total_tokens:11})).toMatchObject({state:'unknown'});
 expect(inputTokens({texts:input.texts},'cl100k_base','embedding_batch')).toBe(input.texts!.reduce((sum,text)=>sum+inputTokens({text},'cl100k_base','prompt'),0));
 expect(()=>inputTokens({texts:input.texts},'cl100k_base','prompt')).toThrow();
});
it('preserves known usage when provider returns a defective batch',async()=>{
 const adapter=new OpenAIAdapter({apiKey:'fixture',models:[input.model],fetch:async()=>Response.json({model:input.model,data:[data[0]],usage:{prompt_tokens:2,total_tokens:2}})});
 expect(await adapter.execute(input,{attempt_id:'a',onUsage:async()=>{}})).toMatchObject({outcome:'failure',failure:{kind:'defect'},usage:{state:'known'}});
});
