import {createServer} from 'node:http';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createBlobStore} from './blob-store.js';

describe('shared S3 blob transport',()=>{
 const objects=new Map<string,Buffer>();
 let version='',locked=false,denyPolicy=false;
 let writes=0,deletes=0;
 const server=createServer(async(req,res)=>{
  expect(req.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  const url=new URL(req.url!,'http://localhost'),key=url.pathname;
  if(url.searchParams.has('versioning')){
   res.setHeader('Content-Type','application/xml');
   if(denyPolicy){res.writeHead(403);res.end('<Error><Code>AccessDenied</Code></Error>');return;}
   res.end(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${version?`<Status>${version}</Status>`:''}</VersioningConfiguration>`);return;
  }
  if(url.searchParams.has('object-lock')){
   res.setHeader('Content-Type','application/xml');
   if(locked){res.end('<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>');return;}
   res.writeHead(404);res.end('<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>');return;
  }
  if(req.method==='PUT'){
   writes++;
   expect(req.headers['if-none-match']).toBe('*');
   if(objects.has(key)){res.writeHead(412,{'Content-Type':'application/xml'});res.end('<Error><Code>PreconditionFailed</Code></Error>');return;}
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
   objects.set(key,Buffer.concat(chunks));res.writeHead(200);res.end();return;
  }
  if(req.method==='GET'){
   const bytes=objects.get(key);
   if(!bytes){res.writeHead(404,{'Content-Type':'application/xml'});res.end('<Error><Code>NoSuchKey</Code></Error>');return;}
   res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);return;
  }
  if(req.method==='DELETE'){deletes++;objects.delete(key);res.writeHead(204);res.end();return;}
  res.writeHead(400);res.end();
 });
 let env:NodeJS.ProcessEnv;
 beforeAll(async()=>{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  env={UAI_BLOB_BACKEND:'s3',UAI_S3_BUCKET:'test-bucket',UAI_S3_REGION:'us-east-1',UAI_S3_PREFIX:'installation-a',UAI_S3_ENDPOINT:`http://127.0.0.1:${address.port}`,UAI_S3_FORCE_PATH_STYLE:'true',UAI_S3_ACCESS_KEY_ID:'test-only',UAI_S3_SECRET_ACCESS_KEY:'test-only'};
 });
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))});
 it('writes, reads and purges across independent clients without overwriting or crossing prefixes',async()=>{
  const api=createBlobStore(env),worker=createBlobStore(env),other=createBlobStore({...env,UAI_S3_PREFIX:'installation-b'});
  const bytes=Buffer.from([0,255,12,9,128]);
  await api.put('blob_123',bytes);
  expect(Buffer.from(await worker.get('blob_123'))).toEqual(bytes);
  await expect(worker.put('blob_123',Buffer.from('replacement'))).rejects.toMatchObject({name:'PreconditionFailed'});
  expect(Buffer.from(await api.get('blob_123'))).toEqual(bytes);
  await expect(other.get('blob_123')).rejects.toMatchObject({name:'NoSuchKey'});
  await worker.delete('blob_123');await api.delete('blob_123');
  await expect(api.get('blob_123')).rejects.toMatchObject({name:'NoSuchKey'});
  await expect(api.put('../escape',bytes)).rejects.toMatchObject({code:'invalid_blob_key'});
 });
 it('rechecks bucket policy before mutations and refuses versioning, locking and unreadable policy',async()=>{
  const store=createBlobStore(env),bytes=Buffer.from('retained');
  await store.put('policy_test',bytes);
  const before={writes,deletes};
  try{
   for(const status of ['Enabled','Suspended']){
    version=status;
    await expect(store.put('blocked',bytes)).rejects.toMatchObject({code:'unsupported_blob_versioning'});
    await expect(store.delete('policy_test')).rejects.toMatchObject({code:'unsupported_blob_versioning'});
   }
   version='';locked=true;
   await expect(store.delete('policy_test')).rejects.toMatchObject({code:'unsupported_blob_object_lock'});
   locked=false;denyPolicy=true;
   await expect(store.put('blocked',bytes)).rejects.toMatchObject({name:'AccessDenied'});
   expect({writes,deletes}).toEqual(before);
   expect(Buffer.from(await store.get('policy_test'))).toEqual(bytes);
  }finally{version='';locked=false;denyPolicy=false;await store.delete('policy_test');}
 });
 it('rejects incomplete credentials and unsafe configuration instead of falling back to disk',()=>{
  for(const change of [{UAI_BLOB_BACKEND:'unknown'},{UAI_S3_PREFIX:'../escape'},{UAI_S3_BUCKET:''},{UAI_S3_SECRET_ACCESS_KEY:''},{UAI_S3_ENDPOINT:'http://example.com'},{UAI_S3_FORCE_PATH_STYLE:'yes'}]){
   expect(()=>createBlobStore({...env,...change})).toThrow();
  }
 });
});

describe('S3 transport bounded by timeouts',()=>{
 // Each request takes the next scripted behaviour; an empty script answers normally.
 type Mode='pass'|'hang'|'stall-body'|'store-then-hang';
 const objects=new Map<string,Buffer>(),script:Mode[]=[];let requests=0;
 const server=createServer(async(req,res)=>{
  requests++;
  const url=new URL(req.url!,'http://localhost'),key=url.pathname,mode=script.shift();
  if(mode==='hang')return;
  if(url.searchParams.has('versioning')){res.setHeader('Content-Type','application/xml');res.end('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></VersioningConfiguration>');return;}
  if(url.searchParams.has('object-lock')){res.writeHead(404,{'Content-Type':'application/xml'});res.end('<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>');return;}
  if(req.method==='PUT'){
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
   if(objects.has(key)){res.writeHead(412,{'Content-Type':'application/xml'});res.end('<Error><Code>PreconditionFailed</Code></Error>');return;}
   objects.set(key,Buffer.concat(chunks));
   if(mode==='store-then-hang')return;
   res.writeHead(200);res.end();return;
  }
  const bytes=objects.get(key);
  if(!bytes){res.writeHead(404,{'Content-Type':'application/xml'});res.end('<Error><Code>NoSuchKey</Code></Error>');return;}
  if(mode==='stall-body'){res.writeHead(200,{'Content-Length':bytes.length+100});res.write(bytes);return;}
  res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);
 });
 let env:NodeJS.ProcessEnv;
 beforeAll(async()=>{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  env={UAI_BLOB_BACKEND:'s3',UAI_S3_BUCKET:'test-bucket',UAI_S3_REGION:'us-east-1',UAI_S3_PREFIX:'timeouts',UAI_S3_ENDPOINT:`http://127.0.0.1:${(server.address() as {port:number}).port}`,UAI_S3_FORCE_PATH_STYLE:'true',UAI_S3_ACCESS_KEY_ID:'test-only',UAI_S3_SECRET_ACCESS_KEY:'test-only',
   UAI_S3_CONNECT_TIMEOUT_MS:'500',UAI_S3_SOCKET_TIMEOUT_MS:'300',UAI_S3_OPERATION_TIMEOUT_MS:'5000',UAI_S3_MAX_ATTEMPTS:'3'};
 });
 beforeEach(()=>{script.length=0;requests=0;});
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))});
 const timed=async(work:Promise<unknown>)=>{const started=Date.now();const error=await work.then(()=>null,e=>e);return {error,ms:Date.now()-started};};

 it('fails a silent endpoint fast with a clear error after a bounded number of attempts',async()=>{
  const store=createBlobStore(env);
  for(const call of [()=>store.get('silent_get'),()=>store.put('silent_put',Buffer.from('x')),()=>store.delete('silent_delete')]){
   script.push('hang','hang','hang','hang');requests=0;
   const {error,ms}=await timed(call());
   expect(error).toMatchObject({code:'blob_store_timeout',status:503});
   expect(error.message).toMatch(/did not respond/);
   expect(ms).toBeLessThan(3000);
   expect(requests).toBe(3);
  }
 });
 it('retries a hung attempt and returns the object when the next attempt answers',async()=>{
  const store=createBlobStore(env),bytes=Buffer.from('recovered');
  await store.put('retry_get',bytes);
  script.push('hang');requests=0;
  expect(Buffer.from(await store.get('retry_get'))).toEqual(bytes);
  expect(requests).toBe(2);
 });
 it('rereads a body that stops arriving and gives up after the attempt limit',async()=>{
  const store=createBlobStore(env),bytes=Buffer.from('complete');await store.put('stalled_body',bytes);
  script.push('stall-body');requests=0;
  expect(Buffer.from(await store.get('stalled_body'))).toEqual(bytes);
  expect(requests).toBe(2);
  script.push('stall-body','stall-body','stall-body');requests=0;
  const {error,ms}=await timed(store.get('stalled_body'));
  expect(error).toMatchObject({code:'blob_store_unavailable',status:503});
  expect(ms).toBeLessThan(3000);
  expect(requests).toBe(3);
 });
 it('caps a whole operation, including bucket policy checks, by one deadline',async()=>{
  const store=createBlobStore({...env,UAI_S3_SOCKET_TIMEOUT_MS:'5000',UAI_S3_OPERATION_TIMEOUT_MS:'800'});
  script.push('hang');
  const {error,ms}=await timed(store.put('deadline_put',Buffer.from('x')));
  expect(error).toMatchObject({code:'blob_store_timeout'});
  expect(ms).toBeLessThan(1500);
 });
 it('treats its own stored write as success when the acknowledgement was lost, but never overwrites other content',async()=>{
  const store=createBlobStore(env),bytes=Buffer.from('written once');
  // Policy checks answer; the first PUT stores the object but its response is lost; the retry sees 412.
  script.push('pass','pass','store-then-hang');
  await store.put('lost_ack',bytes);
  expect(Buffer.from(await store.get('lost_ack'))).toEqual(bytes);
  // A retry that meets someone else's content is still a conflict.
  await store.put('lost_conflict',Buffer.from('first writer'));
  script.push('pass','pass','hang');
  await expect(createBlobStore(env).put('lost_conflict',Buffer.from('second writer'))).rejects.toMatchObject({name:'PreconditionFailed'});
  expect(Buffer.from(await store.get('lost_conflict'))).toEqual(Buffer.from('first writer'));
 });
 it('rejects unusable timeout settings',()=>{
  for(const change of [{UAI_S3_CONNECT_TIMEOUT_MS:'0'},{UAI_S3_SOCKET_TIMEOUT_MS:'soon'},{UAI_S3_OPERATION_TIMEOUT_MS:'-1'},{UAI_S3_MAX_ATTEMPTS:'0'},{UAI_S3_MAX_ATTEMPTS:'11'}]){
   expect(()=>createBlobStore({...env,...change})).toThrow(expect.objectContaining({code:'invalid_s3_configuration'}));
  }
 });
});
