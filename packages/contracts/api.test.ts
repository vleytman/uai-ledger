import {describe,test,expect} from 'vitest';
import {apiSchemas,apiEndpoints} from './api.js';
import {buildOpenApi,generateOpenApi} from '../../scripts/generate-openapi.js';
import {createApi} from '../../apps/api/src/server.js';
import type pg from 'pg';

describe('Shared HTTP schemas and generated API contract',()=>{
 test('all declared routes exist in Fastify and operation identities are unique',async()=>{
  const db={query:async()=>{throw new Error('Contract inspection must not query a database');}} as unknown as pg.Pool;
  const app=createApi(db);await app.ready();try{
   for(const endpoint of apiEndpoints)expect(app.hasRoute({method:endpoint.method.toUpperCase() as any,url:endpoint.path.replace(/\{([^}]+)\}/g,':$1')}),`${endpoint.method} ${endpoint.path}`).toBe(true);
   expect(new Set(apiEndpoints.map(e=>e.operationId)).size).toBe(apiEndpoints.length);
  }finally{await app.close();}
 });
 test('amounts remain strings and uploads require the exact digest and bounded byte size',()=>{
  const base={amount_units:'9007199254740993',source:'purchase',external_reference:'p1',terms_version:'v1',expires_at:null,reason:'test'};
  expect(apiSchemas.GrantBody.parse(base).amount_units).toBe('9007199254740993');
  expect(()=>apiSchemas.GrantBody.parse({...base,amount_units:100})).toThrow();expect(()=>apiSchemas.GrantBody.parse({...base,amount_units:'9223372036854775808'})).toThrow();
  expect(apiSchemas.UploadBody.parse({account_id:'a',media_type:'image/png',size_bytes:16,content_hash:`sha256:${'a'.repeat(64)}`})).toBeDefined();
  expect(()=>apiSchemas.UploadBody.parse({account_id:'a',media_type:'image/png',size_bytes:16777217,content_hash:`sha256:${'a'.repeat(64)}`})).toThrow();
  expect(()=>apiSchemas.UploadBody.parse({account_id:'a',media_type:'image/png',size_bytes:16,content_hash:'sha256:invalid'})).toThrow();
 });
 test('OpenAPI describes binary upload MIME, SSE replay and financial command headers',()=>{
  const document=buildOpenApi() as any;
  expect(document.paths['/v1/assets/{id}/upload'].put.requestBody.content['application/octet-stream'].schema.format).toBe('binary');
  expect(document.paths['/v1/events'].get.responses['200'].content['text/event-stream']).toBeDefined();
  expect(document.paths['/v1/events'].get.parameters.some((p:any)=>p.name==='Last-Event-ID')).toBe(true);
  expect(document.paths['/v1/wallets/{id}/grants'].post.parameters.some((p:any)=>p.name==='Idempotency-Key'&&p.required)).toBe(true);
  expect(document.components.schemas.Wallet.properties.balance_units.type).toBe('string');
 });
 test('checked-in OpenAPI and SDK outputs match their runtime schema source',async()=>{await expect(generateOpenApi({check:true})).resolves.toMatchObject({routes:apiEndpoints.length});});
});
