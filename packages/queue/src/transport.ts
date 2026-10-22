import {createHash} from 'node:crypto';
import {Queue,Worker,type Job} from 'bullmq';

export const queueKinds=['text','image','audio','tools','observe','maintenance'] as const;
export type QueueKind=typeof queueKinds[number];
export const redisClientPrefix=(installation:string)=>`uai-client-${createHash('sha256').update(installation).digest('hex')}:`;
export interface Delivery {request_id:string;generation:number;purpose:'execute'|'observe'|'maintenance';poll_count?:number}
export function deliveryId(installation:string,delivery:Delivery){
 const identity:unknown[]=[installation,delivery.request_id,delivery.generation,delivery.purpose];
 if(delivery.purpose==='observe')identity.push(delivery.poll_count);
 return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export function redisConnection(url:string){
 const parsed=new URL(url);
 if(!['redis:','rediss:'].includes(parsed.protocol))throw new Error('invalid_redis_url');
 const database=parsed.pathname.slice(1)||'0';
 if(!/^\d+$/.test(database))throw new Error('invalid_redis_database');
 return {host:parsed.hostname,port:Number(parsed.port||6379),username:parsed.username?decodeURIComponent(parsed.username):undefined,password:parsed.password?decodeURIComponent(parsed.password):undefined,db:Number(database),...(parsed.protocol==='rediss:'?{tls:{}}:{}),maxRetriesPerRequest:null};
}
/** Transport only. The handler must acquire durable domain permission before any external call. */
export class ExecutionTransport {
 private readonly queues=new Map<QueueKind,Queue<Delivery>>();
 private readonly workers:Worker[]=[];
 private stopping=false;
 private readonly connection:ReturnType<typeof redisConnection>&{connectionName:string};
 private readonly prefix:string;
 constructor(readonly installation:string,url:string){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(installation))throw new Error('invalid_installation');
  this.connection={...redisConnection(url),connectionName:`${redisClientPrefix(installation)}transport:${process.pid}`};this.prefix=`uai-${installation}`;
 }
 queue(kind:QueueKind){
  let queue=this.queues.get(kind);
  if(!queue){queue=new Queue<Delivery>(kind,{connection:{...this.connection,maxRetriesPerRequest:1,enableOfflineQueue:false},prefix:this.prefix});this.queues.set(kind,queue)}
  return queue;
 }
 async publish(kind:QueueKind,delivery:Delivery,dueAt=new Date()){
  if(!delivery.request_id||!Number.isSafeInteger(delivery.generation)||delivery.generation<0||!Number.isFinite(dueAt.getTime()))throw new Error('invalid_delivery');
  if(delivery.purpose==='observe'&&(kind!=='observe'||!Number.isSafeInteger(delivery.poll_count)||(delivery.poll_count??-1)<0))throw new Error('invalid_observation_delivery');
  return this.queue(kind).add(delivery.purpose,delivery,{jobId:deliveryId(this.installation,delivery),delay:Math.max(0,dueAt.getTime()-Date.now()),attempts:1,removeOnComplete:{age:86400,count:10000},removeOnFail:{age:604800,count:10000}});
 }
 consume(kind:QueueKind,concurrency:number,handler:(delivery:Delivery,job:Job<Delivery>)=>Promise<unknown>,onError:(error:Error)=>void){
  if(this.stopping)throw new Error('transport_stopping');
  if(!Number.isSafeInteger(concurrency)||concurrency<1)throw new Error('invalid_concurrency');
  const worker=new Worker<Delivery>(kind,job=>{if(this.stopping)throw new Error('transport_stopping');return handler(job.data,job)},{connection:this.connection,prefix:this.prefix,concurrency});
  worker.on('error',onError);this.workers.push(worker);return worker;
 }
 async pause(){this.stopping=true;await Promise.all(this.workers.map(worker=>worker.pause(true)))}
 async close(){await this.pause();await Promise.all(this.workers.map(worker=>worker.close()));await Promise.all([...this.queues.values()].map(queue=>queue.close()));}
}
