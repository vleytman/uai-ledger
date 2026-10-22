import {mkdir,writeFile} from 'node:fs/promises';
import {createPool} from '../packages/db/src/index.js';
import {systemClock} from '../packages/contracts/src/index.js';
import {ConnectionService,CredentialVault} from '../packages/reconciliation/src/connections.js';
import {loadRuntimeSecrets} from '../packages/runtime-config/src/index.js';

// Read-only credential/voice check. Never calls a generation or reporting endpoint.
if(process.env.UAI_ENV!=='test')throw new Error('UAI_ENV=test is required');
const database=new URL(process.env.DATABASE_URL??'');
if(!['localhost','127.0.0.1'].includes(database.hostname)||database.pathname!=='/uai_local')throw new Error('Only the local uai_local test database is permitted');
await loadRuntimeSecrets();
const pool=createPool();
try{
 const client=await pool.connect();
 let credential:string;
 let connectionId:string;
 let credentialRevision:number;
 try{
  await client.query('BEGIN READ ONLY');
  const connections=(await client.query("SELECT id,organization_id,application_id,credential_revision FROM provider_connections WHERE provider='cartesia' AND status='enabled' AND credential_status IN ('configured','verified')")).rows;
  if(connections.length!==1)throw new Error('Exactly one enabled Cartesia connection is required');
  const connection=connections[0];
  const service=new ConnectionService(client,systemClock,new CredentialVault(Buffer.from(process.env.UAI_VAULT_KEY??'','base64')));
  credential=await service.resolveCredential(connection,connection.id);
  connectionId=connection.id;
  credentialRevision=connection.credential_revision;
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const voiceId='db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
 const version='2026-08-14';
 const url=new URL('https://api.cartesia.ai/voices');
 url.searchParams.set('limit','1');
 url.searchParams.set('q',voiceId);
 url.searchParams.set('is_owner','false');
 let response:Response;
 try{
  response=await fetch(url,{method:'GET',headers:{Authorization:`Bearer ${credential}`,'Cartesia-Version':version},redirect:'error',signal:AbortSignal.timeout(20000)});
 }catch{throw new Error('Cartesia read-only access check failed before a response');}
 const body=response.ok?await response.json().catch(()=>null):null;
 const found=Array.isArray(body?.data)&&body.data.some((voice:{id?:unknown})=>voice.id===voiceId);
 const result={checked_at:new Date().toISOString(),connection_id:connectionId,credential_revision:credentialRevision,endpoint:'GET /voices',api_version:version,http_status:response.status,voice_id:voiceId,voice_available:found,generation_requests:0};
 await mkdir('.data',{recursive:true});
 await writeFile('.data/cartesia-access.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(result));
 if(!response.ok||!found)process.exitCode=1;
}finally{await pool.end();}
