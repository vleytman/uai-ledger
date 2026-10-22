import {describe,it,expect} from 'vitest';
import {UaiClient,decodeExternalIdentity,EXTERNAL_IDENTITY_HEADER,type ExternalIdentity} from './index.js';
const identity:ExternalIdentity={version:1,kind:'user',user_id:'person',account_id:'team-a'};
describe('SDK external identity transports',()=>{
 it('snapshots caller options and isolates concurrent clients and service-only calls',async()=>{
  const seen:Headers[]=[];const options={baseUrl:'http://uai.test',token:'original',identity:{...identity},fetch:async(_url:unknown,init?:RequestInit)=>{seen.push(new Headers(init?.headers));return Response.json({})}};
  const client=new UaiClient(options);options.identity.account_id='changed';options.token='changed';
  const other=client.forIdentity({...identity,account_id:'team-b'});
  await Promise.all([client.wallets.get('a'),other.wallets.get('b'),new UaiClient({...options,identity:undefined}).wallets.get('c')]);
  expect(seen.map(h=>h.get(EXTERNAL_IDENTITY_HEADER)).slice(0,2).map(h=>decodeExternalIdentity(h!).kind==='user'&&decodeExternalIdentity(h!))).toEqual([identity,{...identity,account_id:'team-b'}]);
  expect(seen[0].get('authorization')).toBe('Bearer original');expect(seen[2].has(EXTERNAL_IDENTITY_HEADER)).toBe(false);expect(Object.isFrozen(client.identity)).toBe(true);
 });
 it('carries one context through HTTP, upload, download, and SSE',async()=>{
  const seen:Headers[]=[];const client=new UaiClient({baseUrl:'http://uai.test',token:'test',identity,fetch:async(url,init)=>{
   seen.push(new Headers(init?.headers));
   if(String(url).includes('/events?'))return new Response('data: {"id":"e"}\n\n');
   if(String(url).endsWith('/content'))return new Response(new Uint8Array([1,2]));
   return Response.json({asset_id:'asset'});
  }});
  await client.wallets.get('wallet');await client.assets.upload({account_id:'team-a',media_type:'image/png',size_bytes:2,content_hash:'sha256:abc'},new Uint8Array([1,2]),'upload-key');
  expect(await client.assets.download('asset')).toEqual(new Uint8Array([1,2]));for await(const event of client.events({account_id:'team-a'}))expect(event.id).toBe('e');
  expect(seen).toHaveLength(6);for(const headers of seen)expect(decodeExternalIdentity(headers.get(EXTERNAL_IDENTITY_HEADER)!)).toEqual(identity);
 });
 it('retries exactly the same context, key and body after transport failure',async()=>{
  const seen:RequestInit[]=[];const source={...identity};const client=new UaiClient({baseUrl:'http://uai.test',token:'test',identity:source,fetch:async(_url,init)=>{seen.push(init!);if(seen.length===1){source.account_id='team-b';throw new Error('lost response')}return Response.json({id:'same'})}});
  await client.request('POST','/v1/operations',{account_id:'team-a'},{key:'same-key'});
  expect(seen).toHaveLength(2);expect(seen[0].body).toBe(seen[1].body);expect(seen[0].headers).toEqual(seen[1].headers);
  expect(new Headers(seen[1].headers).get('idempotency-key')).toBe('same-key');expect(decodeExternalIdentity(new Headers(seen[1].headers).get(EXTERNAL_IDENTITY_HEADER)!)).toEqual(identity);
 });
 it.each([{}, {capabilities:{}},{capabilities:{external_identity:0}},{capabilities:{external_identity:2}},{capabilities:{external_identity:'1'}}])('fails closed on unsupported capability %j',async result=>{
  const client=new UaiClient({baseUrl:'http://uai.test',token:'test',fetch:async()=>Response.json(result)});await expect(client.assertExternalIdentitySupport()).rejects.toThrow('does not support');
 });
 it('accepts the exact supported capability version',async()=>{
  const client=new UaiClient({baseUrl:'http://uai.test',token:'test',fetch:async(url)=>{expect(String(url)).toBe('http://uai.test/health');return Response.json({capabilities:{external_identity:1}})}});await expect(client.assertExternalIdentitySupport()).resolves.toBeUndefined();
 });
});
