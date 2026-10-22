import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {id,ManualClock,type Scope} from '../../contracts/src/index.js';
import {ConnectionService,ReconciliationService} from '../../reconciliation/src/index.js';
import {NotificationService} from '../../notifications/src/index.js';
import {configureBudget,configureLimiter,enqueue,leaseNext,prepareDispatch,observeAttempt,UNKNOWN_SLOT_GRACE_MS} from '../../execution/src/index.js';
import {collectObservations,runOperationalMonitors} from '../src/index.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end();});
const db=<T>(fn:Parameters<typeof transaction<T>>[1])=>transaction(pool!,fn);
async function setup(){const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};const clock=new ManualClock(new Date('2026-09-18T12:00:00Z'));const connection=await db(t=>new ConnectionService(t,clock).create(scope,{provider:'fake',name:'monitored fixture',account_scope:{project:'fixture'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'test',reason:'Local monitor fixture'}));return {scope,clock,connection};}
describe.skipIf(!pool)('Operational monitors on PostgreSQL',()=>{
 it('serializes scheduler passes, opens low internal budget, and resolves once after refill',async()=>{
  const f=await setup();await db(async t=>{await configureBudget(t,f.scope,'provider',f.connection.id,'10');await new NotificationService(t,f.clock).saveRule(f.scope,{signal:'provider.budget_low',severity:'warning',threshold:'20',minimum_samples:1,recipients:[],cooldown_seconds:3600,enabled:true},{actor_id:'test',reason:'Synthetic budget threshold'});});
  const result=await Promise.all([runOperationalMonitors(pool!,f.clock,{scope:f.scope}),runOperationalMonitors(pool!,f.clock,{scope:f.scope})]);expect(result.filter(r=>r.observations>0)).toHaveLength(1);
  const service=new NotificationService(pool!,f.clock);expect((await service.listIncidents(f.scope))).toHaveLength(1);expect((await service.listDeliveries(f.scope))[0].status).toBe('delivery_not_configured');
  expect(result.flatMap(r=>r.values).find(v=>v.signal==='provider.budget_low')?.source).toBe('installation_budget');
  await db(t=>configureBudget(t,f.scope,'provider',f.connection.id,'100'));f.clock.advance(60000);await runOperationalMonitors(pool!,f.clock,{scope:f.scope});expect((await service.listIncidents(f.scope))[0].state).toBe('resolved');f.clock.advance(60000);await runOperationalMonitors(pool!,f.clock,{scope:f.scope});
  expect((await pool!.query(`SELECT id FROM outbox_events WHERE organization_id=$1 AND type='incident.recovered'`,[f.scope.organization_id])).rows).toHaveLength(1);
 });
 it('counts queue age and resolves an empty queue despite its minimum sample threshold',async()=>{
  const f=await setup();await db(async t=>{await new NotificationService(t,f.clock).saveRule(f.scope,{signal:'queue.delay_high',severity:'warning',threshold:'30',minimum_samples:2,recipients:[],cooldown_seconds:3600,enabled:true},{actor_id:'test',reason:'Queue monitor'});for(let i=0;i<2;i++)await enqueue(t,f.scope,f.clock,{operation_id:id('op'),component:'test',client_request_key:id('key'),input_hash:'h',input_ref:id('input'),max_units:'10',deadline_at:new Date(f.clock.now().getTime()+3600000),route:{primary:{connection_id:f.connection.id,endpoint_scope:'fixture',model:'fake',max_cost_units:'10'},period_budget_key:'test',request_risk_limit_units:'100',incident_risk_limit_units:'100'}});});f.clock.advance(120000);
  const first=await runOperationalMonitors(pool!,f.clock,{scope:f.scope});expect(first.values.find(v=>v.signal==='queue.delay_high')?.observed_value).toBe('120');expect((await new NotificationService(pool!,f.clock).listIncidents(f.scope))[0].state).toBe('open');
  await pool!.query(`UPDATE execution_requests SET execution_status='canceled' WHERE organization_id=$1`,[f.scope.organization_id]);f.clock.advance(60000);await runOperationalMonitors(pool!,f.clock,{scope:f.scope});expect((await new NotificationService(pool!,f.clock).listIncidents(f.scope))[0].state).toBe('resolved');
 });
 it('alerts while unknown outcomes hold limiter slots and recovers once the slots are released',async()=>{
  const f=await setup(),limiter=id('limiter'),settle=async()=>{};
  const route={primary:{connection_id:f.connection.id,endpoint_scope:id('endpoint'),model:'fake',max_cost_units:'10',limiter_key:limiter},period_budget_key:id('period'),request_risk_limit_units:'100',incident_risk_limit_units:'100'};
  const request=await db(async t=>{
   await configureBudget(t,f.scope,'provider',f.connection.id,'1000');await configureBudget(t,f.scope,'period',route.period_budget_key,'1000');
   await configureLimiter(t,f.scope,f.clock,{key:limiter,window_ms:1000,request_limit:10,token_limit:'0',concurrency_limit:4});
   await new NotificationService(t,f.clock).saveRule(f.scope,{signal:'limiter.unknown_slots_held',severity:'critical',threshold:'0',minimum_samples:1,recipients:[],cooldown_seconds:3600,enabled:true},{actor_id:'test',reason:'Unknown outcomes hold limiter slots'});
   return enqueue(t,f.scope,f.clock,{priority:10,operation_id:id('op'),component:'test',client_request_key:id('key'),input_hash:'h',input_ref:id('input'),max_units:'10',deadline_at:new Date(f.clock.now().getTime()+600000),route});
  });
  const lease=await db(t=>leaseNext(t,f.clock,'w',{scope:f.scope},settle,request.id));const attempt=await db(t=>prepareDispatch(t,f.scope,f.clock,lease.id,lease.fencing_token));
  await db(t=>observeAttempt(t,f.scope,f.clock,{request_id:request.id,attempt_id:attempt!.id,fence:lease.fencing_token,observation_key:'lost',outcome:'unknown'},settle));
  const first=await runOperationalMonitors(pool!,f.clock,{scope:f.scope});
  expect(first.values.find(v=>v.signal==='limiter.unknown_slots_held')).toMatchObject({resource_id:limiter,observed_value:'1',active:true,details:{concurrency_limit:4,held_slots:1}});
  const service=new NotificationService(pool!,f.clock);
  expect(await service.listIncidents(f.scope)).toEqual([expect.objectContaining({signal:'limiter.unknown_slots_held',resource_id:limiter,state:'open',observed_value:'1'})]);
  f.clock.advance(600000+UNKNOWN_SLOT_GRACE_MS);await runOperationalMonitors(pool!,f.clock,{scope:f.scope});
  expect((await service.listIncidents(f.scope))[0].state).toBe('resolved');
 });
 it('tracks stored report freshness and resolves a reconciled discrepancy with a later report',async()=>{
  const f=await setup();const start='2026-09-17T00:00:00Z',end='2026-09-18T00:00:00Z';
  await db(async t=>{const notifications=new NotificationService(t,f.clock);for(const signal of ['provider.balance_stale','reconciliation.discrepancy'] as const)await notifications.saveRule(f.scope,{signal,severity:'warning',threshold:signal==='provider.balance_stale'?'60':'5',minimum_samples:1,recipients:[],cooldown_seconds:3600,enabled:true},{actor_id:'test',reason:'Report monitor'});const service=new ReconciliationService(t,f.clock);await service.addSnapshot(f.scope,{connection_id:f.connection.id,account_scope:{project:'fixture'},source:'manual',metric:'spending_cap',native_unit:'USD',remaining:'10',fetched_at:new Date(f.clock.now().getTime()-120000).toISOString(),precision:'estimated',stale_after_seconds:60},{actor_id:'test',reason:'Manual fixture snapshot'});await service.appendAdjustment(f.scope,{identity:'fixturecost',connection_id:f.connection.id,model:'fake',delta_units:'10',provider_completed_at:'2026-09-17T12:00:00Z',reason:'Synthetic report fixture'},{actor_id:'test',reason:'Synthetic report fixture'});await service.reconcile(f.scope,{identity:'first',connection_id:f.connection.id,account_scope:{project:'fixture'},period_start:start,period_end:end,timezone:'UTC',native_unit:'USD',provider_units:'30',all_pages_loaded:true,time_semantics:'provider_completed_at'},{actor_id:'test',reason:'Fixture reported total'});});
  await runOperationalMonitors(pool!,f.clock,{scope:f.scope});const service=new NotificationService(pool!,f.clock);expect((await service.listIncidents(f.scope)).filter(i=>i.state==='open')).toHaveLength(2);
  f.clock.advance(60000);await db(async t=>{const r=new ReconciliationService(t,f.clock);await r.addSnapshot(f.scope,{connection_id:f.connection.id,account_scope:{project:'fixture'},source:'manual',metric:'spending_cap',native_unit:'USD',remaining:'10',fetched_at:f.clock.now().toISOString(),precision:'estimated',stale_after_seconds:60},{actor_id:'test',reason:'Fresh fixture'});await r.reconcile(f.scope,{identity:'second',connection_id:f.connection.id,account_scope:{project:'fixture'},period_start:start,period_end:end,timezone:'UTC',native_unit:'USD',provider_units:'10',all_pages_loaded:true,time_semantics:'provider_completed_at'},{actor_id:'test',reason:'Corrected fixture total'});});await runOperationalMonitors(pool!,f.clock,{scope:f.scope});expect((await service.listIncidents(f.scope)).every(i=>i.state==='resolved')).toBe(true);
 });
 it('uses matching dimensions and excludes content defects from provider availability ratios',async()=>{
  const f=await setup();const rows=await db(t=>collectObservations(t,f.clock,f.scope));const availability=rows.find(r=>r.signal==='provider.degraded');expect(availability).toMatchObject({observed_value:'0',samples:0,active:false,source:'attempt_outcomes'});expect(rows.some(r=>r.signal==='provider.budget_low')).toBe(false);
 });
});
