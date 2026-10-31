import type pg from 'pg';
import {listenerSource,type ListenerClient,type ListenerSource} from './listener.js';
/** A notification is only a hint; timeout always resumes durable reconciliation. */
export class SchedulerWakeup {
 private client?:ListenerClient;private pending=false;private resume?:()=>void;private source:ListenerSource;
 constructor(pool:pg.Pool|ListenerSource){this.source=listenerSource(pool,'uai-scheduler-wakeup')}
 async connect(){
  if(this.client)return;
  const client=await this.source.connect();this.client=client;
  client.on('notification',event=>{if(event.channel==='uai_scheduler'){this.pending=true;this.resume?.()}});
  client.on('error',()=>{if(this.client!==client)return;this.client=undefined;client.release(true);this.pending=true;this.resume?.()});
  try{await client.query('LISTEN uai_scheduler')}catch(error){this.client=undefined;client.release(true);throw error;}
 }
 async wait(timeout=1000){
  if(this.pending){this.pending=false;return;}
  await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);this.resume=undefined;resolve();};const timer=setTimeout(done,timeout);this.resume=done;});this.pending=false;
 }
 async close(){this.resume?.();const client=this.client;this.client=undefined;if(client){try{await client.query('UNLISTEN uai_scheduler')}finally{client.release()}}}
}
