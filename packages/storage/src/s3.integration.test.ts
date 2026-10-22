import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {S3Client,CreateBucketCommand,DeleteBucketCommand,PutBucketVersioningCommand,GetObjectLockConfigurationCommand} from '@aws-sdk/client-s3';
import {afterAll,describe,it,expect} from 'vitest';
import {createBlobStore} from './blob-store.js';

const endpoint=process.env.UAI_TEST_S3_ENDPOINT,container=process.env.UAI_TEST_S3_CONTAINER;
let paused=false;
// A timed-out test does not reach its finally block; never leave the shared container frozen.
afterAll(()=>{if(paused)execFileSync('docker',['unpause',container!]);});
if(process.env.REQUIRE_S3_TESTS==='1'&&!endpoint)throw new Error('UAI_TEST_S3_ENDPOINT is required');
describe.skipIf(!endpoint)('S3 server integration',()=>{
 it('shares immutable bytes, purges objects and rejects versioned buckets on a real S3 server',async()=>{
  const bucket=`uai-test-${randomUUID()}`;
  const env={UAI_BLOB_BACKEND:'s3',UAI_S3_ENDPOINT:endpoint,UAI_S3_BUCKET:bucket,UAI_S3_REGION:'us-east-1',UAI_S3_PREFIX:'installation-a',UAI_S3_FORCE_PATH_STYLE:'true',UAI_S3_ACCESS_KEY_ID:process.env.UAI_TEST_S3_ACCESS_KEY_ID,UAI_S3_SECRET_ACCESS_KEY:process.env.UAI_TEST_S3_SECRET_ACCESS_KEY};
  if(!env.UAI_S3_ACCESS_KEY_ID||!env.UAI_S3_SECRET_ACCESS_KEY)throw new Error('Explicit test S3 credentials required');
  const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:env.UAI_S3_ACCESS_KEY_ID,secretAccessKey:env.UAI_S3_SECRET_ACCESS_KEY}});
  await client.send(new CreateBucketCommand({Bucket:bucket}));
  try{
   const first=createBlobStore(env),second=createBlobStore(env);
   const contenders=[Buffer.from('first contender'),Buffer.from('second contender')];
   const outcomes=await Promise.allSettled(contenders.map((bytes,index)=>(index?second:first).put('blob_race',bytes)));
   expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
   const winner=outcomes.findIndex(result=>result.status==='fulfilled');
   expect(Buffer.from(await second.get('blob_race'))).toEqual(contenders[winner]);
   await first.delete('blob_race');await second.delete('blob_race');
   await expect(second.get('blob_race')).rejects.toMatchObject({name:'NoSuchKey'});
   await client.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Enabled'}}));
   await expect(first.put('blocked',Buffer.from('no write'))).rejects.toMatchObject({code:'unsupported_blob_versioning'});
   await client.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Suspended'}}));
   await expect(first.delete('blocked')).rejects.toMatchObject({code:'unsupported_blob_versioning'});
   const lockedBucket=`uai-lock-${randomUUID()}`;
   await client.send(new CreateBucketCommand({Bucket:lockedBucket,ObjectLockEnabledForBucket:true}));
   try{
    expect((await client.send(new GetObjectLockConfigurationCommand({Bucket:lockedBucket}))).ObjectLockConfiguration?.ObjectLockEnabled).toBe('Enabled');
    // Object Lock also enables versioning, so the earlier policy gate rejects it.
    await expect(createBlobStore({...env,UAI_S3_BUCKET:lockedBucket}).put('blocked',Buffer.from('no write'))).rejects.toMatchObject({code:'unsupported_blob_versioning'});
   }finally{await client.send(new DeleteBucketCommand({Bucket:lockedBucket}));}
  }finally{await client.send(new DeleteBucketCommand({Bucket:bucket}));client.destroy();}
 });
 // Opt-in: freezes the local S3 container. Its published port still accepts TCP but never answers,
 // the failure seen with the OrbStack port forward on 2026-10-20.
 it.skipIf(!container)('fails fast while the S3 server is frozen and works again once it resumes',async()=>{
  const bucket=`uai-test-${randomUUID()}`,credentials={accessKeyId:process.env.UAI_TEST_S3_ACCESS_KEY_ID!,secretAccessKey:process.env.UAI_TEST_S3_SECRET_ACCESS_KEY!};
  const env={UAI_BLOB_BACKEND:'s3',UAI_S3_ENDPOINT:endpoint,UAI_S3_BUCKET:bucket,UAI_S3_REGION:'us-east-1',UAI_S3_PREFIX:'frozen',UAI_S3_FORCE_PATH_STYLE:'true',UAI_S3_ACCESS_KEY_ID:credentials.accessKeyId,UAI_S3_SECRET_ACCESS_KEY:credentials.secretAccessKey,UAI_S3_SOCKET_TIMEOUT_MS:'1000',UAI_S3_OPERATION_TIMEOUT_MS:'10000'};
  const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials});
  await client.send(new CreateBucketCommand({Bucket:bucket}));
  const store=createBlobStore(env),bytes=Buffer.from('survives a frozen server');
  try{
   await store.put('blob_frozen',bytes);
   execFileSync('docker',['pause',container!]);paused=true;
   try{
    for(const call of [()=>store.get('blob_frozen'),()=>store.put('blob_other',bytes)]){
     const started=Date.now();
     await expect(call()).rejects.toMatchObject({code:'blob_store_timeout'});
     expect(Date.now()-started).toBeLessThan(6000);
    }
   }finally{execFileSync('docker',['unpause',container!]);paused=false;}
   expect(Buffer.from(await store.get('blob_frozen'))).toEqual(bytes);
   await store.delete('blob_frozen');await store.delete('blob_other');
  }finally{await client.send(new DeleteBucketCommand({Bucket:bucket}));client.destroy();}
 },30000);
});
