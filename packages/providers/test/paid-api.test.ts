import {readFile} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {FirecrawlAdapter} from '../src/firecrawl.js';
import {SerperApiAdapter} from '../src/serper-api.js';
import {validateServiceOperation,validateApiSamples} from '../../api-services/src/index.js';
import {parseConfiguration} from '../../configuration/src/index.js';
import type {ProviderInput} from '../src/contracts.js';
async function input(provider:string,operation:string):Promise<ProviderInput>{
 const document=parseConfiguration(JSON.parse(await readFile(new URL(`../../../configurations/api/${provider}/${operation}.json`,import.meta.url),'utf8'))),catalog=document.resources.find(r=>r.kind==='catalog')!;
 const op=validateServiceOperation(catalog.payload.models[0].api),rate=document.resources.find(r=>r.kind==='rate_card')!;
 validateApiSamples(op,rate.payload as any,{at:'2026-09-23T00:00:00Z'});
 return {capability:'api.call',model:op.key,input:'',structured:op.samples[0].input,api_operation:op};
}
const context={attempt_id:'attempt-firecrawl-test',onUsage:async()=>{}};
describe('Paid provider protocols without external calls',()=>{
 it.each(['scrape','search','patent_search','patent_document'])('constructs %s from the published operation and reads native credits',async operation=>{
  const request=await input('firecrawl',operation);let wire:any;
  const body=operation==='search'?{success:true,data:{web:[]},creditsUsed:2}:operation.startsWith('patent_')?{success:true,data:{alexandria:[{data:{next_start:5}}],creditsCost:5}}:{success:true,data:{markdown:'Fixture',metadata:{creditsUsed:1}}};
  const adapter=new FirecrawlAdapter({apiKey:'synthetic',models:[request.model],fetch:async(url,init)=>{wire={url,init};return new Response(JSON.stringify(body));}});
  const result=await adapter.execute(request,context);expect(result.outcome).toBe('success');expect(result.usage).toMatchObject({state:'known',items:[{dimension:'credits',unit:'credits'}]});
  expect(wire.url).toBe(`https://api.firecrawl.dev/v2/${operation==='search'?'search':'scrape'}`);expect(wire.init.redirect).toBe('error');
  const posted=JSON.parse(wire.init.body);
  if(operation.startsWith('patent_')){expect(posted.alexandria).toMatchObject({provider:'uspto-gov',capability:`intellectual-property/${operation}`});expect(wire.init.headers['x-request-id']).toBe(context.attempt_id);}
  if(operation==='patent_document')expect(posted.alexandria.options.number).toBe('11234567');
 });
 it('preserves pagination, rejects unsupported paid options and explicit unsafe destinations',async()=>{
  const request=await input('firecrawl','patent_search'),adapter=new FirecrawlAdapter({apiKey:'synthetic',models:[request.model]});request.structured!.start=5;
  expect((adapter.request(request).body as any).alexandria.options.start).toBe(5);
  request.structured!.actions=[];expect(()=>adapter.validate(request)).toThrow();
  const scrape=await input('firecrawl','scrape');scrape.structured!.url='https://127.0.0.1/admin';expect(()=>new FirecrawlAdapter({apiKey:'synthetic',models:[scrape.model]}).validate(scrape)).toThrow();
 });
 it('keeps missing usage and transport failures unknown, and detects errors in HTTP 200',async()=>{
  const request=await input('firecrawl','patent_document');
  for(const body of [{success:true,data:{alexandria:[{error:{code:'invalid_document'}}],creditsCost:5}},{success:false,error:'Failure'}]){
   const adapter=new FirecrawlAdapter({apiKey:'synthetic',models:[request.model],fetch:async()=>new Response(JSON.stringify(body))});expect((await adapter.execute(request,context)).outcome).toBe('failure');
  }
  const absent=new FirecrawlAdapter({apiKey:'synthetic',models:[request.model],fetch:async()=>new Response(JSON.stringify({success:true,data:{alexandria:[]}}))});expect((await absent.execute(request,context)).usage.state).toBe('unknown');
  const timeout=new FirecrawlAdapter({apiKey:'synthetic',models:[request.model],fetch:async()=>{throw new Error('Synthetic timeout');}});expect(await timeout.execute(request,context)).toMatchObject({outcome:'unknown',failure:{safe_to_retry:false}});
  expect(timeout.classifyFailure(503,{code:'request_unresolved'})).toMatchObject({kind:'unknown',safe_to_retry:false});
 });
 it('marks provider-account credit snapshots estimated without invented coverage',async()=>{
  const adapter=new FirecrawlAdapter({apiKey:'synthetic',models:[],fetch:async()=>new Response(JSON.stringify({success:true,data:{remainingCredits:123,planCredits:1000,billingPeriodStart:'2026-09-01T00:00:00Z',billingPeriodEnd:'2026-10-01T00:00:00Z'}}))});
  expect(await adapter.readCreditUsage()).toMatchObject({remaining:'123',included:'1000',precision:'estimated',covered_through:null,scope:'provider_account'});
 });
 it('adapts Serper credits and input while preserving the legacy adapter',async()=>{
  const request=await input('serper','search');let body:any;
  const adapter=new SerperApiAdapter({apiKey:'synthetic',models:[request.model],fetch:async(_url,init)=>{body=JSON.parse(String(init.body));return new Response(JSON.stringify({organic:[],credits:2}));}});
  expect(await adapter.execute(request,context)).toMatchObject({outcome:'success',usage:{state:'known',items:[{dimension:'credits',quantity:'2',unit:'credits'}]}});expect(body).toEqual({q:'public patent information',num:10});
 });
});
