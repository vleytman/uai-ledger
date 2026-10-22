import {it,expect} from 'vitest';
import sharp from 'sharp';
import {QuiverAdapter,quiverUsage} from '../src/quiver.js';
import {ReplicateAdapter} from '../src/replicate.js';
import {RECRAFT_STYLES,RECRAFT_VECTORIZE,QUIVER_MODELS} from '../src/svg-input.js';
import {validateOutput} from '../../execution/src/runtime.js';
import type {ProviderInput} from '../src/contracts.js';
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="32"/></svg>';
const raster=async()=>({filename:'reference',content_type:'image/png',bytes:await sharp({create:{width:256,height:256,channels:3,background:'blue'}}).png().toBuffer()});
const context=()=>({attempt_id:'fixture',onUsage:async()=>{}});
const usage={input_tokens:100,output_tokens:80,total_tokens:180,input_tokens_details:{cached_tokens:20,cache_write_tokens:10},output_tokens_details:{reasoning_tokens:30}};
it('rejects Quiver sandbox keys before dispatch and never delivers a sandbox response as real output',async()=>{
 const input:ProviderInput={model:'arrow-2',capability:'image.generate',input:'Blue circle',max_output_tokens:128};let calls=0;
 const test=new QuiverAdapter({apiKey:'sk_test_fixture',models:['arrow-2'],fetch:async()=>{calls++;throw Error('must not send')}});
 await expect(test.execute(input,context())).rejects.toMatchObject({code:'quiver_sandbox_key'});expect(calls).toBe(0);
 const live=new QuiverAdapter({apiKey:'fixture',models:['arrow-2'],fetch:async()=>Response.json({usage,data:[{mime_type:'image/svg+xml',svg}]},{headers:{'x-quiver-environment':'test'}})});
 expect(await live.execute(input,context())).toMatchObject({outcome:'failure',failure:{code:'quiver_sandbox_response',safe_to_retry:false}});
});
it('LF-A15 disjoint Quiver quantities retain reasoning only as an output breakdown',()=>{
 expect(quiverUsage(usage)).toMatchObject({state:'known',items:[{quantity:'70'},{quantity:'20'},{quantity:'10'},{quantity:'80'}],breakdown:{reasoning_tokens:'30'}});
 // No cache split at all: every input token is priced at the highest input rate, cache write.
 expect(quiverUsage({input_tokens:100,output_tokens:80,total_tokens:180})).toEqual({state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'0'},{dimension:'input.cache_read',unit:'tokens',quantity:'0'},{dimension:'input.cache_write',unit:'tokens',quantity:'100'},{dimension:'output.text',unit:'tokens',quantity:'80'}],breakdown:{input_cache_split:'absent_priced_as_cache_write'}});
 for(const value of [{...usage,input_tokens_details:{cached_tokens:20}},{input_tokens:100,output_tokens:80,total_tokens:179},{...usage,total_tokens:179},{...usage,input_tokens_details:{cached_tokens:100,cache_write_tokens:1}},{...usage,output_tokens_details:{reasoning_tokens:81}}])expect(quiverUsage(value).state).toBe('unknown');
});
it.each(QUIVER_MODELS)('LF-A13 Quiver %s generates and vectorizes through exact endpoints',async model=>{
 for(const vector of [false,true]){let body:any,url='';const asset=await raster();const adapter=new QuiverAdapter({apiKey:'fixture',models:[model],fetch:async(u,init)=>{url=u;body=JSON.parse(String(init.body));return Response.json({id:'fixture-result',usage,data:[{mime_type:'image/svg+xml',svg}]});}});
 const result=await adapter.execute({capability:vector?'image.vectorize':'image.generate',input:vector?'':'Blue circle',model,assets:[asset],max_output_tokens:512},{...context()});
 expect(url).toBe(`https://api.quiver.ai/v1/svgs/${vector?'vectorizations':'generations'}`);expect(body[vector?'image':'references']).toEqual(vector?{base64:Buffer.from(asset.bytes).toString('base64')}:[{base64:Buffer.from(asset.bytes).toString('base64')}]);expect(result.outcome).toBe('success');if(result.outcome==='success')await validateOutput(result.output);
 }
});
it.each([...RECRAFT_STYLES,RECRAFT_VECTORIZE])('LF-A12 LF-A13 Replicate %s passes originals, polls and drops style ID',async model=>{
 const vector=model===RECRAFT_VECTORIZE,asset=await raster();const calls:{url:string;init:RequestInit}[]=[],observations:unknown[]=[];
 const adapter=new ReplicateAdapter({apiKey:'fixture',models:[model],fetch:async(url,init)=>{calls.push({url,init});if(url.endsWith('/cancel'))return Response.json({});if(init.method==='POST')return Response.json({id:'job-1'});if(url.includes('api.replicate.com'))return Response.json({id:'job-1',model,status:'succeeded',output:vector?'https://replicate.delivery/result.svg':{image:'https://replicate.delivery/result.svg',style_id:'must-not-persist'}});return new Response(svg);}});
 const input:ProviderInput={model,capability:vector?'image.vectorize':'image.generate',input:vector?'':'Blue circle',assets:[asset]};let job='';const ctx={...context(),onUsage:async(v:unknown)=>{observations.push(v)},onRemoteJob:async(id:string)=>{job=id}};
 await adapter.submitNative(input,ctx);expect(job).toBe('job-1');expect(calls[0].url).toBe(`https://api.replicate.com/v1/models/${model}/predictions`);const submitted=JSON.parse(String(calls[0].init.body)).input;expect(vector?submitted.image:submitted.style_reference_images[0]).toBe(`data:image/png;base64,${Buffer.from(asset.bytes).toString('base64')}`);
 const result=await adapter.lookupNative(job,ctx);expect(result.outcome).toBe('success');expect(JSON.stringify([result,observations])).not.toContain('must-not-persist');expect(calls.at(-1)?.init.headers).toBeUndefined();if(result.outcome==='success')await validateOutput(result.output);await adapter.cancelNative(job,ctx);expect(calls.at(-1)?.url).toMatch(/\/job-1\/cancel$/);
});
it('LF-A14 SVG blocks active content and external references',async()=>{
 for(const content of ['<script>alert(1)</script>','<style>path {fill:red}</style>','<path fill="url(https://example.com/private)"/>','<image href="file:///tmp/a"/>','<animate attributeName="href" values="javascript:alert(1)"/>'])await expect(validateOutput({content_type:'image/svg+xml',text:svg.replace('<circle cx="128" cy="128" r="32"/>',content)})).rejects.toMatchObject({code:'result_defect'});
});
it('LF-A16 no replay after transport/5xx and cancellation before send has no request',async()=>{
 for(const response of [undefined,new Response('{}',{status:500})]){let calls=0;const adapter=new QuiverAdapter({apiKey:'fixture',models:['arrow-2'],fetch:async()=>{calls++;if(!response)throw Error('lost');return response}});const input:ProviderInput={model:'arrow-2',capability:'image.generate',input:'circle',max_output_tokens:128};expect((await adapter.execute(input,context())).outcome).toBe('unknown');expect(calls).toBe(1);const controller=new AbortController();controller.abort();expect(await adapter.execute(input,{...context(),signal:controller.signal})).toMatchObject({outcome:'failure',failure:{sent:false}});expect(calls).toBe(1);}
});
it('LF-A12 rejects stored style IDs and bad raster before a network call',async()=>{
 let calls=0;const adapter=new ReplicateAdapter({apiKey:'fixture',models:RECRAFT_STYLES,fetch:async()=>{calls++;throw Error('forbidden')}});
 const input:ProviderInput={model:RECRAFT_STYLES[0],capability:'image.generate',input:'circle',assets:[await raster()]};
 await expect(adapter.submitNative({...input,parameters:{style_id:'x'}},context())).rejects.toMatchObject({code:'unsupported_parameter'});
 await expect(adapter.submitNative({...input,assets:[{...input.assets![0],bytes:Buffer.from('bad')}]},context())).rejects.toMatchObject({code:'invalid_asset'});expect(calls).toBe(0);
});
