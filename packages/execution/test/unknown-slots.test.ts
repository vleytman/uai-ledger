import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {transaction,type Tx} from '../../db/src/index.js';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {ManualClock,id,type Scope} from '../../contracts/src/index.js';
import {putInput} from '../../storage/src/index.js';
import * as execution from '../src/index.js';
import {enqueue,configureBudget,configureLimiter,leaseNext,prepareDispatch,observeAttempt,recoverExpiredLeases,recordRemoteJob,closeUnresolved,expireRequests,leaseObservation,getRequest,type ExecutionRoute,type Settlement} from '../src/index.js';

// Failure modes covered here (LogoPanel real_projects, 2026-10-20):
// 1. an unknown attempt keeps its limiter slot after its request is financially closed;
// 2. it keeps the slot long after the deadline, when no outcome can land any more;
// 3. the slot is released too early, while a remote job can still report;
// 4. financial absorption leaves the attempt non-terminal, so rows must be edited by hand;
// 5. an operator has no audited way to resolve an unknown attempt (charged or not);
// 6. a request starved by the limiter is reported as deadline_exceeded with zero attempts.
const database=isolatedTestDatabase(process.env.DATABASE_URL);
beforeAll(async()=>{if(process.env.DATABASE_URL)await database.initialize()});
afterAll(()=>database.close());
const db=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(database.pool!,fn);
const sql=(text:string,values:unknown[]=[])=>database.pool!.query(text,values);
const resolveUnknownAttempt=(scope:Scope,clock:ManualClock,input:Parameters<typeof execution.resolveUnknownAttempt>[3],settle:Settlement)=>db(t=>execution.resolveUnknownAttempt(t,scope,clock,input,settle));

async function setup(concurrency:number){
 const s:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
 const clock=new ManualClock(new Date('2026-10-20T22:41:00Z'));
 const connection=id('conn'),limiter=id('limiter');
 const route:ExecutionRoute={primary:{connection_id:connection,model:'fixture',endpoint_scope:id('endpoint'),max_cost_units:'10',limiter_key:limiter},period_budget_key:id('period'),request_risk_limit_units:'1000',incident_risk_limit_units:'1000'};
 await db(async t=>{
  await configureBudget(t,s,'provider',connection,'10000');await configureBudget(t,s,'period',route.period_budget_key,'10000');
  await configureLimiter(t,s,clock,{key:limiter,window_ms:1000,request_limit:1000,token_limit:'0',concurrency_limit:concurrency});
 });
 const charges:string[]=[];const settle:Settlement=async(_t,_s,input)=>{charges.push(input.charged_units)};
 const limits={scope:s,global:100,application:100,account:100};
 const add=(deadlineMs=7200000,extra:Record<string,unknown>={})=>db(async t=>{
  const input=await putInput(t,s,clock,{content:{prompt:'fixture'},expires_at:new Date(clock.now().getTime()+86400000)});
  return enqueue(t,s,clock,{priority:10,operation_id:id('op'),component:'single',client_request_key:id('key'),input_hash:'hash',input_ref:input.id,route,max_units:'100',deadline_at:new Date(clock.now().getTime()+deadlineMs),...extra});
 });
 const lease=(requestId:string)=>db(t=>leaseNext(t,clock,'worker',limits,settle,requestId));
 // Returns null when the limiter makes the request wait.
 const dispatch=async(requestId:string)=>{
  const leased=await lease(requestId);if(!leased)return null;
  const attempt=await db(t=>prepareDispatch(t,s,clock,leased.id,leased.fencing_token));
  return attempt&&{lease:leased,attempt};
 };
 const unknown=async(requestId:string)=>{
  const sent=(await dispatch(requestId))!;
  await db(t=>observeAttempt(t,s,clock,{request_id:requestId,attempt_id:sent.attempt.id,fence:sent.lease.fencing_token,observation_key:'lost',outcome:'unknown'},settle));
  return sent;
 };
 const attempt=async(attemptId:string)=>(await sql('SELECT status,cost_units,charged_units,finished_at FROM execution_attempts WHERE id=$1',[attemptId])).rows[0];
 const budget=async(kind:string)=>(await sql('SELECT reserved_units,spent_units FROM execution_budgets WHERE organization_id=$1 AND kind=$2',[s.organization_id,kind])).rows[0];
 const to=(at:Date|string|number)=>clock.advance(new Date(at).getTime()-clock.now().getTime());
 return {s,clock,route,charges,settle,add,lease,dispatch,unknown,attempt,budget,to};
}

describe.skipIf(!process.env.DATABASE_URL)('unknown outcomes and limiter slots',()=>{
 it('keeps a protective slot only while the unknown outcome can still land',async()=>{
  const f=await setup(2);
  const crashed=await f.add(600000),remote=await f.add(600000);
  const sent=(await f.dispatch(crashed.id))!;
  const job=(await f.dispatch(remote.id))!;
  await db(t=>recordRemoteJob(t,f.s,f.clock,remote.id,job.lease.fencing_token,job.attempt.id,'remote-job-1'));
  await db(t=>observeAttempt(t,f.s,f.clock,{request_id:remote.id,attempt_id:job.attempt.id,fence:job.lease.fencing_token,observation_key:'lost',outcome:'unknown'},f.settle));
  // The worker holding the first request dies after its submission intent.
  f.clock.advance(30001);await db(t=>recoverExpiredLeases(t,f.clock,f.s));
  expect((await f.attempt(sent.attempt.id)).status).toBe('outcome_unknown');

  const waiting=await f.add();
  expect(await f.dispatch(waiting.id)).toBeNull();
  expect(await getRequest(database.pool!,f.s,waiting.id)).toMatchObject({reason:'waiting_rate_limit',attempt_count:0});
  // Synchronous call: held until the deadline plus the provider grace window, then released.
  f.to(new Date(crashed.deadline_at).getTime()+execution.UNKNOWN_SLOT_GRACE_MS-1000);
  expect(await f.dispatch(waiting.id)).toBeNull();
  f.clock.advance(1000);
  expect((await f.dispatch(waiting.id))?.attempt.number).toBe(1);
  // A remote job can still report until the observation window closes.
  const next=await f.add(7200000,{initial_queue_budget_ms:7200000});
  expect(await f.dispatch(next.id)).toBeNull();
  f.to(new Date(remote.deadline_at).getTime()+execution.REMOTE_OBSERVATION_WINDOW_MS);
  expect((await f.dispatch(next.id))?.attempt.number).toBe(1);
  expect(f.charges).toEqual([]);
 });

 it('closes the unknown attempt when maintenance absorbs its request and frees the slot in the same transaction',async()=>{
  const f=await setup(1);
  const lost=await f.add(),{lease,attempt}=await f.unknown(lost.id);
  const next=await f.add(7200000,{initial_queue_budget_ms:7200000});
  expect(await f.dispatch(next.id)).toBeNull();
  f.clock.advance(3600001);
  expect(await db(t=>closeUnresolved(t,f.clock,f.settle,f.s))).toBe(1);
  expect(await getRequest(database.pool!,f.s,lost.id)).toMatchObject({execution_status:'outcome_unknown',settlement_status:'platform_absorbed'});
  expect(await f.attempt(attempt.id)).toEqual({status:'abandoned',cost_units:null,charged_units:'0',finished_at:f.clock.now()});
  expect(f.charges).toEqual(['0']);
  expect((await f.dispatch(next.id))?.attempt.number).toBe(1);
  // A late provider answer is still recorded for reconciliation, without a customer debit.
  const observer=await db(t=>leaseObservation(t,f.s,f.clock,lost.id,'lookup'));
  expect(observer.fencing_token).not.toBe(lease.fencing_token);
  await db(t=>observeAttempt(t,f.s,f.clock,{request_id:lost.id,attempt_id:attempt.id,fence:observer.fencing_token,observation_key:'still-unknown',outcome:'unknown'},f.settle));
  expect((await f.attempt(attempt.id)).status).toBe('abandoned');
  const answer=await db(t=>leaseObservation(t,f.s,f.clock,lost.id,'lookup'));
  await db(t=>observeAttempt(t,f.s,f.clock,{request_id:lost.id,attempt_id:attempt.id,fence:answer.fencing_token,observation_key:'late',outcome:'success',cost_units:'6',charged_units:'6'},async()=>{throw new Error('late debit')}));
  expect(await f.attempt(attempt.id)).toMatchObject({status:'succeeded',cost_units:'6',charged_units:'0'});
 });

 it('stops counting unknown attempts left open by an earlier version and backfills them as abandoned',async()=>{
  const f=await setup(1);
  const lost=await f.add(),{attempt}=await f.unknown(lost.id);
  // State written before this change: the request was absorbed, the attempt kept outcome_unknown.
  f.clock.advance(3600001);await db(t=>closeUnresolved(t,f.clock,f.settle,f.s));
  await sql("UPDATE execution_attempts SET status='outcome_unknown',finished_at=NULL WHERE id=$1",[attempt.id]);
  const next=await f.add();
  expect((await f.dispatch(next.id))?.attempt.number).toBe(1);
  const migration=await readFile(new URL('../../../migrations/0073_unknown_slot_release.sql',import.meta.url),'utf8');
  await sql(migration.split(';').find(statement=>statement.includes('UPDATE execution_attempts'))!);
  expect((await f.attempt(attempt.id)).status).toBe('abandoned');
 });

 it('resolves an unknown attempt through an audited action instead of row edits',async()=>{
  const f=await setup(1);
  const lost=await f.add(),sent=(await f.dispatch(lost.id))!;
  const input={request_id:lost.id,attempt_id:sent.attempt.id,actor_id:'operator',reason:'Provider usage page lists this call',provider_charged:true,cost_units:'7'};
  await expect(resolveUnknownAttempt(f.s,f.clock,input,f.settle)).rejects.toMatchObject({code:'unknown_attempt_required'});
  await db(t=>observeAttempt(t,f.s,f.clock,{request_id:lost.id,attempt_id:sent.attempt.id,fence:sent.lease.fencing_token,observation_key:'lost',outcome:'unknown'},f.settle));
  const next=await f.add();
  expect(await f.dispatch(next.id)).toBeNull();
  await expect(resolveUnknownAttempt(f.s,f.clock,{...input,reason:' '},f.settle)).rejects.toMatchObject({code:'reason_required'});
  await expect(resolveUnknownAttempt({...f.s,account_id:'foreign'},f.clock,input,f.settle)).rejects.toMatchObject({code:'not_found'});
  await expect(resolveUnknownAttempt(f.s,f.clock,{...input,cost_units:undefined},f.settle)).rejects.toMatchObject({code:'invalid_input'});
  await expect(resolveUnknownAttempt(f.s,f.clock,{...input,provider_charged:false},f.settle)).rejects.toMatchObject({code:'invalid_input'});
  const observer=await db(t=>leaseObservation(t,f.s,f.clock,lost.id,'lookup'));
  await expect(resolveUnknownAttempt(f.s,f.clock,input,f.settle)).rejects.toMatchObject({code:'request_leased'});
  f.to(observer.lease_expires_at);

  const done=await resolveUnknownAttempt(f.s,f.clock,input,f.settle);
  expect(await resolveUnknownAttempt(f.s,f.clock,input,f.settle)).toMatchObject({id:lost.id});
  await expect(resolveUnknownAttempt(f.s,f.clock,{...input,cost_units:'8'},f.settle)).rejects.toMatchObject({code:'observation_conflict'});
  expect(done).toMatchObject({execution_status:'outcome_unknown',settlement_status:'platform_absorbed'});
  expect(done.financial_closed_at).not.toBeNull();
  expect(f.charges).toEqual(['0']);
  expect(await f.attempt(sent.attempt.id)).toMatchObject({status:'abandoned',cost_units:'7',charged_units:'0'});
  expect(await f.budget('provider')).toEqual({reserved_units:'0',spent_units:'7'});
  const audit=(await sql("SELECT actor_id,reason,metadata FROM audit_events WHERE resource_id=$1 AND action='attempt.unknown_resolved'",[sent.attempt.id])).rows;
  expect(audit).toEqual([{actor_id:'operator',reason:input.reason,metadata:{request_id:lost.id,provider_charged:true,cost_units:'7',previous_status:'outcome_unknown'}}]);
  expect((await f.dispatch(next.id))?.attempt.number).toBe(1);
 });

 it('settles the retained provider exposure when an absorbed attempt is later confirmed as not charged',async()=>{
  const f=await setup(1);
  const lost=await f.add(),{attempt}=await f.unknown(lost.id);
  f.clock.advance(3600001);await db(t=>closeUnresolved(t,f.clock,f.settle,f.s));
  expect(await f.budget('provider')).toEqual({reserved_units:'10',spent_units:'0'});
  const done=await resolveUnknownAttempt(f.s,f.clock,{request_id:lost.id,attempt_id:attempt.id,actor_id:'operator',reason:'Not in the provider usage export',provider_charged:false},f.settle);
  expect(done.settlement_status).toBe('platform_absorbed');
  expect(f.charges).toEqual(['0']);
  expect(await f.attempt(attempt.id)).toMatchObject({status:'abandoned',cost_units:'0'});
  expect(await f.budget('provider')).toEqual({reserved_units:'0',spent_units:'0'});
  await expect(resolveUnknownAttempt(f.s,f.clock,{request_id:lost.id,attempt_id:attempt.id,actor_id:'operator',reason:'Second look',provider_charged:true,cost_units:'3'},f.settle)).rejects.toMatchObject({code:'observation_conflict'});
 });

 it('reports requests that never got a slot by their own reason instead of deadline_exceeded',async()=>{
  const f=await setup(1);
  const holder=await f.add();await f.unknown(holder.id);
  const starved=await f.add(600000),expiring=await f.add(600000),queued=await f.add(7200000,{initial_queue_budget_ms:300000});
  expect(await f.dispatch(starved.id)).toBeNull();
  expect(await f.dispatch(expiring.id)).toBeNull();
  f.clock.advance(600001);
  expect(await f.lease(starved.id)).toBeNull();
  await db(t=>expireRequests(t,f.clock,f.settle,f.s));
  expect(await f.lease(queued.id)).toBeNull();
  const reasons=Object.fromEntries(await Promise.all([starved,expiring,queued].map(async r=>{const row=await getRequest(database.pool!,f.s,r.id);return [r.id,[row.execution_status,row.reason,row.attempt_count]]})));
  expect(reasons).toEqual({[starved.id]:['canceled','rate_limit_starved',0],[expiring.id]:['canceled','rate_limit_starved',0],[queued.id]:['canceled','admission_timeout',0]});
  const events=(await sql("SELECT resource->>'id' AS id,data->>'reason' AS reason FROM outbox_events WHERE organization_id=$1 AND type='request.canceled' ORDER BY occurred_at,id",[f.s.organization_id])).rows;
  expect(new Map(events.map(e=>[e.id,e.reason]))).toEqual(new Map([[starved.id,'rate_limit_starved'],[expiring.id,'rate_limit_starved'],[queued.id,'admission_timeout']]));
  expect(f.charges).toEqual(['0','0','0']);
 });
});
