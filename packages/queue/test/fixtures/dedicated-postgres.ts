import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer,type AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';

/** Independent server: stop/restart cannot affect a configured application database. */
export async function dedicatedPostgres(){
 const exec=promisify(execFile),container=`uai-postgres-fault-${randomUUID()}`;
 const docker=async(...args:string[])=>(await exec('docker',args,{timeout:30000})).stdout.trim();
 const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=(listener.address() as AddressInfo).port;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
 const url=`postgresql://uai_fault:uai_fault_local_only@127.0.0.1:${port}/uai_fault`;
 const ready=async()=>{await expect.poll(async()=>{try{return await docker('exec',container,'pg_isready','-h','127.0.0.1','-U','uai_fault','-d','uai_fault')}catch{return ''}},{timeout:20000}).toContain('accepting connections')};
 const close=async()=>{await docker('rm','-fv',container).catch(()=>{})};
 try{
  await docker('run','-d','--name',container,'-p',`127.0.0.1:${port}:5432`,'-e','POSTGRES_USER=uai_fault','-e','POSTGRES_PASSWORD=uai_fault_local_only','-e','POSTGRES_DB=uai_fault','postgres:17-alpine');await ready();
  await exec(process.execPath,['--import','tsx',new URL('../../../../scripts/migrate.ts',import.meta.url).pathname],{env:{...process.env,DATABASE_URL:url},timeout:30000});
  return {url,close,stop:()=>docker('stop','-t','1',container),start:async()=>{await docker('start',container);await ready()}};
 }catch(error){await close();throw error}
}
