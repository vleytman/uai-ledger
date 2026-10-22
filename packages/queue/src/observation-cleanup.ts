import type pg from 'pg';
import {systemClock,type Clock} from '../../contracts/src/index.js';
import {ExecutionTransport} from './transport.js';

const initialized=new WeakSet<object>();

// Only a scan cursor: losing it repeats safe checks. Domain progress lives in PG.
const claimSlice=`local start=tonumber(redis.call('GET',KEYS[1]) or '0') % tonumber(ARGV[1])
redis.call('SET',KEYS[1],(start+tonumber(ARGV[2])) % tonumber(ARGV[1]),'EX',86400)
return start`;

/** Remove obsolete queued polls, never active jobs or authoritative domain data. */
export async function cleanObservationDeliveries(pool:pg.Pool,transport:ExecutionTransport,options:{batchSize?:number;clock?:Clock}={}){
 const batch=options.batchSize??100,clock=options.clock??systemClock;
 if(!Number.isSafeInteger(batch)||batch<1||batch>1000)throw new Error('invalid_observation_cleanup_batch');
 const queue=transport.queue('observe'),redis=await queue.client;
 if(!initialized.has(redis)){redis.defineCommand('uaiObservationCleanupSlice',{numberOfKeys:1,lua:claimSlice});initialized.add(redis)}
 let checked=0,removed=0;
 for(const state of ['waiting','delayed','prioritized'] as const){
  const count=await queue.getJobCountByTypes(state);if(!count)continue;
  const start=Number(await redis.runCommand('uaiObservationCleanupSlice',[queue.toKey(`uai-cleanup-${state}`),count,batch]));
  const take=Math.min(batch,count),end=start+take;
  const jobs=await queue.getJobs([state],start,Math.min(end,count)-1,true);
  if(end>count)jobs.push(...await queue.getJobs([state],0,end-count-1,true));
  const polls=jobs.filter(job=>job.data.purpose==='observe'&&typeof job.data.request_id==='string'&&Number.isSafeInteger(job.data.generation)&&Number.isSafeInteger(job.data.poll_count));
  if(!polls.length)continue;
  // Temporary lease and next_poll_at do not invalidate a delivery. Only identity,
  // terminal state and the existing observation horizon can make it obsolete.
  const current=(await pool.query(`SELECT r.id,r.dispatch_generation,a.poll_count FROM execution_requests r
   JOIN execution_attempts a ON a.request_id=r.id AND a.number=r.attempt_count
   WHERE r.id=ANY($1::text[]) AND r.execution_backend='bullmq' AND a.remote_job_id IS NOT NULL
    AND (r.execution_status IN ('running','outcome_unknown') OR (r.execution_status IN ('succeeded','canceled','refused') AND a.cost_units IS NULL))
    AND r.deadline_at+INTERVAL '1 hour'>$2`,[polls.map(job=>job.data.request_id),clock.now()])).rows;
  const key=(request:string,generation:number,poll:number)=>JSON.stringify([request,generation,poll]);
  const live=new Set(current.map(row=>key(row.id,row.dispatch_generation,row.poll_count)));
  for(const job of polls){
   checked++;
   if(live.has(key(job.data.request_id,job.data.generation,job.data.poll_count!)))continue;
   if(await job.getState()==='active')continue;
   try{await job.remove();removed++}catch(error){
    // A worker can acquire its lock between getState and remove. BullMQ's atomic
    // remove refuses that lock; the worker will reject the stale domain identity.
    if(await job.getState()!=='active')throw error;
   }
  }
 }
 return {checked,removed};
}
