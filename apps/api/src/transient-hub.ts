import type pg from 'pg';
export interface TransientSubscription {resume():void;close():void}
interface Subscriber {queue:unknown[];bytes:number;running:boolean;paused:boolean;closed:boolean;accept:(event:any)=>boolean;consume:(event:any)=>Promise<void>;gap:()=>void}
/** One LISTEN per API process; slow consumers have independent bounded queues. */
export class TransientHub {
 private client?:pg.PoolClient;
 private ready?:Promise<void>;
 private stopped=false;
 private subscribers=new Set<Subscriber>();
 constructor(private pool:pg.Pool,private maxBytes=262144,private maxEvents=256){}
 async start(){
  if(this.stopped)throw new Error('hub_closed');
  if(!this.ready)this.ready=this.connect().catch(error=>{this.ready=undefined;throw error});
  await this.ready;
 }
 private async connect(){
  const client=await this.pool.connect();this.client=client;
  client.on('notification',message=>{if(message.channel!=='uai_transient'||!message.payload)return;try{this.publish(JSON.parse(message.payload))}catch{}});
  client.on('error',()=>{if(this.client!==client)return;this.client=undefined;this.ready=undefined;client.release(true);for(const sub of [...this.subscribers])this.drop(sub);});
  try{await client.query('LISTEN uai_transient')}catch(error){this.client=undefined;client.release(true);throw error;}
 }
 subscribe(accept:Subscriber['accept'],consume:Subscriber['consume'],gap:()=>void,paused=false):TransientSubscription{
  if(!this.client||this.stopped)throw new Error('hub_not_ready');
  const sub:Subscriber={accept,consume,gap,queue:[],bytes:0,running:false,paused,closed:false};this.subscribers.add(sub);
  return {resume:()=>{sub.paused=false;void this.drain(sub)},close:()=>{sub.closed=true;sub.queue=[];sub.bytes=0;this.subscribers.delete(sub)}};
 }
 /** Also used by deterministic transports in tests. */
 publish(event:unknown){
  const bytes=Buffer.byteLength(JSON.stringify(event));
  for(const sub of this.subscribers){
   if(sub.closed||!sub.accept(event))continue;
   if(sub.bytes+bytes>this.maxBytes||sub.queue.length>=this.maxEvents){this.drop(sub);continue;}
   sub.queue.push(event);sub.bytes+=bytes;void this.drain(sub);
  }
 }
 private drop(sub:Subscriber){sub.closed=true;sub.queue=[];sub.bytes=0;this.subscribers.delete(sub);sub.gap();}
 private async drain(sub:Subscriber){
  if(sub.running||sub.paused||sub.closed)return;sub.running=true;
  try{while(sub.queue.length&&!sub.closed&&!sub.paused){const event=sub.queue.shift();sub.bytes-=Buffer.byteLength(JSON.stringify(event));await sub.consume(event);}}
  catch{this.drop(sub)}finally{sub.running=false;}
 }
 async close(){this.stopped=true;for(const sub of [...this.subscribers])this.drop(sub);const client=this.client;this.client=undefined;if(client){try{await client.query('UNLISTEN uai_transient')}finally{client.release()}}}
}
