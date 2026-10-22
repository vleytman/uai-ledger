import {describe,it,expect,vi} from 'vitest';
import bundle from '../../../configurations/api/typesafe/jev.json';
import {TypeSafeAdapter} from '../src/typesafe.js';
import {JEV_MODEL,JEV_OPERATION,validateJevInput,validateJevResult} from '../../contracts/jev.js';
import {validateServiceOperation,validateOperationSchema,validateApiInput,priceApi} from '../../api-services/src/index.js';
import {parseConfiguration} from '../../configuration/src/index.js';
import type {ProviderInput} from '../src/contracts.js';
const op=validateServiceOperation((bundle.resources[1].payload as any).models[0].api);
const input:ProviderInput={capability:'api.call',model:JEV_OPERATION,input:'',structured:op.samples[0].input,api_operation:op};
const result={model:JEV_MODEL,answers:{urgent:{type:'noul',noul:0.5},team:{type:'choice',choice:'billing',probabilities:{billing:0.51,technical:0.49},confidence:0.001},severity:{type:'score',score:0.25,probabilities:{'0':0.75,'1':0.25},legend:{'0':'Low','1':'High'},confidence:0.1}},usage:{input_tokens:1000,output_tokens:30}};
function adapter(body:unknown=result,status=200,headers:Record<string,string>={}){const fetch=vi.fn(async(_url:string,_init:RequestInit)=>new Response(JSON.stringify(body),{status,headers}));return {a:new TypeSafeAdapter({apiKey:'fixture',models:[JEV_OPERATION],fetch}),fetch};}
const ctx=()=>({attempt_id:'fixture',onUsage:vi.fn(async(_observation:unknown)=>{})});
describe('Jev local contract and transport',()=>{
 it('validates the owner-configured file bundle and cost-plus sample',()=>{expect(parseConfiguration(bundle).bundle_key).toBe('typesafe.jev-1.13.0');expect(priceApi(op,{input_tokens:'1000'},bundle.resources[0].payload as any,{at:'2026-09-26T00:00:00Z'})).toBe('42000');});
 it('sends one mixed batch, preserves fractional score and low confidence',async()=>{const {a,fetch}=adapter(),context=ctx(),r=await a.execute(input,context);expect(r.outcome).toBe('success');expect(fetch).toHaveBeenCalledTimes(1);expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({model:JEV_MODEL,...input.structured});});
 it('keeps structured and negative JSON values',()=>{validateJevInput({state:{a:[-2,null,true]},questions:{q:{type:'noul',instructions:{question:'Valid?'},criteria:{true:['Yes']}}}});});
 it.each([{}, {state:'x',questions:{}},{...input.structured,model:'another'}, {state:'x',questions:{q:{type:'score',instructions:'Rate',criteria:['one']}}},{state:'x',questions:{q:{type:'noul',instructions:' '}}}])('rejects malformed input before dispatch %j',async value=>{const {a,fetch}=adapter();expect(()=>a.validate({...input,structured:value})).toThrow();expect(fetch).not.toHaveBeenCalled();});
 it('rejects cycles, infinite numbers and deep JSON',()=>{const cycle:any={};cycle.self=cycle;for(const state of [cycle,{n:Infinity},Array.from({length:9000},()=>0)])expect(()=>validateJevInput({...input.structured,state})).toThrow();});
 it('validates question-relative answers',()=>{for(const mutate of [(r:any)=>delete r.answers.urgent,(r:any)=>r.answers.urgent.confidence=0.5,(r:any)=>r.answers.team.choice='other',(r:any)=>r.answers.team.probabilities.billing=0.8,(r:any)=>r.answers.severity.score=1,(r:any)=>r.answers.severity.legend={'2':'wrong'},(r:any)=>r.answers.urgent.noul=NaN]){const r=structuredClone(result);mutate(r);expect(()=>validateJevResult(r,input.structured!.questions as any)).toThrow();}});
 it('preserves usage and actual model before a defect',async()=>{const body={...result,model:'different-model'}, {a}=adapter(body),context=ctx(),r=await a.execute(input,context);expect(r.outcome).toBe('failure');expect(r.usage.state).toBe('known');expect(context.onUsage.mock.calls[0]?.[0]).toMatchObject({raw_usage:{model:'different-model',requested_model:JEV_MODEL}});});
 it('does not fabricate provider request ID or missing usage',async()=>{const {a}=adapter({...result,usage:undefined});const r=await a.execute(input,ctx());expect(r.provider_request_id).toBeUndefined();expect(r.usage.state).toBe('unknown');});
 it.each([401,403,422,429,529,500,502])('classifies HTTP %i without retry',async status=>{const {a,fetch}=adapter({},status,{'retry-after':'3'}),r=await a.execute(input,ctx());expect(fetch).toHaveBeenCalledTimes(1);if(r.outcome==='success')throw Error();expect(r.failure.kind).toBe([401,403].includes(status)?'auth':status===422?'invalid':[429,529].includes(status)?'transient':'unknown');if([429,529].includes(status)){expect(r.failure.safe_to_retry).toBe(true);expect(r.failure.retry_after_ms).toBe(3000);}});
 it('propagates audit failure rather than authorizing resend',async()=>{const {a,fetch}=adapter();await expect(a.execute(input,{attempt_id:'a',onUsage:async()=>{throw Error('audit unavailable');}})).rejects.toThrow('audit unavailable');expect(fetch).toHaveBeenCalledTimes(1);});
 it('distinguishes pre-dispatch cancellation and transport loss',async()=>{const {a,fetch}=adapter();const abort=new AbortController();abort.abort();expect((await a.execute(input,{...ctx(),signal:abort.signal})).outcome).toBe('failure');expect(fetch).not.toHaveBeenCalled();const b=new TypeSafeAdapter({apiKey:'fixture',models:[JEV_OPERATION],fetch:async()=>{throw Error('lost');}});expect((await b.execute(input,ctx())).outcome).toBe('unknown');});
 it('does not claim a conservative monetary maximum',()=>{expect(adapter().a.estimateUsage(input).confidence).toBe('unavailable');});
 it('retains strict existing input schemas',()=>{expect(()=>validateOperationSchema({type:'object',additionalProperties:true},true)).toThrow();expect(()=>validateOperationSchema({type:'array',items:{type:'boolean'}},true)).toThrow();expect(()=>validateOperationSchema({anyOf:[{}]},true)).toThrow();expect(()=>validateApiInput(op,{...input.structured,extra:1})).toThrow();});
 it('validates the normal transport and uses the owner-selected 32768-token exposure',()=>{const a=new TypeSafeAdapter({apiKey:'unused',models:[JEV_OPERATION]});expect(()=>a.validate(input)).not.toThrow();expect(a.estimateUsage(input)).toMatchObject({confidence:'unavailable',maximum:{state:'known',items:[{quantity:'32768'}]}});expect(a.estimateLimitUsage(input)).toEqual({requests:1,tokens:32768,input_tokens:32768});});
 it('keeps zero usage known without a hidden minimum fee',()=>{const {a}=adapter();expect(a.normalizeUsage({usage:{input_tokens:0,output_tokens:0}})).toMatchObject({state:'known',items:[{quantity:'0'}],breakdown:{output_tokens:'0'}});expect(priceApi(op,{input_tokens:'0'},bundle.resources[0].payload as any,{at:'2026-09-26T00:00:00Z'},'0')).toBe('0');});
 it('enforces exact dictionary and string resource boundaries',()=>{
  const question={type:'choice',instructions:'Choose',criteria:Object.fromEntries(Array.from({length:255},(_,i)=>[String(i),null]))};
  validateJevInput({state:'x',questions:{q:question}});question.criteria.extra=null;expect(()=>validateJevInput({state:'x',questions:{q:question}})).toThrow();
  const questions=Object.fromEntries(Array.from({length:32},(_,i)=>[String(i),{type:'noul',instructions:'Valid?'}]));validateJevInput({state:'x',questions});questions.extra={type:'noul',instructions:'Valid?'};expect(()=>validateJevInput({state:'x',questions})).toThrow();
  expect(()=>validateJevInput({...input.structured,state:'a'.repeat(32769)})).toThrow();
 });
 it('does not expose malformed usage through a typed result',()=>{expect(validateJevResult({...result,usage:{input_tokens:'secret'}},input.structured!.questions as any).usage).toBeUndefined();});

 it('retains the provider request ID when the body is unreadable',async()=>{
  const a=new TypeSafeAdapter({apiKey:'fixture',models:[JEV_OPERATION],fetch:async()=>new Response('not JSON',{headers:{'x-request-id':'provider-123'}})});
  expect(await a.execute(input,ctx())).toMatchObject({outcome:'unknown',provider_request_id:'provider-123',usage:{state:'unknown',model_identity:{requested:JEV_MODEL}}});
 });
 it('bounds response bytes and treats post-send abort as an unknown outcome',async()=>{
  const a=new TypeSafeAdapter({apiKey:'fixture',models:[JEV_OPERATION],fetch:async()=>new Response('x'.repeat(1048577))});
  expect(await a.execute(input,ctx())).toMatchObject({outcome:'unknown',usage:{reason:'typesafe_response_unreadable'}});
  const abort=new AbortController();let sent=0;
  const b=new TypeSafeAdapter({apiKey:'fixture',models:[JEV_OPERATION],fetch:async(_url,init)=>{sent++;abort.abort();init.signal!.throwIfAborted();throw Error('unreachable');}});
  expect(await b.execute(input,{...ctx(),signal:abort.signal})).toMatchObject({outcome:'unknown',failure:{sent:true}});expect(sent).toBe(1);
 });
 it('does not fill in an absent actual model',async()=>{
  const {a}=adapter({...result,model:undefined});const r=await a.execute(input,ctx());
  expect(r.outcome).toBe('failure');expect(r.usage.model_identity).toEqual({requested:JEV_MODEL});
 });

});
