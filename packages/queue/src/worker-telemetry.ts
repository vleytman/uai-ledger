import {Redis} from 'ioredis';
import type pg from 'pg';
import {redisConnection,redisClientPrefix,type QueueKind} from './transport.js';
export interface ProbeSample {state:'pending'|'ok'|'failed';ms:number|null}
export interface WorkerTelemetrySnapshot {admission_ms:number[];admission_denied:number;admission_errors:number;db:ProbeSample;redis:ProbeSample}
interface Sample {at:number;ms:number;outcome:'allowed'|'denied'|'error'}
/** Sampling has fixed memory per queue and never waits for storage on the admission path. */
export class WorkerTelemetry {
 private samples=new Map<QueueKind,Sample[]>();
 private db:ProbeSample={state:'pending',ms:null};private redis:ProbeSample={state:'pending',ms:null};
 constructor(private readonly dbProbe:()=>Promise<unknown>,private readonly redisProbe:()=>Promise<unknown>,private readonly now=()=>performance.now()){}
 private recent(queue:QueueKind){const result=(this.samples.get(queue)??[]).filter(s=>s.at>=this.now()-900000).slice(-256);this.samples.set(queue,result);return result}
 async admit<T extends {allowed:boolean}>(queue:QueueKind,run:()=>Promise<T>):Promise<T>{
  const started=this.now();let outcome:Sample['outcome']='error';
  try{const value=await run();outcome=value.allowed?'allowed':'denied';return value}
  finally{const at=this.now(),rows=this.recent(queue);rows.push({at,ms:Math.max(0,at-started),outcome});if(rows.length>256)rows.shift()}
 }
 async probe(){
  const measure=async(run:()=>Promise<unknown>):Promise<ProbeSample>=>{const started=this.now();try{await run();return {state:'ok',ms:Math.max(0,this.now()-started)}}catch{return {state:'failed',ms:null}}};
  [this.db,this.redis]=await Promise.all([measure(this.dbProbe),measure(this.redisProbe)]);
 }
 snapshot(queue:QueueKind):WorkerTelemetrySnapshot{
  const samples=this.recent(queue);return {admission_ms:samples.map(s=>s.ms),admission_denied:samples.filter(s=>s.outcome==='denied').length,admission_errors:samples.filter(s=>s.outcome==='error').length,db:{...this.db},redis:{...this.redis}};
 }
}
export function createWorkerTelemetry(pool:pg.Pool,url:string,installation:string){
 const redis=new Redis({...redisConnection(url),connectionName:`${redisClientPrefix(installation)}probe:${process.pid}`,maxRetriesPerRequest:0,enableOfflineQueue:false,commandTimeout:1000,retryStrategy:attempt=>Math.min(attempt*250,1000)});
 redis.on('error',()=>{});
 const query:pg.QueryConfig&{query_timeout:number}={text:'SELECT 1',query_timeout:1000};
 const telemetry=new WorkerTelemetry(()=>pool.query(query),()=>redis.ping());
 return {telemetry,close:()=>redis.disconnect()};
}
