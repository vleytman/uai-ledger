import {it,expect} from 'vitest';
import {OpenAIAdapter} from '../src/index.js';
import {VoyageAdapter} from '../src/voyage.js';
import {embeddingDimensions,validateEmbeddingInput} from '../src/embeddings.js';
import {InvocationResult} from '../../contracts/invocation.js';
it('LF-A01 Large supports 3072 dimensions and model-specific shortened vectors',async()=>{
 const input={capability:'embeddings.generate' as const,model:'text-embedding-3-large',input:'',texts:['one']};
 const adapter=new OpenAIAdapter({apiKey:'fixture',models:[input.model],fetch:async()=>Response.json({model:input.model,data:[{index:0,embedding:Array(3072).fill(.1)}],usage:{prompt_tokens:1,total_tokens:1}})});
 const result=await adapter.execute(input,{attempt_id:'fixture',onUsage:async()=>{}});
 expect(result.outcome).toBe('success');if(result.outcome==='success')expect(InvocationResult.parse({type:'embeddings',...result.output.embeddings})).toMatchObject({dimensions:3072,revision:null});
 expect(embeddingDimensions(input.model,2048)).toBe(2048);expect(()=>embeddingDimensions(input.model,3073)).toThrow();
});
it.each(['query','document'])('LF-A02 Voyage sends %s without truncation and reports only known identity',async input_type=>{
 let body:any;
 const input={capability:'embeddings.generate' as const,model:'voyage-4',input:'',texts:['one','two'],parameters:{dimensions:256,input_type}};
 const adapter=new VoyageAdapter({apiKey:'fixture',models:[input.model],fetch:async(url,init)=>{expect(url).toBe('https://api.voyageai.com/v1/embeddings');body=JSON.parse(String(init.body));return Response.json({data:[1,0].map(index=>({index,embedding:Array(256).fill(.2)})),usage:{total_tokens:4}})}});
 const result=await adapter.execute(input,{attempt_id:'fixture',onUsage:async()=>{}});
 expect(body).toEqual({model:'voyage-4',input:input.texts,input_type,output_dimension:256,output_dtype:'float',truncation:false});
 expect(result).toMatchObject({outcome:'success',output:{embeddings:{model:'voyage-4',dimensions:256,revision:null,data:[{index:0},{index:1}]}},usage:{state:'known',items:[{quantity:'4'}]}});
});
it('LF-A01 LF-A03 rejects unsupported dimensions, type, long input and unrequested models before dispatch',()=>{
 const input={model:'voyage-4',texts:['x'],parameters:{dimensions:256}};
 for(const changed of [{parameters:{dimensions:257}},{parameters:{input_type:'other'}},{model:'voyage-4-lite'},{texts:['a'.repeat(32001)]},{model:'text-embedding-3-large',parameters:{input_type:'query'}}])expect(()=>validateEmbeddingInput({...input,...changed})).toThrow();
});
