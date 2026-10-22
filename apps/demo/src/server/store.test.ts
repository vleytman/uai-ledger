import { describe,it,expect } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DemoStore } from './store';
describe('durable independent demo history',()=>{
 it('serializes updates from separate HTTP handler instances without losing accepted operations',async()=>{
  const root=await mkdtemp(join(tmpdir(),'uai-demo-'));
  try{await Promise.all(Array.from({length:25},(_,i)=>new DemoStore(root).update(rows=>{rows.push({id:String(i),title:'accepted',created_at:new Date().toISOString(),messages:[],status:'queued',profile:'text',operation_id:`operation-${i}`})})));expect(await new DemoStore(root).read()).toHaveLength(25)}finally{await rm(root,{recursive:true,force:true})}
 });
 it('rejects mismatched downloads and retains a verified file across store restart until explicit deletion',async()=>{
  const root=await mkdtemp(join(tmpdir(),'uai-demo-')),bytes=Buffer.from('durable image'),asset={id:'asset_test',media_type:'image/png',size_bytes:bytes.length,content_hash:`sha256:${createHash('sha256').update(bytes).digest('hex')}`};
  try{const store=new DemoStore(root);await expect(store.saveAsset(asset,Buffer.from('corrupt'))).rejects.toThrow('integrity');const file=await store.saveAsset(asset,bytes);await store.update(rows=>rows.push({id:'row',title:'saved',created_at:new Date().toISOString(),messages:[],status:'succeeded',profile:'image',result:{assets:[asset]},files:[file]}));expect((await new DemoStore(root).readAsset(asset.id))?.bytes.equals(bytes)).toBe(true);await store.remove('row');expect(await new DemoStore(root).readAsset(asset.id)).toBeNull()}finally{await rm(root,{recursive:true,force:true})}
 });
});
