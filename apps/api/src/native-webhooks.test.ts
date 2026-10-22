import Fastify from 'fastify';
import {describe,it,expect,vi} from 'vitest';
import type pg from 'pg';
import {request as httpRequest} from 'node:http';
import {DomainError} from '../../../packages/contracts/src/index.js';
import {registerNativeWebhooks} from './native-webhooks.js';
describe('Native webhook HTTP boundary',()=>{
 it('preserves original JSON bytes, derives scope from storage, and keeps the normal JSON parser',async()=>{
  const scope={organization_id:'org-stored',application_id:'app-stored',account_id:'account-stored'};
  const query=vi.fn().mockResolvedValue({rows:[scope]}),receive=vi.fn().mockResolvedValue({worked:true});
  const app=Fastify();app.post('/normal',async request=>({parsed:!Buffer.isBuffer(request.body),body:request.body}));registerNativeWebhooks(app,{query} as unknown as pg.Pool,receive);
  const body='{ "organization_id": "untrusted",\n "data": [1, 2] }\n';
  try{
   const result=await app.inject({method:'POST',url:'/v1/provider-webhooks/req_test',headers:{'content-type':'application/json','x-signature':'exact-signature'},payload:body});
   expect(result.statusCode).toBe(200);expect(result.json()).toEqual({accepted:true});expect(result.headers['cache-control']).toBe('no-store');
   expect(receive.mock.calls[0][0]).toEqual(scope);expect(receive.mock.calls[0][1]).toBe('req_test');expect(Buffer.from(receive.mock.calls[0][2]).toString()).toBe(body);expect(receive.mock.calls[0][3]['x-signature']).toBe('exact-signature');
   expect(query.mock.calls[0][1]).toEqual(['req_test']);
   const address=await app.listen({host:'127.0.0.1',port:0});
   // inject normalizes header arrays; use a real loopback socket for duplicates.
   const ambiguous=await new Promise<number>((resolve,reject)=>{
    const call=httpRequest(new URL('/v1/provider-webhooks/req_test',address),{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-signature':['one','two']}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!))});
    call.on('error',reject);call.end(body);
   });
   expect(ambiguous).toBe(400);expect(receive).toHaveBeenCalledTimes(1);
   expect((await app.inject({method:'POST',url:'/normal',payload:{value:1}})).json()).toEqual({parsed:true,body:{value:1}});
   receive.mockRejectedValueOnce(new DomainError('invalid_webhook_signature','private signature detail'));
   const rejected=await app.inject({method:'POST',url:'/v1/provider-webhooks/req_test',headers:{'content-type':'application/json'},payload:body});expect(rejected.statusCode).toBe(401);expect(rejected.body).not.toContain('private');
   receive.mockRejectedValueOnce(new Error('private provider context'));
   const unavailable=await app.inject({method:'POST',url:'/v1/provider-webhooks/req_test',payload:{}});expect(unavailable.statusCode).toBe(503);expect(unavailable.body).not.toContain('private');
  }finally{await app.close()}
 });
 it('rejects oversized bodies and unknown requests before receiver execution',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[]}),receive=vi.fn(),app=Fastify();registerNativeWebhooks(app,{query} as unknown as pg.Pool,receive);
  try{
   expect((await app.inject({method:'POST',url:'/v1/provider-webhooks/req_missing',payload:{}})).statusCode).toBe(404);
   expect((await app.inject({method:'POST',url:'/v1/provider-webhooks/req_missing',headers:{'content-type':'application/json'},payload:'x'.repeat(1024*1024+1)})).statusCode).toBe(413);
   expect(query).toHaveBeenCalledTimes(1);expect(receive).not.toHaveBeenCalled();
  }finally{await app.close()}
 });
});
