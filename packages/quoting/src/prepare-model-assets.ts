import {createBlobStore} from '../../storage/src/blob-store.js';
import sharp,{type Metadata} from 'sharp';
import {DomainError,type Scope,type Clock} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';
import {getAsset,contentHash,type BlobStore} from '../../storage/src/index.js';
import type {ModelCalculation,InputAsset} from '../../model-pricing/src/index.js';
export interface PreparedAsset extends InputAsset {base64:string;content_type:string;source_hash:string}
/** Decode for validation without rewriting the original container or its metadata. */
export async function prepareImage(original:Uint8Array,mediaType:string,preparation:ModelCalculation['preparation']){
 try{
  const decoder=sharp(original,{failOn:'warning',limitInputPixels:40000000,animated:false});
  const metadata=await decoder.metadata();
  if(!metadata.width||!metadata.height||!['jpeg','png','webp'].includes(metadata.format??'')||mediaType!==`image/${metadata.format}`||(metadata.pages??1)>1)throw new Error('Unsupported image');
  await decoder.clone().raw().toBuffer();
  if(preparation.mode!=='transform'){
   if(metadata.width>preparation.max_edge||metadata.height>preparation.max_edge)throw new DomainError('unsupported_reference_size','Original exceeds the configured image bounds',422);
   return {bytes:Buffer.from(original),metadata};
  }
  let transform=decoder.clone();
  if(preparation.auto_orient)transform=transform.rotate();
  const bytes=await transform.resize({width:preparation.max_edge,height:preparation.max_edge,fit:preparation.fit??'inside',withoutEnlargement:true,background:'#ffffff'}).toFormat(preparation.format).toBuffer();
  return {bytes,metadata:await sharp(bytes).metadata()};
 }catch(error){if(error instanceof DomainError)throw error;throw new DomainError('invalid_asset','Reference cannot be decoded',422);}
}
/** Prepared bytes live only in expiring storage_inputs, never in financial quote snapshots. */
export async function prepareModelAssets(tx:Tx,scope:Scope,clock:Clock,policy:ModelCalculation,ids:unknown,blobs:BlobStore=createBlobStore()):Promise<PreparedAsset[]> {
 if(ids===undefined)return [];
 if(!Array.isArray(ids)||ids.length>policy.preparation.max_assets||ids.some(id=>typeof id!=='string'))throw new DomainError('invalid_assets','Invalid model references',422);
 const result:PreparedAsset[]=[];let total=0;
 for(const id of ids){
  const asset=await getAsset(tx,scope,clock,id,true),original=await blobs.get(asset.blob_key);
  if(contentHash(original)!==asset.content_hash)throw new DomainError('invalid_asset','Source hash differs',422);
  let bytes:Buffer,metadata:Metadata;
  ({bytes,metadata}=await prepareImage(original,asset.media_type,policy.preparation));
  total+=bytes.length;if(total>20000000)throw new DomainError('invalid_assets','Prepared references exceed storage limit',422);
  const width=metadata.width!,height=metadata.height!;
  if(policy.preparation.allowed_dimensions&&!policy.preparation.allowed_dimensions.includes(`${width}x${height}`))throw new DomainError('unsupported_reference_size','Prepared reference size has no verified pricing rule',422);
  result.push({id,source_hash:asset.content_hash,sha256:contentHash(bytes),width,height,format:metadata.format!,content_type:`image/${metadata.format}`,base64:bytes.toString('base64')});
 }
 return result;
}
