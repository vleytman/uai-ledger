import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,GetBucketVersioningCommand,GetObjectLockConfigurationCommand} from '@aws-sdk/client-s3';
import {DomainError} from '../../contracts/src/index.js';
import {LocalBlobStore,type BlobStore} from './index.js';

/** Private bucket without versioning; PostgreSQL owns expiry and deletion. */
export class S3BlobStore implements BlobStore {
 constructor(private client:S3Client,private bucket:string,private prefix:string,private operationTimeoutMs=30000,private maxAttempts=3){}
 private key(key:string){
  if(!/^[a-zA-Z0-9_-]+$/.test(key))throw new DomainError('invalid_blob_key');
  return `${this.prefix}/${key}`;
 }
 // One deadline covers every call and retry of an operation, including policy checks and the body read.
 private async bounded<T>(work:(options:{abortSignal:AbortSignal})=>Promise<T>):Promise<T>{
  const abortSignal=AbortSignal.timeout(this.operationTimeoutMs);
  try{return await work({abortSignal});}
  catch(error){
   if(abortSignal.aborted||error instanceof Error&&error.name==='TimeoutError')throw new DomainError('blob_store_timeout','Blob storage did not respond in time',503,{timeout_ms:this.operationTimeoutMs});
   throw error;
  }
 }
 async assertDeletionPolicy(options={abortSignal:AbortSignal.timeout(this.operationTimeoutMs)}){
  const version=await this.client.send(new GetBucketVersioningCommand({Bucket:this.bucket}),options);
  // Suspended versioning can still retain old versions behind delete markers.
  if(version.Status)throw new DomainError('unsupported_blob_versioning');
  try{
   const lock=await this.client.send(new GetObjectLockConfigurationCommand({Bucket:this.bucket}),options);
   if(lock.ObjectLockConfiguration?.ObjectLockEnabled==='Enabled')throw new DomainError('unsupported_blob_object_lock');
  }catch(error){
   // Only the explicit absence of configuration is safe. AccessDenied and
   // unsupported endpoints must not silently bypass the deletion requirement.
   if(!(error instanceof Error)||error.name!=='ObjectLockConfigurationNotFoundError')throw error;
  }
 }
 async put(key:string,content:Uint8Array){
  this.key(key);
  await this.bounded(async options=>{
   await this.assertDeletionPolicy(options);
   try{await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:this.key(key),Body:content,IfNoneMatch:'*',ContentType:'application/octet-stream'}),options);}
   catch(error){
    // A retried PUT meets the object stored by its own lost attempt. Keys are unique, so equal bytes are ours.
    const attempts=(error as {$metadata?:{attempts?:number}}).$metadata?.attempts??1;
    if(!(error instanceof Error)||error.name!=='PreconditionFailed'||attempts<2||!Buffer.from(await this.read(key,options)).equals(Buffer.from(content)))throw error;
   }
  });
 }
 private async read(key:string,options:{abortSignal:AbortSignal}){
  // The SDK retries until headers arrive; a body cut off by the socket timeout is retried here.
  for(let attempt=1;;attempt++){
   const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:this.key(key)}),options);
   if(!response.Body)throw new DomainError('blob_unavailable');
   try{return await response.Body.transformToByteArray();}
   catch{if(attempt>=this.maxAttempts)throw new DomainError('blob_store_unavailable','Blob storage stopped sending the object',503,{attempts:attempt});}
  }
 }
 async get(key:string){return this.bounded(options=>this.read(key,options));}
 async delete(key:string){
  this.key(key);
  await this.bounded(async options=>{
   await this.assertDeletionPolicy(options);
   await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:this.key(key)}),options);
  });
 }
}

const positive=(env:NodeJS.ProcessEnv,name:string,fallback:number,max:number)=>{
 const raw=env[name];if(raw===undefined||raw==='')return fallback;
 if(!/^[1-9][0-9]*$/.test(raw)||Number(raw)>max)throw new DomainError('invalid_s3_configuration',`${name} must be an integer from 1 to ${max}`);
 return Number(raw);
};
export function createBlobStore(env:NodeJS.ProcessEnv=process.env):BlobStore {
 const backend=env.UAI_BLOB_BACKEND??'local';
 if(backend==='local')return new LocalBlobStore(env.UAI_BLOB_ROOT??'.data/blobs');
 if(backend!=='s3')throw new DomainError('invalid_blob_backend');
 const bucket=env.UAI_S3_BUCKET,region=env.UAI_S3_REGION,prefix=env.UAI_S3_PREFIX;
 if(!bucket||!region||!prefix||!/^[-a-zA-Z0-9_]+(?:\/[-a-zA-Z0-9_]+)*$/.test(prefix))throw new DomainError('invalid_s3_configuration');
 const accessKeyId=env.UAI_S3_ACCESS_KEY_ID,secretAccessKey=env.UAI_S3_SECRET_ACCESS_KEY;
 if(Boolean(accessKeyId)!==Boolean(secretAccessKey))throw new DomainError('invalid_s3_credentials');
 const pathStyle=env.UAI_S3_FORCE_PATH_STYLE??'false';
 if(!['true','false'].includes(pathStyle))throw new DomainError('invalid_s3_configuration');
 let endpoint:string|undefined;
 if(env.UAI_S3_ENDPOINT){
  const url=new URL(env.UAI_S3_ENDPOINT);
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&local)))throw new DomainError('invalid_s3_endpoint');
  endpoint=url.toString();
 }
 // A hung endpoint (accepted TCP, no answer) must fail fast instead of blocking API and worker callers.
 const connectionTimeout=positive(env,'UAI_S3_CONNECT_TIMEOUT_MS',2000,60000),socketTimeout=positive(env,'UAI_S3_SOCKET_TIMEOUT_MS',10000,600000);
 const operationTimeout=positive(env,'UAI_S3_OPERATION_TIMEOUT_MS',30000,600000),maxAttempts=positive(env,'UAI_S3_MAX_ATTEMPTS',3,10);
 return new S3BlobStore(new S3Client({region,endpoint,forcePathStyle:pathStyle==='true',maxAttempts,requestHandler:{connectionTimeout,socketTimeout},
  credentials:accessKeyId&&secretAccessKey?{accessKeyId,secretAccessKey,sessionToken:env.UAI_S3_SESSION_TOKEN}:undefined,
 }),bucket,prefix,operationTimeout,maxAttempts);
}
