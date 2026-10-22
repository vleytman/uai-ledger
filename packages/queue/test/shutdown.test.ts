import {spawn} from 'node:child_process';
import {expect,it} from 'vitest';
import {installWorkerShutdown} from '../src/shutdown.js';

it('rejects invalid shutdown bounds without installing handlers',()=>{
 const before=process.listenerCount('SIGTERM');
 for(const value of [0,-1,NaN,1.5,300001])expect(()=>installWorkerShutdown(value,async()=>{})).toThrow('invalid_shutdown_grace');
 expect(process.listenerCount('SIGTERM')).toBe(before);
});
it('terminates a separate process even when its stop callback never resolves',async()=>{
 const moduleUrl=new URL('../src/shutdown.ts',import.meta.url).href;
 const source=`import {installWorkerShutdown} from ${JSON.stringify(moduleUrl)};
 installWorkerShutdown(75,async()=>{console.log('stopping');await new Promise(()=>{})});
 setInterval(()=>{},1000);
 process.kill(process.pid,'SIGTERM');`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{errors+=chunk});
 const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);
 try{
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))});
  expect(result).toEqual({code:1,signal:null});expect(output).toContain('stopping');expect(errors).toContain('worker_shutdown_grace_exceeded');
 }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
});
