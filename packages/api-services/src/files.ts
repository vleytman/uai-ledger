import {DomainError,type Scope,type Clock} from '../../contracts/src/index.js';
import {getAsset,contentHash,type BlobStore} from '../../storage/src/index.js';
import {createBlobStore} from '../../storage/src/blob-store.js';
import type {Tx} from '../../db/src/index.js';
import type {ServiceOperation,VerifiedFiles} from './index.js';
export interface PreparedApiFile {id:string;source_hash:string;content_type:string;base64:string;size_bytes:number}
export async function prepareApiFiles(tx:Tx,scope:Scope,clock:Clock,operation:ServiceOperation,ids:unknown,blobs:BlobStore=createBlobStore()):Promise<PreparedApiFile[]>{
 if(ids===undefined)return [];
 if(!Array.isArray(ids)||ids.length>operation.files.max_count||ids.some(v=>typeof v!=='string')||new Set(ids).size!==ids.length)throw new DomainError('invalid_assets','Invalid API attachments',422);
 const result:PreparedApiFile[]=[];let total=0;
 for(const id of ids){
  const asset=await getAsset(tx,scope,clock,id,true);if(asset.kind!=='input'||!operation.files.media_types.includes(asset.media_type)||BigInt(asset.size_bytes)>BigInt(operation.files.max_file_bytes))throw new DomainError('invalid_asset','File type or size is not permitted',422);
  const bytes=await blobs.get(asset.blob_key);total+=bytes.length;
  if(contentHash(bytes)!==asset.content_hash||BigInt(bytes.length)!==BigInt(asset.size_bytes)||BigInt(total)>BigInt(operation.files.max_total_bytes))throw new DomainError('invalid_asset','File bytes differ or exceed the allowed size',422);
  result.push({id:asset.id,source_hash:asset.content_hash,content_type:asset.media_type,base64:Buffer.from(bytes).toString('base64'),size_bytes:bytes.length});
 }
 return result;
}
export const fileMetrics=(files:PreparedApiFile[]):VerifiedFiles=>({count:files.length,bytes:files.reduce((sum,file)=>sum+BigInt(file.size_bytes),0n).toString()});
