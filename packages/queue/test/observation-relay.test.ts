import {cleanObservationDeliveries} from '../src/observation-cleanup.js';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id,ManualClock} from '../../contracts/src/index.js';
import {enqueue,type ExecutionRoute} from '../../execution/src/index.js';
import {relayObservations} from '../src/observation-relay.js';
import {ExecutionTransport} from '../src/transport.js';

const sourceUrl=process.env.DATABASE_URL,database=isolatedTestDatabase(sourceUrl);
let pool:ReturnType<typeof createPool>|null=null;
const redis=process.env.REDIS_URL;
beforeAll(async()=>{if(sourceUrl&&redis){await database.initialize();pool=database.pool}});
afterAll(()=>database.close());

// Seed durable pending native jobs. No provider calls or accounting mutations.
async function fixture(counts:number[],accountsPerApplication=Number.POSITIVE_INFINITY){
 const organization=id('observe-org'),application=id('observe-app');
 const clock=new ManualClock(new Date('2199-01-01T00:00:00Z'));
 const transport=new ExecutionTransport(id('observe-fairness'),redis!);
 const accounts=counts.map(()=>id('account')),requests=new Map<string,string>();
 const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
 for(let account=0;account<counts.length;account++)for(let n=0;n<counts[account]!;n++){
  const scope={organization_id:organization,application_id:`${application}_${Math.floor(account/accountsPerApplication)}`,account_id:accounts[account]!};
  await transaction(pool!,async tx=>{
   const request=await enqueue(tx,scope,clock,{operation_id:id('op'),component:'image',client_request_key:id('key'),input_hash:'test',input_ref:'test',route,max_units:'0',deadline_at:new Date(clock.now().getTime()+60000)});
   await tx.query("UPDATE execution_requests SET execution_backend='bullmq',execution_status='running',attempt_count=1 WHERE id=$1",[request.id]);
   await tx.query(`INSERT INTO execution_attempts(id,request_id,number,fencing_token,variant,status,submission_intent_at,provider_idempotency_key,remote_job_id,created_at)
    VALUES($1,$2,1,0,$3,'running',$4,$1,$1,$4)`,[id('attempt'),request.id,route.primary,clock.now()]);
   requests.set(request.id,scope.account_id);
  });
 }
 return {clock,transport,accounts,requests,cleanup:async()=>{
  await pool!.query('DELETE FROM execution_attempts WHERE request_id=ANY($1::text[])',[[...requests.keys()]]);
  await pool!.query('DELETE FROM execution_requests WHERE id=ANY($1::text[])',[[...requests.keys()]]);
  await pool!.query('DELETE FROM execution_dispatch_fairness WHERE organization_id=$1',[organization]);
  await transport.queue('observe').obliterate({force:true});await transport.close();
 }};
}

describe.skipIf(!sourceUrl||!redis)('native observation relay fairness',()=>{
 it('serves different accounts before taking more jobs from a large account, then rotates',async()=>{
  const f=await fixture([12,1,1]);
  try{
   expect(await relayObservations(pool!,f.transport,{clock:f.clock,batchSize:2})).toEqual({checked:2,published:2});
   const first=await f.transport.queue('observe').getJobs(['waiting']);
   expect(new Set(first.map(job=>f.requests.get(job.data.request_id))).size).toBe(2);
   f.clock.advance(1);
   expect(await relayObservations(pool!,f.transport,{clock:f.clock,batchSize:2})).toEqual({checked:2,published:2});
   const next=await f.transport.queue('observe').getJobs(['waiting']);
   expect(new Set(next.map(job=>f.requests.get(job.data.request_id)))).toEqual(new Set(f.accounts));
   expect(next).toHaveLength(4);
  }finally{await f.cleanup()}
 });
 it('rotates cleanup past healthy jobs and removes only obsolete poll identities',async()=>{
  const f=await fixture([1,1,1,1,1,1]);
  try{
   await relayObservations(pool!,f.transport,{clock:f.clock,batchSize:6});
   const jobs=await f.transport.queue('observe').getJobs(['waiting'],0,-1,true);
   const stale=jobs[5]!;
   await pool!.query('UPDATE execution_attempts SET poll_count=poll_count+1 WHERE request_id=$1',[stale.data.request_id]);
   expect(await cleanObservationDeliveries(pool!,f.transport,{clock:f.clock,batchSize:2})).toEqual({checked:2,removed:0});
   expect(await cleanObservationDeliveries(pool!,f.transport,{clock:f.clock,batchSize:2})).toEqual({checked:2,removed:0});
   expect(await cleanObservationDeliveries(pool!,f.transport,{clock:f.clock,batchSize:2})).toEqual({checked:2,removed:1});
   expect(await f.transport.queue('observe').getWaitingCount()).toBe(5);
   // Terminal content with unresolved provider cost must remain observable.
   await pool!.query("UPDATE execution_requests SET execution_status='succeeded' WHERE id=$1",[jobs[0]!.data.request_id]);
   const queue=f.transport.queue('observe');
   await (await queue.client).set(queue.toKey('uai-cleanup-waiting'),'3');
   expect(await cleanObservationDeliveries(pool!,f.transport,{clock:f.clock})).toEqual({checked:5,removed:0});
   await pool!.query('UPDATE execution_attempts SET cost_units=0 WHERE request_id=$1',[jobs[0]!.data.request_id]);
   let removed=0;
   for(let i=0;i<3;i++)removed+=(await cleanObservationDeliveries(pool!,f.transport,{clock:f.clock})).removed;
   expect(removed).toBe(1);
   expect(await f.transport.queue('observe').getWaitingCount()).toBe(4);
  }finally{await f.cleanup()}
 });
 it('cleans delayed and prioritized stale deliveries while an active worker keeps its job',async()=>{
  const f=await fixture([1]);let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve});
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve});
  try{
   await relayObservations(pool!,f.transport,{clock:f.clock});
   f.transport.consume('observe',1,async()=>{started();await blocked},()=>{});
   await ready;
   const queue=f.transport.queue('observe');
   const active=(await queue.getJobs(['active']))[0]!;
   await pool!.query('UPDATE execution_attempts SET poll_count=poll_count+1 WHERE request_id=$1',[active.data.request_id]);
   await f.transport.pause();
   const ghost={request_id:id('missing'),generation:0,purpose:'observe' as const,poll_count:0};
   await queue.add('observe',ghost,{delay:60000});
   await queue.add('observe',{...ghost,request_id:id('missing')},{priority:2});
   expect(await cleanObservationDeliveries(pool!,f.transport,{clock:f.clock})).toEqual({checked:2,removed:2});
   expect(await active.getState()).toBe('active');
  }finally{release();await f.cleanup()}
 });
 it('bounds outstanding observations across applications and the installation',async()=>{
  const f=await fixture(Array.from({length:90},()=>2),20);
  try{
   const results=await Promise.all(Array.from({length:3},()=>relayObservations(pool!,f.transport,{clock:f.clock,batchSize:256})));
   expect(results.reduce((n,result)=>n+result.published,0)).toBe(128);
   const counts=(await pool!.query(`SELECT r.application_id,count(*)::int AS n FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id
    WHERE a.observation_selected_poll=a.poll_count AND r.id=ANY($1::text[]) GROUP BY r.application_id`,[[...f.requests.keys()]])).rows;
   expect(counts.every(row=>row.n<=32)).toBe(true);
   expect(counts.reduce((n,row)=>n+row.n,0)).toBe(128);
   expect(await f.transport.queue('observe').getWaitingCount()).toBe(128);
  }finally{await f.cleanup()}
 });
 it('concurrent relays respect account publication caps and repair lost deliveries at capacity',async()=>{
  const f=await fixture([8,8,8]);
  try{
   const batches=await Promise.all(Array.from({length:4},()=>relayObservations(pool!,f.transport,{clock:f.clock,batchSize:6})));
   expect(batches.reduce((sum,batch)=>sum+batch.published,0)).toBe(6);
   const jobs=await f.transport.queue('observe').getJobs(['waiting']);
   expect(new Set(jobs.map(job=>job.data.request_id)).size).toBe(6);
   for(const account of f.accounts)expect(jobs.filter(job=>f.requests.get(job.data.request_id)===account)).toHaveLength(2);
   expect((await pool!.query('SELECT observation_delivery_count,observation_relay_owner FROM execution_attempts WHERE observation_selected_poll IS NOT NULL AND request_id=ANY($1::text[])',[[...f.requests.keys()]])).rows.every(row=>row.observation_delivery_count===1&&row.observation_relay_owner===null)).toBe(true);
   await jobs[0]!.remove();f.clock.advance(5000);
   expect(await relayObservations(pool!,f.transport,{clock:f.clock,batchSize:24})).toEqual({checked:6,published:1});
   expect(await f.transport.queue('observe').getWaitingCount()).toBe(6);
   // Completing a poll releases its durable slot for a different due job.
   const done=jobs[1]!;await done.remove();
   await pool!.query("UPDATE execution_attempts SET poll_count=poll_count+1,next_poll_at=$2 WHERE request_id=$1",[done.data.request_id,new Date(f.clock.now().getTime()+60000)]);
   expect(await relayObservations(pool!,f.transport,{clock:f.clock,batchSize:24})).toEqual({checked:1,published:1});
   expect(await f.transport.queue('observe').getWaitingCount()).toBe(6);
  }finally{await f.cleanup()}
 });
});
