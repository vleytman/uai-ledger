import type {WorkerTelemetrySnapshot} from './worker-telemetry.js';
import type pg from 'pg';
import type {QueueKind} from './transport.js';
export interface WorkerQueueActivity {queue_kind:QueueKind;concurrency:number;active_jobs:number;telemetry?:WorkerTelemetrySnapshot}
export type WorkerHeartbeatState='running'|'draining'|'stopped';
export async function writeWorkerHeartbeat(pool:pg.Pool,installation:string,worker:string,state:WorkerHeartbeatState,queues:WorkerQueueActivity[]){
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(installation)||!worker||!queues.length||queues.length>6||new Set(queues.map(q=>q.queue_kind)).size!==queues.length)throw new Error('invalid_worker_heartbeat');
 if(queues.some(q=>!Number.isSafeInteger(q.concurrency)||q.concurrency<1||!Number.isSafeInteger(q.active_jobs)||q.active_jobs<0||q.active_jobs>q.concurrency))throw new Error('invalid_worker_activity');
 await pool.query(`INSERT INTO execution_worker_heartbeats(installation_id,worker_id,queue_kind,concurrency,active_jobs,state,telemetry)
  SELECT $1,$2,q.queue_kind,q.concurrency,q.active_jobs,$3,COALESCE(q.telemetry,'{}'::jsonb) FROM jsonb_to_recordset($4::jsonb) AS q(queue_kind text,concurrency integer,active_jobs integer,telemetry jsonb)
  ON CONFLICT(installation_id,worker_id,queue_kind) DO UPDATE SET concurrency=excluded.concurrency,
   active_jobs=excluded.active_jobs,state=excluded.state,telemetry=excluded.telemetry,heartbeat_at=clock_timestamp()`,[installation,worker,state,JSON.stringify(queues)]);
}
/** Single-flight, best-effort telemetry. It never grants permission to send provider requests. */
export function startWorkerHeartbeat(pool:pg.Pool,installation:string,worker:string,snapshot:()=>WorkerQueueActivity[],intervalMs=10000,probe?:()=>Promise<void>){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<10)throw new Error('invalid_heartbeat_interval');
 let state:WorkerHeartbeatState='running',closed=false,prune=true,inFlight:Promise<void>|undefined;
 const publish=()=>{
  if(closed||inFlight)return;
  inFlight=(async()=>{
   if(prune){await pool.query("DELETE FROM execution_worker_heartbeats WHERE installation_id=$1 AND heartbeat_at<clock_timestamp()-interval '7 days'",[installation]);prune=false}
   await probe?.();
   await writeWorkerHeartbeat(pool,installation,worker,state,snapshot());
  })().catch(()=>{console.error('worker_heartbeat_failed')}).finally(()=>{inFlight=undefined});
 };
 const timer=setInterval(publish,intervalMs);timer.unref();publish();
 return {
  async drain(){state='draining';await inFlight;publish()},
  async close(){closed=true;clearInterval(timer);await inFlight;try{await writeWorkerHeartbeat(pool,installation,worker,'stopped',snapshot())}catch{console.error('worker_heartbeat_failed')}},
 };
}
