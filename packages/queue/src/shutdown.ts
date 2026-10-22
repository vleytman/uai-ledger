/** Process watchdog. It never claims that terminating a worker cancels remote work. */
export function installWorkerShutdown(graceMs:number,onStop:()=>Promise<void>){
 if(!Number.isSafeInteger(graceMs)||graceMs<1||graceMs>300000)throw new Error('invalid_shutdown_grace');
 let stopping=false,timer:ReturnType<typeof setTimeout>|undefined;
 const stop=()=>{
  if(stopping)return;stopping=true;
  timer=setTimeout(()=>{console.error('worker_shutdown_grace_exceeded');process.exit(1)},graceMs);
  timer.unref();
  void Promise.resolve().then(onStop).catch(()=>console.error('worker_pause_failed'));
 };
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 return {dispose(){if(timer)clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)}};
}
