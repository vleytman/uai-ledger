import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {S3Client,CreateBucketCommand,DeleteBucketCommand} from '@aws-sdk/client-s3';
import {createPool,transaction} from '../../db/src/index.js';
import {ManualClock,id} from '../../contracts/src/index.js';
import {registerAsset,contentHash} from '../../storage/src/index.js';
import {createBlobStore} from '../../storage/src/blob-store.js';
import {ExecutionTransport} from '../../queue/src/transport.js';
import {relayMaintenance,executeMaintenance} from '../../queue/src/maintenance.js';
import {schedulerTick} from '../src/runtime.js';
import {defaultRuntime} from '../src/default-runtime.js';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
const endpoint=process.env.UAI_TEST_S3_ENDPOINT;
const enabled=!!endpoint&&!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
const database=isolatedTestDatabase(process.env.DATABASE_URL);
let pool:ReturnType<typeof createPool>|null=null;
beforeAll(async()=>{if(enabled){await database.initialize();pool=database.pool}});
afterAll(async()=>{await database.close()});
if(process.env.REQUIRE_S3_TESTS==='1'&&!enabled)throw new Error('PostgreSQL, Redis and S3 are required');
describe.skipIf(!enabled)('maintenance S3 pipeline',()=>{
 it('retries a failed purge through the next durable maintenance generation',async()=>{
  const installation=id('purge'),bucket=id('uai-purge').replaceAll('_','-');
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const clock=new ManualClock(new Date()),blob=id('blob'),bytes=Buffer.from('private expiring content');
  const env={UAI_BLOB_BACKEND:'s3',UAI_S3_ENDPOINT:endpoint,UAI_S3_BUCKET:bucket,UAI_S3_REGION:'us-east-1',UAI_S3_PREFIX:installation,UAI_S3_FORCE_PATH_STYLE:'true',UAI_S3_ACCESS_KEY_ID:process.env.UAI_TEST_S3_ACCESS_KEY_ID,UAI_S3_SECRET_ACCESS_KEY:process.env.UAI_TEST_S3_SECRET_ACCESS_KEY};
  if(!env.UAI_S3_ACCESS_KEY_ID||!env.UAI_S3_SECRET_ACCESS_KEY)throw new Error('Explicit S3 test credentials required');
  const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:env.UAI_S3_ACCESS_KEY_ID,secretAccessKey:env.UAI_S3_SECRET_ACCESS_KEY}});
  const store=createBlobStore(env),denied=createBlobStore({...env,UAI_S3_SECRET_ACCESS_KEY:'deliberately-invalid-test-secret'});
  const transport=new ExecutionTransport(installation,process.env.REDIS_URL!);
  await client.send(new CreateBucketCommand({Bucket:bucket}));
  let assetId='';const failures:Error[]=[];
  try{
   await store.put(blob,bytes);
   assetId=(await transaction(pool!,tx=>registerAsset(tx,scope,clock,{kind:'input',blob_key:blob,content_hash:contentHash(bytes),media_type:'text/plain',size_bytes:bytes.length,expires_at:new Date(clock.now().getTime()+1)}))).id;
   clock.advance(2);
   const deps={...defaultRuntime(pool!,clock),blobStore:denied,limits:{scope,backend:'legacy' as const}};
   transport.consume('maintenance',2,delivery=>executeMaintenance(pool!,installation,delivery,()=>schedulerTick(pool!,deps,clock),clock),error=>failures.push(error));
   await relayMaintenance(pool!,transport,clock);
   const generation=async()=>Number((await pool!.query('SELECT generation FROM execution_maintenance_cycles WHERE installation_id=$1',[installation])).rows[0]?.generation);
   await expect.poll(generation,{timeout:10000}).toBe(1);
   const purge=async()=>(await pool!.query('SELECT status,attempts,last_error FROM storage_purge_jobs WHERE asset_id=$1',[assetId])).rows[0];
   expect(await purge()).toMatchObject({status:'pending',attempts:1,last_error:'blob_delete_failed'});
   expect(Buffer.from(await store.get(blob))).toEqual(bytes);
   deps.blobStore=store;clock.advance(1000);await relayMaintenance(pool!,transport,clock);
   await expect.poll(generation,{timeout:10000}).toBe(2);
   expect(await purge()).toMatchObject({status:'completed',attempts:2,last_error:null});
   await expect(store.get(blob)).rejects.toMatchObject({name:'NoSuchKey'});
   expect(failures).toEqual([]);
  }finally{
   await transport.close();const cleanup=new ExecutionTransport(installation,process.env.REDIS_URL!);await cleanup.queue('maintenance').obliterate({force:true});await cleanup.close();
   await store.delete(blob);await client.send(new DeleteBucketCommand({Bucket:bucket}));client.destroy();
   await pool!.query('DELETE FROM storage_purge_jobs WHERE asset_id=$1',[assetId]);await pool!.query('DELETE FROM storage_assets WHERE id=$1',[assetId]);
   await pool!.query('DELETE FROM execution_maintenance_cycles WHERE installation_id=$1',[installation]);
  }
 });
});
