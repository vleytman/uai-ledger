import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent} from 'node:https';
import {S3Client,CreateBucketCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {issueToken} from '../../auth/src/index.js';
import {contentHash} from '../../storage/src/index.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';

// Deliberately owns every container/network. Never takes DATABASE_URL or REDIS_URL.
describe.skipIf(process.env.UAI_TEST_CONTAINERS!=='1')('Independent runtime containers',()=>{
 it('shares TLS S3 across replicas and independently purges acknowledged, expired and deleted content',async()=>{
  const exec=promisify(execFile),tag=`uai-containers-${randomUUID()}`;
  const directory=await mkdtemp(join(tmpdir(),'uai-container-cert-')),containers:string[]=[];
  const docker=async(...args:string[])=>(await exec('docker',args,{timeout:60000,maxBuffer:1024*1024})).stdout.trim();
  const run=async(name:string,args:string[])=>{const full=`${tag}-${name}`;containers.push(full);await docker('run','-d','--name',full,'--network',tag,'--network-alias',name,...args);return full};
  const port=async(name:string,internal:number)=>Number((await docker('port',name,String(internal))).split(':').at(-1));
  let pool:ReturnType<typeof createPool>|undefined,s3:S3Client|undefined;
  try{
   await docker('network','create',tag);
   await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'private.key'),'-out',join(directory,'public.crt'),'-days','1','-subj','/CN=minio','-addext','subjectAltName=DNS:minio,DNS:localhost,IP:127.0.0.1'],{timeout:10000});
   const postgres=await run('postgres',['-p','127.0.0.1::5432','-e','POSTGRES_USER=uai','-e','POSTGRES_PASSWORD=container-test-only','-e','POSTGRES_DB=uai','postgres:17-alpine']);
   await expect.poll(async()=>{try{return await docker('exec',postgres,'pg_isready','-h','127.0.0.1','-U','uai')}catch{return ''}},{timeout:20000}).toContain('accepting connections');
   await run('redis',['redis:7.4-alpine','redis-server','--appendonly','yes','--maxmemory-policy','noeviction']);
   const minio=await run('minio',['-p','127.0.0.1::9000','-v',`${directory}:/certs:ro`,'-e','MINIO_ROOT_USER=container-test','-e','MINIO_ROOT_PASSWORD=container-test-only','quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z','server','/data','--certs-dir','/certs']);
   s3=new S3Client({endpoint:`https://127.0.0.1:${await port(minio,9000)}`,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'container-test',secretAccessKey:'container-test-only'},requestHandler:{httpsAgent:new Agent({ca:await readFile(join(directory,'public.crt'))})}});
   await expect.poll(async()=>{try{await s3!.send(new CreateBucketCommand({Bucket:'runtime-test'}));return true}catch{return false}},{timeout:15000}).toBe(true);
   const image=process.env.UAI_TEST_RUNTIME_IMAGE??'uai-runtime:distributed-test';
   const env={DATABASE_URL:'postgresql://uai:container-test-only@postgres:5432/uai',REDIS_URL:'redis://redis:6379',UAI_INSTALLATION_ID:tag,UAI_ALLOW_REAL_PROVIDERS:'false',UAI_EXECUTION_BACKEND:'bullmq',UAI_WORKER_BACKEND:'bullmq',UAI_BLOB_BACKEND:'s3',UAI_S3_ENDPOINT:'https://minio:9000',UAI_S3_BUCKET:'runtime-test',UAI_S3_REGION:'us-east-1',UAI_S3_PREFIX:tag,UAI_S3_FORCE_PATH_STYLE:'true',UAI_S3_ACCESS_KEY_ID:'container-test',UAI_S3_SECRET_ACCESS_KEY:'container-test-only',NODE_EXTRA_CA_CERTS:'/run/secrets/test-ca.crt',UAI_VAULT_KEY_FILE:'/tmp/nonexistent-vault-key'};
   const common=['--init','--read-only','--tmpfs','/tmp:rw,nosuid,size=128m','--cap-drop','ALL','--security-opt','no-new-privileges','-v',`${directory}/public.crt:/run/secrets/test-ca.crt:ro`,...Object.entries(env).flatMap(([key,value])=>['-e',`${key}=${value}`])];
   const migration=await run('migration',[...common,image,'node','--import','tsx','scripts/migrate.ts']);
   expect(await docker('wait',migration)).toBe('0');
   pool=createPool(`postgresql://uai:container-test-only@127.0.0.1:${await port(postgres,5432)}/uai`);
   const fixture=await seedLoadFixture(pool,1);
   const token=await transaction(pool,tx=>issueToken(tx,{...fixture.scope,account_ids:null,scopes:['ai:quote','ai:execute','ai:read','content:write'],max_grant_units:null,expires_at:null}));
   const apiA=await run('api-a',[...common,'-p','127.0.0.1::4310',image]);
   const apiB=await run('api-b',[...common,'-p','127.0.0.1::4310',image]);
   const urls=await Promise.all([apiA,apiB].map(async name=>`http://127.0.0.1:${await port(name,4310)}`));
   for(const url of urls)await expect.poll(async()=>{try{return (await fetch(`${url}/health`)).status}catch{return 0}},{timeout:15000}).toBe(200);
   expect((await fetch(`${urls[0]}/openapi.json`)).status).toBe(200);
   const request=async(replica:number,path:string,body?:unknown)=>{
    const response=await fetch(`${urls[replica]}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token.token}`,'idempotency-key':randomUUID(),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json();expect(response.ok,JSON.stringify(value)).toBe(true);return value;
   };
   const input=Buffer.from('Cross-replica input');
   const upload=await request(0,'/v1/assets/uploads',{account_id:fixture.scope.account_id,media_type:'text/plain',size_bytes:input.length,content_hash:contentHash(input)});
   const put=await fetch(`${urls[0]}${upload.upload_url}`,{method:'PUT',headers:{authorization:`Bearer ${token.token}`,'content-type':'application/octet-stream'},body:input});expect(put.ok,await put.text()).toBe(true);
   await request(1,`/v1/assets/${upload.asset_id}/complete`,{});
   const content=async(replica:number,asset:string)=>fetch(`${urls[replica]}/v1/assets/${asset}/content`,{headers:{authorization:`Bearer ${token.token}`}});
   expect(Buffer.from(await (await content(1,upload.asset_id)).arrayBuffer())).toEqual(input);
   await run('scheduler',[...common,image,'node','--import','tsx','apps/scheduler/src/index.ts']);
   await run('generation',[...common,'-e','UAI_WORKER_QUEUES=image','-e','UAI_QUOTA_SHADOW=true',image,'node','--import','tsx','apps/worker/src/index.ts']);
   await run('maintenance',[...common,'-e','UAI_WORKER_QUEUES=maintenance',image,'node','--import','tsx','apps/worker/src/index.ts']);
   const invocation=await request(0,'/v1/invocations',{account_id:fixture.scope.account_id,budget:{max_units:'10000000'},profile:'image.standard',input:{prompt:'Container fixture'},parameters:{count:1,size:'1024x1024',quality:'standard'}});
   await expect.poll(async()=>(await request(1,`/v1/requests/${invocation.request_id}`)).execution_status,{timeout:30000}).toBe('succeeded');
   const ready=await request(1,`/v1/requests/${invocation.request_id}`),asset=ready.result.assets[0].id;
   const left=await content(0,asset),right=await content(1,asset);expect(left.status).toBe(200);expect(right.status).toBe(200);
   expect(Buffer.from(await left.arrayBuffer())).toEqual(Buffer.from(await right.arrayBuffer()));
   const row=(await pool.query('SELECT blob_key FROM storage_assets WHERE id=$1',[asset])).rows[0];
   const object={Bucket:'runtime-test',Key:`${tag}/${row.blob_key}`};
   await s3.send(new HeadObjectCommand(object));
   await request(0,`/v1/requests/${invocation.request_id}/acknowledge`,{result_version:ready.delivery.result_version,manifest_hash:ready.delivery.manifest_hash});
   expect((await content(1,asset)).status).toBe(410);
   await expect.poll(async()=>{try{await s3!.send(new HeadObjectCommand(object));return false}catch(error){return (error as any).$metadata?.httpStatusCode===404}},{timeout:20000}).toBe(true);
   expect((await content(0,upload.asset_id)).status).toBe(200);
   const settled=(await pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=$1',[invocation.request_id])).rows[0];
   expect(settled).toEqual({execution_status:'succeeded',settlement_status:'settled',attempt_count:1});
   // Expiry is advanced only in this test database, without waiting an hour.
   const inputObject={Bucket:'runtime-test',Key:`${tag}/${upload.asset_id}`};
   await s3.send(new HeadObjectCommand(inputObject));
   await pool.query("UPDATE storage_assets SET expires_at=now()-interval '1 second' WHERE id=$1",[upload.asset_id]);
   expect((await content(1,upload.asset_id)).status).toBe(410);
   await expect.poll(async()=>{try{await s3!.send(new HeadObjectCommand(inputObject));return false}catch(error){return (error as any).$metadata?.httpStatusCode===404}},{timeout:20000}).toBe(true);
   const deleted=await request(1,'/v1/invocations',{account_id:fixture.scope.account_id,budget:{max_units:'10000000'},profile:'image.standard',input:{prompt:'Deletion fixture'},parameters:{count:1,size:'1024x1024',quality:'standard'}});
   await expect.poll(async()=>(await request(0,`/v1/requests/${deleted.request_id}`)).execution_status,{timeout:30000}).toBe('succeeded');
   const toDelete=await request(0,`/v1/requests/${deleted.request_id}`),deletedAsset=toDelete.result.assets[0].id;
   const deletedKey=(await pool.query('SELECT blob_key FROM storage_assets WHERE id=$1',[deletedAsset])).rows[0].blob_key;
   await s3.send(new HeadObjectCommand({Bucket:'runtime-test',Key:`${tag}/${deletedKey}`}));
   const deletion=await request(1,'/v1/content-deletions',{scope:{operation_id:deleted.operation_id},reason:'Container acceptance'});
   const hidden=await content(0,deletedAsset);expect(hidden.ok).toBe(false);expect((await hidden.json()).error.code).toBe('content_deleted');
   await expect.poll(async()=>{try{await s3!.send(new HeadObjectCommand({Bucket:'runtime-test',Key:`${tag}/${deletedKey}`}));return false}catch(error){return (error as any).$metadata?.httpStatusCode===404}},{timeout:20000}).toBe(true);
   await expect.poll(async()=>(await request(0,`/v1/content-deletions/${deletion.deletion_id}`)).status,{timeout:10000}).toBe('completed');
   expect((await pool.query('SELECT count(*)::int n FROM execution_attempts')).rows[0].n).toBe(2);
   const observations=(await docker('logs',`${tag}-generation`)).split('\n').filter(line=>line.includes('"event":"quota.shadow"')).map(line=>JSON.parse(line));
   expect(observations).toHaveLength(2);
   expect(observations[0]).toMatchObject({request_id:invocation.request_id,queue_kind:'image',shadow:{decision:'unknown',reason:'not_ready'},actual:{decision:'allow'},matches:null});
   expect(observations[1]).toMatchObject({request_id:deleted.request_id,queue_kind:'image',shadow:{decision:'allow'},actual:{decision:'allow'},matches:true});
   expect(JSON.stringify(observations)).not.toContain('Container fixture');
   const mounts=JSON.parse(await docker('inspect',apiA,apiB));
   for(const container of mounts){expect(container.HostConfig.ReadonlyRootfs).toBe(true);expect(container.Config.User).toBe('node');expect(container.Mounts.map((m:any)=>m.Destination)).toEqual(['/run/secrets/test-ca.crt']);}
  }catch(error){
   // Container logs contain no real provider data: this installation uses only fixtures.
   for(const name of containers)console.error(name,await docker('logs','--tail','15',name).catch(()=>''));
   throw error;
  }finally{
   await pool?.end();s3?.destroy();
   for(const name of containers.reverse())await docker('rm','-fv',name).catch(()=>{});
   await docker('network','rm',tag).catch(()=>{});await rm(directory,{recursive:true,force:true});
  }
 },180000);
});
