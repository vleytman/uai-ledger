import {persistCost} from '../../pricing/src/persistence.js';
import {confirmFailedAttemptCost} from '../src/index.js';
import {resolveExecutionPolicy} from '../../contracts/invocation.js';
import {lockExecutionAccount} from '../../db/src/execution-lock.js';
import { executeRequest, executeOne, validateOutput } from '../src/runtime.js';
import { FakeAdapter } from '../../providers/src/index.js';
import type { RateCard } from '../../pricing/src/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, transaction } from '../../db/src/index.js';
import { ManualClock, id, type Scope } from '../../contracts/src/index.js';
import { enqueue, closeUnsentIfRequired, configureBudget, configureLimiter, leaseNext, prepareDispatch, recoverExpiredLeases, getRequest, observeAttempt, leaseObservation, closeUnresolved, cancelRequest, type ExecutionRoute, type Settlement } from '../src/index.js';
import { acknowledge, createManifest, deleteContent, getDelivery, putInput, getInput, expireContent, registerAsset, getAsset, leasePurge, completePurge, finalizeDeletions,holdInputAssets,renewInputAsset } from '../../storage/src/index.js';
const url=process.env.DATABASE_URL;
const pool=url?createPool(url):null;
afterAll(async()=>{await pool?.end();});
const db=<T>(fn:Parameters<typeof transaction<T>>[1])=>transaction(pool!,fn);
const settled:Settlement=async()=>{};
async function setup(){const s:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};const clock=new ManualClock(new Date('2026-09-18T00:00:00Z'));const conn=id('conn');const route:ExecutionRoute={primary:{connection_id:conn,model:'fixture',endpoint_scope:id('endpoint'),max_cost_units:'10'},fallback:{connection_id:conn,model:'fixture-fallback',endpoint_scope:id('endpoint'),max_cost_units:'10'},period_budget_key:id('period'),request_risk_limit_units:'1000',incident_risk_limit_units:'1000'};await db(async t=>{await configureBudget(t,s,'provider',conn,'10000');await configureBudget(t,s,'period',route.period_budget_key,'10000');});return{s,clock,route};}
async function add(f:Awaited<ReturnType<typeof setup>>,extra:Record<string,unknown>={}){return db(async t=>{const input=await putInput(t,f.s,f.clock,{content:{prompt:'secret fixture'},expires_at:new Date(f.clock.now().getTime()+7200000)});return enqueue(t,f.s,f.clock,{priority:10,operation_id:id('op'),component:'single',client_request_key:id('key'),input_hash:'hash',input_ref:input.id,route:f.route,max_units:'100',deadline_at:new Date(f.clock.now().getTime()+7200000),...extra});});}
async function dispatch(f:Awaited<ReturnType<typeof setup>>){const lease=await db(t=>leaseNext(t,f.clock,'worker',{scope:f.s},settled));expect(lease).not.toBeNull();const attempt=await db(t=>prepareDispatch(t,f.s,f.clock,lease.id,lease.fencing_token));return {lease,attempt};}
describe.skipIf(!url)('PostgreSQL execution and storage',()=>{
 it.each([false,true])('confirms failed cost once without retry or customer charge, already closed=%s',async closed=>{
  const f=await setup();f.route.execution=resolveExecutionPolicy(undefined,{max_attempts:1});const r=await add(f);const {lease,attempt}=await dispatch(f);
  const failed=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'429',outcome:'transient',safe_to_retry:true},settled));expect(failed.execution_status).toBe('failed');expect(failed.settlement_status).toBe('unresolved');
  const charges:string[]=[];const settle:Settlement=async(_t,_s,i)=>{charges.push(i.charged_units)};
  if(closed){f.clock.advance(3600001);await db(t=>closeUnresolved(t,f.clock,settle,f.s));}
  const cost=await db(t=>persistCost(t,f.s,{identity:'confirmed-zero',attempt_id:attempt.id,connection_id:attempt.variant.connection_id,model:attempt.variant.model,usage:{state:'known',items:[{dimension:'output.text',quantity:'0',unit:'tokens'}]},rate_card:{id:'fixture',currency:'USD',source:'synthetic',checked_at:f.clock.now().toISOString(),rates:[{id:'out',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'}]},context:{at:f.clock.now().toISOString()}},f.clock));
  const input={request_id:r.id,attempt_id:attempt.id,cost_entry_id:cost.id,actor_id:'fixture-reconciler',reason:'Verified non-billable error'};
  await expect(db(t=>confirmFailedAttemptCost(t,{...f.s,account_id:'foreign'},f.clock,input,settle))).rejects.toMatchObject({code:'not_found'});
  await expect(db(t=>confirmFailedAttemptCost(t,f.s,f.clock,{...input,cost_entry_id:'unverified'},settle))).rejects.toMatchObject({code:'confirmed_cost_required'});
  const done=await db(t=>confirmFailedAttemptCost(t,f.s,f.clock,input,settle));await db(t=>confirmFailedAttemptCost(t,f.s,f.clock,input,settle));
  expect(done.execution_status).toBe('failed');expect(done.settlement_status).toBe(closed?'platform_absorbed':'settled');expect(charges).toEqual(['0']);
  await expect(db(t=>confirmFailedAttemptCost(t,f.s,f.clock,{...input,reason:'different'},settle))).rejects.toMatchObject({code:'observation_conflict'});
  expect((await pool!.query('SELECT reserved_units,spent_units FROM execution_budgets WHERE organization_id=$1',[f.s.organization_id])).rows.every(b=>b.reserved_units==='0'&&b.spent_units==='0')).toBe(true);
  expect((await pool!.query('SELECT status,cost_units,charged_units FROM execution_attempts WHERE request_id=$1',[r.id])).rows).toEqual([{status:'transient',cost_units:'0',charged_units:'0'}]);
  expect((await pool!.query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='attempt.cost_confirmed'",[attempt.id])).rows).toHaveLength(1);
  expect(await db(t=>leaseNext(t,f.clock,'no-retry',{scope:f.s},settled))).toBeNull();
 });

 it.each(['platform','actual_usage'] as const)('UI-A05 refusal billing %s is terminal and settles once',async policy=>{
  const f=await setup();f.route.billing={refused:policy};const r=await add(f);const {lease,attempt}=await dispatch(f);const charges:string[]=[];
  const settle:Settlement=async(_tx,_scope,input)=>{charges.push(input.charged_units)};
  const observation={request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'refusal',outcome:'refused' as const,cost_units:'10',charged_units:'12'};
  const done=await db(t=>observeAttempt(t,f.s,f.clock,observation,settle));await db(t=>observeAttempt(t,f.s,f.clock,observation,settle));
  expect(done.execution_status).toBe('refused');expect(done.settlement_status).toBe('settled');expect(charges).toEqual([policy==='platform'?'0':'12']);
  expect(await db(t=>leaseNext(t,f.clock,'no-fallback',{scope:f.s},settled))).toBeNull();
 });
 it('UI-A05 refusal with unknown usage retains financial reconciliation',async()=>{
  const f=await setup();f.route.billing={refused:'actual_usage'};const r=await add(f);const {lease,attempt}=await dispatch(f);
  const done=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'refusal-unknown',outcome:'refused'},settled));
  expect(done.execution_status).toBe('refused');expect(done.settlement_status).toBe('unresolved');
  expect((await pool!.query('SELECT cost_units,charged_units FROM execution_attempts WHERE id=$1',[attempt.id])).rows[0]).toEqual({cost_units:null,charged_units:null});
  const observation=await db(t=>leaseObservation(t,f.s,f.clock,r.id,'reconcile'));let captured='';
  await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:observation.fencing_token,observation_key:'refusal-confirmed',outcome:'refused',cost_units:'5',charged_units:'7'},async(_t,_s,input)=>{captured=input.charged_units}));expect(captured).toBe('7');
 });
 it('UI-A12 reusable input survives ACK and expiry while another request holds it',async()=>{
  const f=await setup();const first=await add(f),second=await add(f);
  const asset=await db(t=>registerAsset(t,f.s,f.clock,{kind:'input',blob_key:id('blob'),media_type:'image/png',size_bytes:4,content_hash:'sha256:fixture',expires_at:new Date(f.clock.now().getTime()+10000)}));
  await pool!.query('UPDATE storage_assets SET retention_seconds=10 WHERE id=$1',[asset.id]);
  await db(t=>holdInputAssets(t,f.s,f.clock,first.id,[asset.id]));await db(t=>holdInputAssets(t,f.s,f.clock,second.id,[asset.id]));
  const manifest=await db(t=>createManifest(t,f.s,f.clock,{request_id:first.id,operation_id:first.operation_id,content:'answer',ttl_seconds:3600}));
  await db(t=>acknowledge(t,f.s,f.clock,{request_id:first.id,version:manifest.version,manifest_hash:manifest.manifest_hash}));
  expect((await getAsset(pool!,f.s,f.clock,asset.id,true)).status).toBe('available');
  await db(t=>cancelRequest(t,f.s,f.clock,first.id,settled));f.clock.advance(10001);
  await db(t=>expireContent(t,f.clock,f.s));
  expect((await getAsset(pool!,f.s,f.clock,asset.id,true,second.id)).status).toBe('available');
  await expect(getAsset(pool!,f.s,f.clock,asset.id,true)).rejects.toMatchObject({code:'content_unavailable'});
  await db(t=>cancelRequest(t,f.s,f.clock,second.id,settled));await db(t=>expireContent(t,f.clock,f.s));
  expect((await pool!.query('SELECT status FROM storage_assets WHERE id=$1',[asset.id])).rows[0].status).toBe('expired');
 });
 it('UI-A12 project deletion wins over concurrent renewal and active input holds never bypass tombstones',async()=>{
  const f=await setup(),project=id('project'),request=await add(f,{external_project_id:project,project_generation:'1'});
  const asset=await db(t=>registerAsset(t,f.s,f.clock,{kind:'input',blob_key:id('blob'),media_type:'image/png',size_bytes:4,content_hash:'sha256:fixture',external_project_id:project,project_generation:'1',expires_at:new Date(f.clock.now().getTime()+604800000)}));
  await db(t=>holdInputAssets(t,f.s,f.clock,request.id,[asset.id]));
  const race=await Promise.allSettled([db(t=>renewInputAsset(t,f.s,f.clock,asset.id)),db(t=>deleteContent(t,f.s,f.clock,{external_project_id:project,project_generation:'1',reason:'Delete fixture'}))]);
  expect(race[1].status).toBe('fulfilled');
  await expect(getAsset(pool!,f.s,f.clock,asset.id,true,request.id)).rejects.toMatchObject({code:'content_deleted'});
  await expect(db(t=>renewInputAsset(t,f.s,f.clock,asset.id))).rejects.toMatchObject({code:'content_deleted'});
  await expect(db(t=>holdInputAssets(t,f.s,f.clock,request.id,[asset.id]))).rejects.toMatchObject({code:'content_deleted'});
  await expect(getAsset(pool!,{...f.s,account_id:id('foreign')},f.clock,asset.id,true,request.id)).rejects.toMatchObject({code:'not_found'});
 });
 it('UI-A12 reads do not renew input inactivity, explicit renewal does, foreign owners cannot renew',async()=>{
  const f=await setup();const asset=await db(t=>registerAsset(t,f.s,f.clock,{kind:'input',blob_key:id('blob'),media_type:'image/png',size_bytes:4,content_hash:'sha256:fixture',expires_at:new Date(f.clock.now().getTime()+604800000)}));
  f.clock.advance(1000);expect(new Date((await getAsset(pool!,f.s,f.clock,asset.id)).expires_at)).toEqual(new Date(asset.expires_at));
  const renewed=await db(t=>renewInputAsset(t,f.s,f.clock,asset.id));expect(new Date(renewed.expires_at).getTime()).toBe(f.clock.now().getTime()+604800000);
  await expect(db(t=>renewInputAsset(t,{...f.s,account_id:id('other')},f.clock,asset.id))).rejects.toMatchObject({code:'not_found'});
 });
 it.each([1,4,8])('UI-A02 stops at %i total attempts across workers and fallback',async maximum=>{
  const f=await setup();f.route.execution=resolveExecutionPolicy(undefined,{max_attempts:maximum});const r=await add(f);const models:string[]=[];
  for(let n=0;n<maximum;n++){
   const {lease,attempt}=await dispatch(f);models.push(attempt.variant.model);
   const observation={request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:`failure-${n}`,outcome:'transient' as const,safe_to_retry:true,cost_units:'1'};
   const next=await db(t=>observeAttempt(t,f.s,f.clock,observation,settled));
   expect((await db(t=>observeAttempt(t,f.s,f.clock,observation,settled))).attempt_count).toBe(n+1);
   if(n+1<maximum)f.clock.advance(new Date(next.not_before).getTime()-f.clock.now().getTime());
  }
  const done=await getRequest(pool!,f.s,r.id);expect(done.execution_status).toBe('failed');expect(done.attempt_count).toBe(maximum);
  expect(models).toEqual(Array.from({length:maximum},(_,i)=>i<2?'fixture':'fixture-fallback'));
  expect(await db(t=>leaseNext(t,f.clock,'new-worker',{scope:f.s},settled))).toBeNull();
  expect((await pool!.query('SELECT sum(cost_units)::text total FROM execution_attempts WHERE request_id=$1',[r.id])).rows[0].total).toBe(String(maximum));
 });
 it('UI-A02 concurrent duplicate dispatch commits one intent',async()=>{
  const f=await setup();f.route.execution=resolveExecutionPolicy(undefined,{max_attempts:1});const r=await add(f);
  const lease=await db(t=>leaseNext(t,f.clock,'worker',{scope:f.s},settled));
  const attempts=await Promise.allSettled(Array.from({length:4},()=>db(t=>prepareDispatch(t,f.s,f.clock,r.id,lease.fencing_token))));
  expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
  expect((await getRequest(pool!,f.s,r.id)).attempt_count).toBe(1);
  f.clock.advance(31000);await db(t=>recoverExpiredLeases(t,f.clock,f.s));
  expect((await getRequest(pool!,f.s,r.id)).execution_status).toBe('outcome_unknown');
  expect(await db(t=>leaseNext(t,f.clock,'restart',{scope:f.s},settled))).toBeNull();
 });
 it('UI-A03 Retry-After beyond deadline never dispatches again',async()=>{
  const f=await setup();const r=await add(f,{deadline_at:new Date(f.clock.now().getTime()+10000)});const {lease,attempt}=await dispatch(f);
  const done=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'retry-after',outcome:'transient',safe_to_retry:true,retry_after_ms:10000,cost_units:'0'},settled));
  expect(done.execution_status).toBe('failed');f.clock.advance(10000);
  expect(await db(t=>leaseNext(t,f.clock,'after-deadline',{scope:f.s},settled))).toBeNull();
 });
 it('UI-A03 configured recovery delay does not reset attempts',async()=>{
  const f=await setup();f.route.execution=resolveExecutionPolicy(undefined,{max_attempts:2,recovery:{delays_seconds:[60]}});const r=await add(f);
  const first=await dispatch(f);const next=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:first.attempt.id,fence:first.lease.fencing_token,observation_key:'recover',outcome:'transient',safe_to_retry:true,cost_units:'0'},settled));
  expect(new Date(next.not_before).getTime()-f.clock.now().getTime()).toBe(60000);f.clock.advance(60000);
  const second=await dispatch(f);expect(second.attempt.number).toBe(2);
  const done=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:second.attempt.id,fence:second.lease.fencing_token,observation_key:'stop',outcome:'transient',safe_to_retry:true,cost_units:'0'},settled));
  expect(done.execution_status).toBe('failed');
 });
 it('UI-A04 permits confirmed defect recovery after preliminary output without charging it',async()=>{
  const f=await setup();const r=await add(f);const first=await dispatch(f);
  await pool!.query("UPDATE execution_requests SET reason='output_started' WHERE id=$1",[r.id]);
  const next=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:first.attempt.id,fence:first.lease.fencing_token,observation_key:'defect-stream',outcome:'defect',cost_units:'10'},settled));
  expect(next.execution_status).toBe('waiting_retry');f.clock.advance(new Date(next.not_before).getTime()-f.clock.now().getTime());
  const second=await dispatch(f);expect(second.attempt.number).toBe(2);
  expect((await pool!.query('SELECT charged_units FROM execution_attempts WHERE id=$1',[first.attempt.id])).rows[0].charged_units).toBe('0');
 });
 it('recovers expired leases without the global scheduler lock and skips busy requests',async()=>{
  const f=await setup();const first=await add(f),second=await add(f);
  await db(t=>leaseNext(t,f.clock,'w1',{scope:f.s},settled));
  await db(t=>leaseNext(t,f.clock,'w2',{scope:f.s},settled));
  f.clock.advance(31000);
  const blocker=await pool!.connect();
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(41827430)');
   await blocker.query('SELECT id FROM execution_requests WHERE id=$1 FOR UPDATE',[first.id]);
   const recovered=await db(async tx=>{await tx.query("SET LOCAL lock_timeout='500ms'");return recoverExpiredLeases(tx,f.clock,f.s)});
   expect(recovered).toBe(1);
   expect((await getRequest(pool!,f.s,second.id)).execution_status).toBe('queued');
   expect((await getRequest(pool!,f.s,first.id)).execution_status).toBe('leased');
  }finally{await blocker.query('ROLLBACK');blocker.release()}
  expect(await db(t=>recoverExpiredLeases(t,f.clock,f.s))).toBe(1);
  expect(await db(t=>recoverExpiredLeases(t,f.clock,f.s))).toBe(0);
 });
 it('admits text independently of full image capacity while serializing the last queue slots',async()=>{
  const f=await setup();
  const images=await Promise.all(Array.from({length:3},()=>add(f,{priority:10,backend:'bullmq',capability:'image.generate'})));
  const texts=await Promise.all(Array.from({length:3},()=>add(f,{priority:10,backend:'bullmq',capability:'text.generate'})));
  const lease=(request:any)=>db(t=>leaseNext(t,f.clock,'capacity',{scope:f.s,backend:'bullmq',global:2,application:2,account:2},settled,request.id));
  const imageLeases=await Promise.all(images.map(lease));expect(imageLeases.filter(Boolean)).toHaveLength(2);
  const textLeases=await Promise.all(texts.map(lease));expect(textLeases.filter(Boolean)).toHaveLength(2);
  expect((await pool!.query("SELECT queue_kind,count(*)::int n FROM execution_requests WHERE organization_id=$1 AND execution_status='leased' GROUP BY queue_kind ORDER BY queue_kind",[f.s.organization_id])).rows).toEqual([{queue_kind:'image',n:2},{queue_kind:'text',n:2}]);
 });
 it('closes expired BullMQ requests in a separate financial transaction without lock upgrades',async()=>{
  const f=await setup(),requests=await Promise.all(Array.from({length:2},()=>add(f,{backend:'bullmq',initial_queue_budget_ms:1000})));
  f.clock.advance(1001);const charges:string[]=[];
  const deps={limits:{scope:f.s,backend:'bullmq' as const},blobStore:{put:async()=>{},get:async()=>new Uint8Array(),delete:async()=>{}},
   context:async()=>{throw new Error('expired request reached context')},adapter:async()=>{throw new Error('expired request reached provider')},
   settle:async(tx:any,_scope:Scope,input:any)=>{await lockExecutionAccount(tx,_scope);charges.push(input.charged_units)}};
  const results=await Promise.all(requests.map(r=>executeRequest(pool!,deps,r.id,f.clock)));
  expect(results.map(r=>r.state)).toEqual(['closure_checked','closure_checked']);expect(charges).toEqual(['0','0']);
  for(const r of requests)expect(await getRequest(pool!,f.s,r.id)).toMatchObject({execution_status:'canceled',settlement_status:'settled',attempt_count:0});
  expect((await executeRequest(pool!,deps,requests[0].id,f.clock)).worked).toBe(false);expect(charges).toHaveLength(2);
 });
 it('rechecks expiry before deferred closure and leaves a newly valid request queued',async()=>{
  const f=await setup(),r=await add(f,{backend:'bullmq',initial_queue_budget_ms:1000});f.clock.advance(1001);
  const limits={scope:f.s,backend:'bullmq' as const};
  await expect(db(t=>leaseNext(t,f.clock,'worker',limits,settled,r.id,true))).rejects.toMatchObject({code:'execution_closure_required'});
  await pool!.query('UPDATE execution_requests SET initial_queue_budget_ms=10000 WHERE id=$1',[r.id]);
  expect(await db(t=>closeUnsentIfRequired(t,f.clock,r.id,limits,async()=>{throw new Error('unexpected settlement')}))).toBe(false);
  expect((await getRequest(pool!,f.s,r.id)).execution_status).toBe('queued');
 });
 it('isolates legacy and BullMQ deliveries and rejects stale generations',async()=>{
  const f=await setup();const r=await add(f,{priority:10,backend:'bullmq',capability:'image.generate'});
  expect((await pool!.query('SELECT * FROM execution_dispatches WHERE request_id=$1',[r.id])).rows).toMatchObject([{generation:0,queue_kind:'image'}]);
  expect(await db(t=>leaseNext(t,f.clock,'legacy',{scope:f.s},settled))).toBeNull();
  expect(await db(t=>leaseNext(t,f.clock,'stale',{scope:f.s,backend:'bullmq',generation:1},settled,r.id))).toBeNull();
  expect((await db(t=>leaseNext(t,f.clock,'current',{scope:f.s,backend:'bullmq',generation:0},settled,r.id))).id).toBe(r.id);
 });
 it('targeted transport delivery never leases a different request and only one competing consumer wins',async()=>{
  const f=await setup();const first=await add(f),target=await add(f);
  const leases=await Promise.all(['consumer-a','consumer-b'].map(worker=>db(t=>leaseNext(t,f.clock,worker,{scope:f.s},settled,target.id))));
  expect(leases.filter(Boolean)).toHaveLength(1);expect(leases.find(Boolean).id).toBe(target.id);
  expect((await getRequest(pool!,f.s,first.id)).execution_status).toBe('queued');
  expect(await db(t=>leaseNext(t,f.clock,'missing',{scope:f.s},settled,'missing-request'))).toBeNull();
  const {s}=await setup();expect(await db(t=>leaseNext(t,f.clock,'wrong-scope',{scope:s},settled,first.id))).toBeNull();
 });

 it('commits intent before dispatch, lease loss becomes unknown, and old fence cannot commit',async()=>{const f=await setup();const r=await add(f);const {lease,attempt}=await dispatch(f);expect(attempt.status).toBe('submitting');f.clock.advance(31000);await db(t=>recoverExpiredLeases(t,f.clock,f.s));expect((await getRequest(pool!,f.s,r.id)).execution_status).toBe('outcome_unknown');expect(await db(t=>leaseNext(t,f.clock,'other',{scope:f.s},settled))).toBeNull();await expect(db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'late',outcome:'success',cost_units:'10',charged_units:'10'},settled))).rejects.toMatchObject({code:'stale_lease'});const exposure=await pool!.query('SELECT * FROM execution_exposures WHERE attempt_id=$1',[attempt.id]);expect(exposure.rows.every(r=>r.state==='open')).toBe(true);});
 it('retains exposure after one hour and prevents late customer debit',async()=>{const f=await setup();const r=await add(f);const {lease,attempt}=await dispatch(f);await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'unknown',outcome:'unknown'},settled));const unresolved=(await getRequest(pool!,f.s,r.id)).unresolved_at;f.clock.advance(3600001);expect(await db(t=>closeUnresolved(t,f.clock,settled,f.s))).toBeGreaterThan(0);const observation=await db(t=>leaseObservation(t,f.s,f.clock,r.id,'lookup'));await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:observation.fencing_token,observation_key:'late-result',outcome:'success',cost_units:'10',charged_units:'10'},async()=>{throw new Error('Late debit forbidden');}));const done=await getRequest(pool!,f.s,r.id);expect(done.settlement_status).toBe('platform_absorbed');expect(done.unresolved_at).toEqual(unresolved);expect((await pool!.query('SELECT charged_units FROM execution_attempts WHERE id=$1',[attempt.id])).rows[0].charged_units).toBe('0');});
 it('prepares independent dispatches while another preparation transaction remains open',async()=>{
  const first=await setup(),second=await setup();await add(first);await add(second);
  const a=await db(t=>leaseNext(t,first.clock,'first',{scope:first.s},settled));
  const b=await db(t=>leaseNext(t,second.clock,'second',{scope:second.s},settled));
  const held=await pool!.connect();
  try{
   await held.query('BEGIN');
   await prepareDispatch(held,first.s,first.clock,a.id,a.fencing_token);
   const locks=(await held.query("SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objid=41827430")).rows;
   expect(locks).toEqual([]);
   const prepare=()=>db(async tx=>{await tx.query("SET LOCAL lock_timeout='1500ms'");return prepareDispatch(tx,second.s,second.clock,b.id,b.fencing_token)});
   const attempt=await prepare();
   expect(attempt.request_id).toBe(b.id);
  }finally{await held.query('ROLLBACK');held.release()}
 });
 it('serializes competing exposure claims without overspending',async()=>{const f=await setup();await db(t=>configureBudget(t,f.s,'provider',f.route.primary.connection_id,'10'));await add(f);await add(f);const leases=await Promise.all([db(t=>leaseNext(t,f.clock,'w1',{scope:f.s},settled)),db(t=>leaseNext(t,f.clock,'w2',{scope:f.s},settled))]);expect(new Set(leases.map(l=>l.id)).size).toBe(2);const results=await Promise.allSettled(leases.map(l=>db(t=>prepareDispatch(t,f.s,f.clock,l.id,l.fencing_token))));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const b=(await pool!.query(`SELECT reserved_units FROM execution_budgets WHERE organization_id=$1 AND kind='provider'`,[f.s.organization_id])).rows[0];expect(b.reserved_units).toBe('10');expect((await pool!.query('SELECT count(*)::int AS n FROM execution_attempts WHERE request_id=ANY($1)',[leases.map(l=>l.id)])).rows[0].n).toBe(1);});

 it('defects stop at four attempts without availability recovery',async()=>{const f=await setup();const r=await add(f);for(let n=0;n<4;n++){const {lease,attempt}=await dispatch(f);const next=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:`defect-${n}`,outcome:'defect',cost_units:'10'},settled));if(n<3)f.clock.advance(new Date(next.not_before).getTime()-f.clock.now().getTime());}expect((await getRequest(pool!,f.s,r.id)).execution_status).toBe('failed');expect((await pool!.query('SELECT id FROM execution_incidents WHERE organization_id=$1',[f.s.organization_id])).rows).toHaveLength(0);});
 it('cancel before intent prevents dispatch and capture',async()=>{const f=await setup();const r=await add(f);const l=await db(t=>leaseNext(t,f.clock,'worker',{scope:f.s},settled));let charge:string|undefined;await db(t=>cancelRequest(t,f.s,f.clock,r.id,async(_t,_s,i)=>{charge=i.charged_units;}));expect(charge).toBe('0');await expect(db(t=>prepareDispatch(t,f.s,f.clock,r.id,l.fencing_token))).rejects.toMatchObject({code:'stale_lease'});expect((await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[r.id])).rows).toHaveLength(0);});
 it('ack validates full manifest, hides content, and removes input while preserving metadata',async()=>{const f=await setup();const r=await add(f);const m=await db(t=>createManifest(t,f.s,f.clock,{request_id:r.id,operation_id:r.operation_id,content:{text:'answer'},ttl_seconds:3600}));await expect(db(t=>acknowledge(t,f.s,f.clock,{request_id:r.id,version:m.version,manifest_hash:'wrong'}))).rejects.toMatchObject({code:'result_version_conflict'});await expect(db(t=>acknowledge(t,f.s,f.clock,{request_id:r.id,version:'different-version',manifest_hash:m.manifest_hash}))).rejects.toMatchObject({code:'result_version_conflict'});const receipt=await db(t=>acknowledge(t,f.s,f.clock,{request_id:r.id,version:m.version,manifest_hash:m.manifest_hash}));expect(await db(t=>acknowledge(t,f.s,f.clock,{request_id:r.id,version:m.version,manifest_hash:m.manifest_hash}))).toEqual(receipt);expect((await getDelivery(pool!,f.s,f.clock,r.id))?.result).toBeNull();await expect(getInput(pool!,f.s,f.clock,r.input_ref)).rejects.toMatchObject({code:'content_unavailable'});});
 it('TTL is enforced before sweeper and project tombstone rejects late results/new requests',async()=>{const f=await setup();const project=id('project');const r=await add(f,{external_project_id:project,project_generation:'1'});await db(t=>createManifest(t,f.s,f.clock,{request_id:r.id,operation_id:r.operation_id,external_project_id:project,project_generation:'1',content:'text',ttl_seconds:10}));f.clock.advance(10000);expect((await getDelivery(pool!,f.s,f.clock,r.id))?.status).toBe('expired');await db(t=>expireContent(t,f.clock,f.s));await db(t=>deleteContent(t,f.s,f.clock,{external_project_id:project,project_generation:'1',reason:'test deletion'}));await expect(add(f,{external_project_id:project,project_generation:'1'})).rejects.toMatchObject({code:'content_deleted'});await expect(db(t=>createManifest(t,f.s,f.clock,{request_id:r.id,operation_id:r.operation_id,external_project_id:project,project_generation:'1',content:'late',ttl_seconds:10}))).rejects.toMatchObject({code:'content_deleted'});expect((await getDelivery(pool!,f.s,f.clock,r.id))?.status).toBe('deleted');});
 it('rejects output assets as input and hides cross-account assets',async()=>{const f=await setup();const a=await db(t=>registerAsset(t,f.s,f.clock,{kind:'output',blob_key:id('blob'),content_hash:'sha256:test',media_type:'image/png',size_bytes:5,expires_at:new Date(f.clock.now().getTime()+10000)}));await expect(getAsset(pool!,f.s,f.clock,a.id,true)).rejects.toMatchObject({code:'invalid_input'});await expect(getAsset(pool!,{...f.s,account_id:id('other')},f.clock,a.id)).rejects.toMatchObject({code:'not_found'});});

 it('keeps platform risk for undeliverable output until hourly financial closure',async()=>{
  const f=await setup();const r=await add(f);const {lease,attempt}=await dispatch(f);
  await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'unavailable',outcome:'success',cost_units:'10',charged_units:'10',result_available:false},settled));
  const rows=(await pool!.query('SELECT kind,state FROM execution_exposures WHERE attempt_id=$1',[attempt.id])).rows;
  expect(rows.find(r=>r.kind==='provider').state).toBe('settled');expect(rows.find(r=>r.kind==='period').state).toBe('open');
  f.clock.advance(3600000);await db(t=>closeUnresolved(t,f.clock,settled,f.s));
  expect((await pool!.query(`SELECT actual_units FROM execution_exposures WHERE attempt_id=$1 AND kind='period'`,[attempt.id])).rows[0].actual_units).toBe('10');
 });
 it('does not finish deletion before a failed blob purge has been retried',async()=>{
  const f=await setup();const r=await add(f);const asset=await db(t=>registerAsset(t,f.s,f.clock,{kind:'output',operation_id:r.operation_id,blob_key:id('blob'),content_hash:'sha256:fixture',media_type:'image/png',size_bytes:5,expires_at:new Date(f.clock.now().getTime()+3600000)}));
  await db(t=>createManifest(t,f.s,f.clock,{request_id:r.id,operation_id:r.operation_id,content:'image',asset_ids:[asset.id],ttl_seconds:3600}));
  const deletion=await db(t=>deleteContent(t,f.s,f.clock,{operation_id:r.operation_id,reason:'test'}));const job=await db(t=>leasePurge(t,f.clock,'purger',f.s));
  await db(t=>completePurge(t,f.clock,job.id,'purger','simulated io failure'));await db(t=>finalizeDeletions(t));
  expect((await pool!.query('SELECT status FROM storage_tombstones WHERE id=$1',[deletion.id])).rows[0].status).toBe('purging');
  const retry=await db(t=>leasePurge(t,f.clock,'purger',f.s));expect(retry.id).toBe(job.id);await db(t=>completePurge(t,f.clock,retry.id,'purger'));await db(t=>finalizeDeletions(t));
  expect((await pool!.query('SELECT status FROM storage_tombstones WHERE id=$1',[deletion.id])).rows[0].status).toBe('completed');
 });

 it('worker commits usage before validating output and keeps prompts out of durable usage/events',async()=>{
  const f=await setup();const r=await add(f);const card:RateCard={id:id('card'),currency:'USD',source:'synthetic test fixture',checked_at:f.clock.now().toISOString(),rates:[{id:'output',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'}]};
  const fake=new FakeAdapter([{outcome:'success',text:'private answer'}]);let observedBeforeReturn=false;let charged:string|undefined;
  const execute=fake.execute.bind(fake);fake.execute=async(input,ctx)=>{const result=await execute(input,ctx);observedBeforeReturn=(await pool!.query('SELECT id FROM provider_usage_observations WHERE attempt_id=$1',[ctx.attempt_id])).rowCount===1;return result;};
  const result=await executeOne(pool!,{blobStore:{put:async()=>{},get:async()=>new Uint8Array(),delete:async()=>{}},context:async()=>({input:{capability:'text.generate',model:'fixture',input:'secret fixture'},accepted_rate_card:card,current_rate_card:card,accepted_at:f.clock.now().toISOString()}),adapter:async()=>fake,settle:async(_t,_s,input)=>{charged=input.charged_units;},limits:{scope:f.s}},f.clock);
  expect('state' in result&&result.state).toBe('succeeded');expect(observedBeforeReturn).toBe(true);expect(charged).toBe('10');
  const durable=JSON.stringify((await pool!.query('SELECT data FROM outbox_events WHERE organization_id=$1',[f.s.organization_id])).rows);
  expect(durable).not.toContain('private answer');expect(durable).not.toContain('secret fixture');
  expect((await getDelivery(pool!,f.s,f.clock,r.id))?.result?.content.text).toBe('private answer');
  expect((await pool!.query('SELECT rounded_units FROM provider_cost_entries WHERE organization_id=$1',[f.s.organization_id])).rows[0].rounded_units).toBe('10');
 });
 it('validates constrained structured results as technical defects',async()=>{
  await expect(validateOutput({content_type:'text/plain',text:'{"count":0}'},{type:'object',required:['count'],properties:{count:{type:'integer',minimum:1}},additionalProperties:false})).rejects.toThrow();
  await expect(validateOutput({content_type:'text/plain',text:'{"count":1}'},{type:'object',required:['count'],properties:{count:{type:'integer',minimum:1}},additionalProperties:false})).resolves.toBeUndefined();
 });

 it('rejects truncated images, malformed SVG, and active content in SVG bytes',async()=>{
  await expect(validateOutput({content_type:'image/png',bytes:Buffer.from([137,80,78,71,13,10,26,10])})).rejects.toThrow();
  await expect(validateOutput({content_type:'image/jpeg',bytes:Buffer.from([255,216,255,217])})).rejects.toThrow();
  await expect(validateOutput({content_type:'image/svg+xml',bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>')})).rejects.toThrow();
  await expect(validateOutput({content_type:'image/svg+xml',bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" onload="alert(1)"></svg>')})).rejects.toThrow();
  await expect(validateOutput({content_type:'image/svg+xml',bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>')})).resolves.toBeUndefined();
 });

 it('local limiter wait consumes no attempt and respects the quota window',async()=>{
  const f=await setup();f.route.primary.limiter_key='shared';f.route.primary.limit_tokens='10';
  await db(t=>configureLimiter(t,f.s,f.clock,{key:'shared',window_ms:60000,request_limit:1,token_limit:'10',concurrency_limit:2}));
  await add(f);const first=await dispatch(f);await db(t=>observeAttempt(t,f.s,f.clock,{request_id:first.lease.id,attempt_id:first.attempt.id,fence:first.lease.fencing_token,observation_key:'done',outcome:'success',cost_units:'10',charged_units:'10'},settled));
  const second=await add(f);const l=await db(t=>leaseNext(t,f.clock,'second',{scope:f.s},settled));expect(await db(t=>prepareDispatch(t,f.s,f.clock,l.id,l.fencing_token))).toBeNull();
  const waiting=await getRequest(pool!,f.s,second.id);expect(waiting.attempt_count).toBe(0);expect(waiting.reason).toBe('waiting_rate_limit');expect(new Date(waiting.not_before).getTime()-f.clock.now().getTime()).toBe(60000);
  f.clock.advance(60000);expect((await dispatch(f)).attempt.number).toBe(1);
 });
 it('does not automatically retry after text was already published',async()=>{
  const f=await setup();f.route.execution=resolveExecutionPolicy(undefined,{retry_after_output:false});const r=await add(f);const {lease,attempt}=await dispatch(f);await pool!.query(`UPDATE execution_requests SET reason='output_started' WHERE id=$1`,[r.id]);
  const done=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:attempt.id,fence:lease.fencing_token,observation_key:'invalid-stream',outcome:'defect',cost_units:'10'},settled));
  expect(done.execution_status).toBe('failed');expect(done.attempt_count).toBe(1);expect(await db(t=>leaseNext(t,f.clock,'no-retry',{scope:f.s},settled))).toBeNull();
 });




 it('post-dispatch cancellation bills only the active confirmed attempt, not an earlier defect',async()=>{
  const f=await setup();const r=await add(f);const first=await dispatch(f);const waiting=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:first.attempt.id,fence:first.lease.fencing_token,observation_key:'defect',outcome:'defect',cost_units:'10'},settled));f.clock.advance(new Date(waiting.not_before).getTime()-f.clock.now().getTime());const second=await dispatch(f);await db(t=>cancelRequest(t,f.s,f.clock,r.id,settled));let charge:string|undefined;
  const done=await db(t=>observeAttempt(t,f.s,f.clock,{request_id:r.id,attempt_id:second.attempt.id,fence:second.lease.fencing_token,observation_key:'cancel-confirmed',outcome:'canceled',cost_units:'7',charged_units:'7'},async(_t,_s,i)=>{charge=i.charged_units;}));expect(done.execution_status).toBe('canceled');expect(charge).toBe('7');expect((await pool!.query(`SELECT spent_units FROM execution_budgets WHERE organization_id=$1 AND kind='request' AND budget_key=$2`,[f.s.organization_id,r.id])).rows[0].spent_units).toBe('10');
 });



});
