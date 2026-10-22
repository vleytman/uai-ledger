import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';

/** Owns every file/container it removes. Never accepts a shared Redis URL. */
export async function dedicatedRedis(){
 const exec=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'uai-queue-fault-'));
 const data=join(directory,'data'),backup=join(directory,'backup'),container=`uai-queue-fault-${randomUUID()}`;
 const docker=async(...args:string[])=>(await exec('docker',args,{timeout:30000})).stdout.trim();
 const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=(listener.address() as AddressInfo).port;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
 const ready=async()=>{await expect.poll(async()=>{try{return await docker('exec',container,'redis-cli','ping')}catch{return ''}},{timeout:10000}).toBe('PONG')};
 const close=async()=>{await docker('rm','-f',container).catch(()=>{});await rm(directory,{recursive:true,force:true})};
 try{
  await mkdir(data);await docker('run','-d','--name',container,'-p',`127.0.0.1:${port}:6379`,'-v',`${data}:/data`,'redis:7.4-alpine','redis-server','--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction');await ready();
  return {url:`redis://127.0.0.1:${port}`,close,
   checkpoint:async()=>{await docker('stop',container);await cp(data,backup,{recursive:true});await docker('start',container);await ready()},
   lose:async(mode:'rollback'|'empty')=>{await docker('stop',container);await rm(data,{recursive:true,force:true});if(mode==='rollback')await cp(backup,data,{recursive:true});else await mkdir(data);await docker('start',container);await ready()},
  };
 }catch(error){await close();throw error}
}
