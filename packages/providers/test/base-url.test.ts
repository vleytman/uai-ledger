import {describe,it,expect} from 'vitest';
import {OpenAIAdapter,AnthropicAdapter,type ProviderInput} from '../src/index.js';
import {normalizeBaseUrl} from '../src/base-url.js';
// Records every outgoing request; the 400 reply keeps the adapter from parsing a fixture body it does not need.
function recorder(){const calls:{url:string;headers:Record<string,string>}[]=[];return {calls,fetch:async(url:string,init:RequestInit)=>{calls.push({url,headers:init.headers as Record<string,string>});return Response.json({error:{code:'fixture_stop'}},{status:400})}};}
const context={attempt_id:'attempt',onUsage:async()=>{}};
describe('provider base URL',()=>{
 it('sends OpenAI text and embeddings to the gateway with the key, and never to the official address',async()=>{
  const transport=recorder();
  const text:ProviderInput={capability:'text.generate',model:'gpt-6-luna',input:'hello',output_limit_policy:'provider_default'};
  const embeddings:ProviderInput={capability:'embeddings.generate',model:'text-embedding-3-small',input:'',texts:['first']};
  const adapter=new OpenAIAdapter({apiKey:'gateway-key',baseUrl:'https://gw.example.test/v1',models:[text.model,embeddings.model],fetch:transport.fetch});
  await adapter.execute(text,context);await adapter.execute(embeddings,context);
  expect(transport.calls.map(c=>c.url)).toEqual(['https://gw.example.test/v1/responses','https://gw.example.test/v1/embeddings']);
  expect(transport.calls.map(c=>c.headers.authorization)).toEqual(['Bearer gateway-key','Bearer gateway-key']);
  const image:ProviderInput={capability:'image.generate',model:'gpt-image-1',input:'cat'};
  expect(adapter.request(image,false).url).toBe('https://gw.example.test/v1/images/generations');
  expect(adapter.request({...image,assets:[{content_type:'image/png',bytes:new Uint8Array([1]),filename:'source.png'}]},false).url).toBe('https://gw.example.test/v1/images/edits');
 });
 it('appends the version to an unversioned Anthropic gateway, as the official SDK does',async()=>{
  const transport=recorder();const input:ProviderInput={capability:'text.generate',model:'claude-fixture',input:'hello',max_output_tokens:16};
  await new AnthropicAdapter({apiKey:'gateway-key',baseUrl:'https://gw.example.test',models:[input.model],fetch:transport.fetch}).execute(input,context);
  expect(transport.calls).toEqual([{url:'https://gw.example.test/v1/messages',headers:expect.objectContaining({'x-api-key':'gateway-key'})}]);
  expect(new AnthropicAdapter({apiKey:'k',models:[input.model]}).request(input,false).url).toBe('https://api.anthropic.com/v1/messages');
 });
 it('accepts the values of OPENAI_BASE_URL and ANTHROPIC_BASE_URL and strips the trailing slash',()=>{
  expect(normalizeBaseUrl('openai','https://GW.example.test/v1/',{})).toBe('https://gw.example.test/v1');
  expect(normalizeBaseUrl('anthropic','https://gw.example.test/',{})).toBe('https://gw.example.test');
  expect(normalizeBaseUrl('openai','https://gw.example.test:8443/proxy/openai/v1',{})).toBe('https://gw.example.test:8443/proxy/openai/v1');
  for(const host of ['localhost:8080','127.0.0.1','[::1]:9000'])expect(normalizeBaseUrl('openai',`http://${host}/v1`,{UAI_ENV:'test'})).toBe(`http://${host}/v1`);
 });
 it.each([
  ['openai','http://gw.example.test/v1',{UAI_ENV:'test'}],
  ['openai','http://localhost:8080/v1',{}],
  ['openai','http://localhost:8080/v1',{UAI_ENV:'production'}],
  ['openai','http://localhost.example.test/v1',{UAI_ENV:'test'}],
  ['openai','https://user:secret@gw.example.test/v1',{}],
  ['openai','https://user@gw.example.test/v1',{}],
  ['openai','https://gw.example.test/v1?key=1',{}],
  ['openai','https://gw.example.test/v1?',{}],
  ['openai','https://gw.example.test/v1#part',{}],
  ['openai','ftp://gw.example.test/v1',{}],
  ['openai','gw.example.test/v1',{}],
  ['openai',' https://gw.example.test/v1',{}],
  ['openai','',{}],
  ['openai',42,{}],
  ['openai',`https://gw.example.test/${'a'.repeat(2000)}`,{}],
  ['cartesia','https://gw.example.test',{}],
  ['google_cloud','https://gw.example.test',{}],
 ] as const)('rejects %s %j',(provider,value,env)=>{
  expect(()=>normalizeBaseUrl(provider,value,env)).toThrow(expect.objectContaining({code:'invalid_base_url'}));
 });
});
