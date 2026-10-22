import type {DemoComponent} from '../profile-settings';
import { mkdir,readFile,open,rename,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
export interface Conversation {id:string;title:string;created_at:string;messages:Array<{role:string;text:string}>;operation_id?:string;components?:DemoComponent[];request_id?:string;request_ids?:Record<string,string>;results?:Record<string,unknown>;result?:unknown;status:string;profile:string;quote_id?:string;diagnostics?:unknown;steps?:Record<string,unknown>;operation?:unknown;max_units?:string;estimated_units?:string;settlement?:string;estimate_only?:boolean;wallet?:unknown;files?:string[]}
const chains=new Map<string,Promise<unknown>>();
export class DemoStore {
 constructor(readonly root:string){}
 async withConversation<T>(id:string,fn:()=>Promise<T>):Promise<T>{const key=`${this.root}:conversation:${id}`,job=(chains.get(key)??Promise.resolve()).then(fn);const tail=job.catch(()=>{});chains.set(key,tail);try{return await job}finally{if(chains.get(key)===tail)chains.delete(key)}}
 private file(){return resolve(this.root,'history.json')}
 async read():Promise<Conversation[]>{try{return JSON.parse(await readFile(this.file(),'utf8'))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e}}
 async update(fn:(rows:Conversation[])=>void){const job=(chains.get(this.root)??Promise.resolve()).then(async()=>{const rows=await this.read();fn(rows);await mkdir(this.root,{recursive:true});const temp=resolve(this.root,`history-${randomUUID()}.tmp`),f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(rows));await f.sync()}finally{await f.close()}await rename(temp,this.file());const dir=await open(this.root,'r');try{await dir.sync()}finally{await dir.close()}return rows});chains.set(this.root,job.catch(()=>{}));return job}
 async saveAsset(asset:{id:string;content_hash:string;size_bytes:string|number},bytes:Uint8Array){
  if(BigInt(bytes.byteLength)!==BigInt(asset.size_bytes)||`sha256:${createHash('sha256').update(bytes).digest('hex')}`!==asset.content_hash)throw new Error('Asset integrity mismatch');
  if(!/^[a-zA-Z0-9_-]+$/.test(asset.id))throw new Error('Invalid asset identifier');
  await mkdir(this.root,{recursive:true});const name=`${asset.id}.blob`,temp=resolve(this.root,`${randomUUID()}.tmp`),file=await open(temp,'wx',0o600);
  try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}await rename(temp,resolve(this.root,name));const dir=await open(this.root,'r');try{await dir.sync()}finally{await dir.close()}return name;
 }
 async readAsset(id:string){const rows=await this.read();for(const row of rows){const result=row.result as {assets?:Array<{id:string;media_type:string}>}|undefined;const asset=result?.assets?.find(a=>a.id===id);if(asset&&row.files?.includes(`${id}.blob`))return {bytes:await readFile(resolve(this.root,`${id}.blob`)),media_type:asset.media_type};}return null;}
 async remove(id:string){const row=(await this.read()).find(r=>r.id===id);await this.update(rows=>{const i=rows.findIndex(r=>r.id===id);if(i>=0)rows.splice(i,1)});for(const file of row?.files??[])if(/^[a-zA-Z0-9_.-]+$/.test(file))await rm(resolve(this.root,file),{force:true});}
}
