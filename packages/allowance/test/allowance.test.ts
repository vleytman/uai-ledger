import {importFirecrawlAllowance} from '../src/firecrawl.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {NotificationService} from '../../notifications/src/index.js';
import {runOperationalMonitors} from '../../runtime-operations/src/index.js';
import {afterAll,describe,expect,it} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {id,ManualClock} from '../../contracts/src/index.js';
import {paidApiSchemas,type TariffTemplate} from '../../contracts/paid-api.js';
import {AllowanceService,validateTariff,allowancePeriod,quantity,decimal} from '../src/index.js';
import {publishConfiguration,activateConfiguration} from '../../configuration/src/index.js';
import {overageUnits} from '../src/quantity.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>pool?.end());
const integration=pool?describe:describe.skip;
const actor={actor_id:'fixture',reason:'Synthetic allowance testing'};
function tariff():TariffTemplate{return {key:'synthetic',provider:'fake',calendar:{kind:'calendar_month',timezone:'UTC',anchor:'2026-01-01T00:00:00Z'},counters:[{key:'requests',unit:'requests',included:'10',rollover:{enabled:false,cap:'0',expires_after_periods:1}},{key:'pages',unit:'pages',included:'20',rollover:{enabled:false,cap:'0',expires_after_periods:1}}],overage:{enabled:false,max_units:'0'},cost_allocation:{mode:'incremental'}};}
const demands=(requests:string,pages='0')=>[{metric:'requests',quantity:requests},{metric:'pages',quantity:pages}];
async function fixture(change?:(t:TariffTemplate)=>void){
 const scope={organization_id:id('org'),application_id:id('app')},clock=new ManualClock(new Date('2026-01-15T12:00:00Z')),definition=tariff();change?.(definition);validateTariff(definition);
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Allowance fixture']);
 const run=<T>(fn:(service:AllowanceService)=>Promise<T>)=>transaction(pool!,tx=>fn(new AllowanceService(tx,clock)));
 const account=await run(s=>s.createAccount(scope,{provider:'fake',name:'Test',external_reference:id('external'),reason:actor.reason},actor));
 const published=await transaction(pool!,tx=>publishConfiguration(tx,scope,{schema_version:1,bundle_key:'fixture-tariff',resources:[{kind:'tariff',key:definition.key,payload:definition}]},{connections:{},budgets:{}},{path:'configurations/fixtures/tariff.json',git_revision:'a'.repeat(40),git_dirty:true,content_hash:'b'.repeat(64),publisher:actor.actor_id},clock));
 await transaction(pool!,tx=>activateConfiguration(tx,scope,published.id,0,actor.actor_id));
 const tariffId=published.resources[0].id;
 const sub=await run(s=>s.createSubscription(scope,{provider_account_id:account.id,tariff_version_id:tariffId,starts_at:'2026-01-01T00:00:00Z',installation_share:Object.fromEntries(definition.counters.map(c=>[c.key,c.included])),reason:actor.reason},actor));
 const state=()=>run(s=>s.state(scope,sub.id)),reserve=(identity:string,items=demands('1'))=>run(s=>s.reserve(scope,sub.id,identity,items));
 const send=(reservation:any)=>run(s=>s.markSent(scope,reservation.id));
 const settle=(reservation:any,items=demands('1'),revision=1)=>run(s=>s.observe(scope,reservation.id,{identity:`usage-${revision}`,revision,attempt_id:'attempt-fixture',state:'known',items,source:'provider'}));
 return {scope,clock,definition,account,sub,run,state,reserve,send,settle};
}
it('uses exact decimals and rounds provider overage once upward',()=>{
 expect(decimal(quantity('12345678901234567890.000000001'))).toBe('12345678901234567890.000000001');
 expect(overageUnits(quantity('0.000000001'),'0.000000001')).toBe(1n);
 for(const value of ['-1','NaN','1e3','01','0.0000000001'])expect(()=>quantity(value)).toThrow();
 expect(paidApiSchemas.ServiceOperation.shape.adapter_ref.parse('firecrawl@1')).toBe('firecrawl@1');
 const invalid=tariff();invalid.counters.push(invalid.counters[0]);expect(()=>validateTariff(invalid)).toThrow('duplicate_allowance_metric');
});
it('keeps anniversary anchor days and resolves timezone DST gaps and repeated times',()=>{
 const calendar={kind:'anniversary_month' as const,timezone:'UTC',anchor:'2024-01-31T10:00:00Z'};
 expect(allowancePeriod(calendar,new Date('2024-02-29T11:00:00Z')).start.toISOString()).toBe('2024-02-29T10:00:00.000Z');
 expect(allowancePeriod(calendar,new Date('2024-02-29T11:00:00Z')).end.toISOString()).toBe('2024-03-31T10:00:00.000Z');
 const spring={kind:'anniversary_month' as const,timezone:'America/New_York',anchor:'2026-02-08T07:30:00Z'};
 expect(allowancePeriod(spring,new Date('2026-03-09T00:00:00Z')).start.toISOString()).toBe('2026-03-08T07:30:00.000Z');
 const autumn={kind:'anniversary_month' as const,timezone:'America/New_York',anchor:'2026-10-01T05:30:00Z'};
 expect(allowancePeriod(autumn,new Date('2026-11-02T00:00:00Z')).start.toISOString()).toBe('2026-11-01T05:30:00.000Z');
 expect(()=>allowancePeriod({...calendar,timezone:'Invalid/zone'},new Date())).toThrow();
});
integration('Provider allowance ledger',()=>{
 it('imports credit-usage only for the bound period and requires audited snapshot replacement to raise its ceiling',async()=>{
  const f=await fixture(t=>{t.counters=[{...t.counters[0],key:'credits',unit:'credits',included:'100'}]});
  const connection=await transaction(pool!,tx=>new ConnectionService(tx,f.clock).create(f.scope,{provider:'fake',name:'Snapshot fixture',account_scope:{fixture:'snapshot'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:true,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:0},limits:{},risk_policy:{}},actor));
  await f.run(service=>service.bindConnection(f.scope,connection.id,{provider_account_id:f.account.id,subscription_id:f.sub.id,reason:actor.reason},0,actor));
  const state=await f.state(),snapshot={remaining:'4',included:'100',period_start:state.period_start,period_end:state.period_end,covered_through:null,precision:'estimated' as const,scope:'provider_account' as const};
  await expect(transaction(pool!,tx=>importFirecrawlAllowance(tx,f.scope,f.clock,connection.id,{...snapshot,period_end:'2026-03-01T00:00:00Z'},'wrong-period',actor))).rejects.toMatchObject({code:'allowance_period_mismatch'});
  const imported=await transaction(pool!,tx=>importFirecrawlAllowance(tx,f.scope,f.clock,connection.id,snapshot,'read',actor));expect((await f.state()).metrics[0].available).toBe('4');
  const correction={identity:'correction',provider_account_id:f.account.id,period_id:state.period_id,metric:'credits',remaining:'90',observed_at:f.clock.now().toISOString(),covered_through:null,precision:'estimated',scope:'provider_account',reason:'Evidence-backed correction',supersedes:[imported.id]};
  await f.run(service=>service.snapshot(f.scope,f.sub.id,correction,actor));expect((await f.state()).metrics[0].available).toBe('90');
  expect((await f.state()).freshness).toBe('unknown');
 });
 it('serializes the final allowance and rolls back all metrics on refusal',async()=>{
  const f=await fixture();const results=await Promise.allSettled([f.reserve('a',demands('6','7')),f.reserve('b',demands('6','7'))]);
  expect(results.filter(v=>v.status==='fulfilled')).toHaveLength(1);
  expect(results.find(v=>v.status==='rejected')).toMatchObject({reason:{code:'allowance_exhausted'}});
  await expect(f.reserve('no-pages',demands('1','21'))).rejects.toMatchObject({code:'allowance_exhausted'});
  const state=await f.state();expect(state.metrics).toMatchObject([{available:'4',reserved:'6'},{available:'13',reserved:'7'}]);
  expect(paidApiSchemas.AllowanceState.safeParse(state).success).toBe(true);
 });
 it('replays accepted identities after exhaustion but rejects changed content',async()=>{
  const f=await fixture(),r=await f.reserve('same',demands('10'));expect((await f.reserve('same',demands('10'))).id).toBe(r.id);
  await expect(f.reserve('same',demands('9'))).rejects.toMatchObject({code:'idempotency_conflict'});
  await expect(f.reserve('new')).rejects.toMatchObject({code:'allowance_exhausted'});
  await f.run(s=>s.release(f.scope,r.id,'never sent'));expect((await f.state()).metrics[0].available).toBe('10');
 });
 it('retains uncertain consumption beyond the monetary dispute window and settles exactly once',async()=>{
  const f=await fixture(),r=await f.reserve('uncertain',demands('8'));await f.send(r);
  const observation={identity:'unknown',revision:1,attempt_id:'a',state:'unknown',items:[],source:'adapter'};
  await f.run(s=>s.observe(f.scope,r.id,observation));f.clock.advance(3600001);
  await expect(f.run(s=>s.release(f.scope,r.id,'money dispute expired'))).rejects.toMatchObject({code:'allowance_outcome_evidence_required'});
  expect((await f.state()).metrics[0]).toMatchObject({reserved:'8',available:'2'});
  await f.settle(r,demands('5'),2);await f.settle(r,demands('5'),2);
  expect((await f.state()).metrics[0]).toMatchObject({reserved:'0',consumed:'5',available:'5'});
  await f.settle(r,demands('4'),3);expect((await f.state()).metrics[0].consumed).toBe('4');
  await expect(f.settle(r,demands('3'),3)).rejects.toMatchObject({code:'idempotency_conflict'});
  await expect(pool!.query('UPDATE allowance_ledger SET kind=$1 WHERE reservation_id=$2',['tamper',r.id])).rejects.toThrow('immutable');
 });
 it('records actual excess without inventing customer debt and blocks further admission',async()=>{
  const f=await fixture(),r=await f.reserve('overdraw',demands('10'));await f.send(r);await f.settle(r,demands('12'));
  expect((await f.state()).metrics[0]).toMatchObject({available:'0',consumed:'12',overdrawn:'2'});
  f.clock.advance(32*86400000);await expect(f.reserve('next-month')).rejects.toMatchObject({code:'allowance_exhausted'});
  // A provider correction resolves the old deficit; current period remains independently funded.
  await f.settle(r,demands('10'),2);expect((await f.reserve('corrected')).state).toBe('reserved');
 });
 it('moves an unsent hold to the new period and keeps sent usage in its original period',async()=>{
  const f=await fixture(),unsent=await f.reserve('waiting',demands('4')),sent=await f.reserve('sent',demands('5'));await f.send(sent);
  f.clock.advance(20*86400000);const current=await f.state();const moved=await f.send(unsent);
  expect(moved.period_id).toBe(current.period_id);expect(moved.period_id).not.toBe(sent.period_id);
  await f.settle(sent,demands('5'));expect((await f.state()).metrics[0]).toMatchObject({reserved:'4',consumed:'0',available:'6'});
  const periods=await pool!.query('SELECT id FROM allowance_periods WHERE subscription_id=$1',[f.sub.id]);expect(periods.rowCount).toBe(2);
 });
 it('keeps rollover provenance, cap and original expiry across skipped months',async()=>{
  const f=await fixture(t=>{t.counters[0].rollover={enabled:true,cap:'6',expires_after_periods:1};});
  await f.state();f.clock.advance(20*86400000);expect((await f.state()).metrics[0]).toMatchObject({included:'10',rollover:'6',available:'16'});
  const feb=await f.state();f.clock.advance(28*86400000);expect((await f.state()).metrics[0]).toMatchObject({rollover:'6',available:'16'});
  const rows=(await pool!.query("SELECT g.* FROM allowance_grants g JOIN allowance_periods p ON p.id=g.period_id WHERE p.subscription_id=$1 AND g.kind='rollover' ORDER BY p.month_index",[f.sub.id])).rows;
  expect(rows).toHaveLength(2);expect(rows[0].origin_id).not.toBe(rows[1].origin_id);
  expect(new Date(rows[0].expires_at).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  expect((await f.state()).period_id).not.toBe(feb.period_id);
 });
 it('reserves overage budget under concurrency and records actual incremental cost',async()=>{
  const f=await fixture(t=>{t.counters.forEach(c=>{c.included='0';c.overage_usd_per_unit='0.01'});t.overage={enabled:true,max_units:'100000000'};});
  const result=await Promise.allSettled([f.reserve('a',demands('6')),f.reserve('b',demands('6'))]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const hold=(result.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;await f.send(hold);await f.settle(hold,demands('4'));
  expect((await f.state()).overage).toEqual({limit_units:'100000000',spent_units:'40000000',reserved_units:'0'});
  await f.reserve('next',demands('6'));await expect(f.reserve('too-much')).rejects.toMatchObject({code:'overage_budget_exhausted'});
 });
 it('treats snapshots as conservative ceilings and subtracts usage after coverage',async()=>{
  const f=await fixture(),state=await f.state(),r=await f.reserve('first',demands('2'));await f.send(r);await f.settle(r,demands('2'));
  const snapshot={identity:'confirmed',provider_account_id:f.account.id,period_id:state.period_id,metric:'requests',remaining:'8',observed_at:f.clock.now().toISOString(),covered_through:f.clock.now().toISOString(),precision:'confirmed',scope:'provider_account',reason:'Fixture'};
  await f.run(s=>s.snapshot(f.scope,f.sub.id,snapshot,actor));expect((await f.state()).metrics[0].available).toBe('8');
  f.clock.advance(1000);const next=await f.reserve('second',demands('3'));await f.send(next);await f.settle(next,demands('3'));expect((await f.state()).metrics[0].available).toBe('5');
  await f.run(s=>s.snapshot(f.scope,f.sub.id,{...snapshot,identity:'stale',remaining:'10',precision:'estimated'},actor));expect((await f.state()).metrics[0].available).toBe('5');
  await expect(f.reserve('too-much',demands('6'))).rejects.toMatchObject({code:'allowance_exhausted'});
 });
 it('does not accept an incomplete measurement as zero for another counter',async()=>{
  const f=await fixture(),r=await f.reserve('multi',demands('1','4'));await f.send(r);
  await expect(f.settle(r,[{metric:'requests',quantity:'1'}])).rejects.toMatchObject({code:'incomplete_allowance_usage'});
  expect((await f.state()).metrics[1]).toMatchObject({reserved:'4',consumed:'0'});
 });
 it('isolates scope and prevents duplicate subscriptions for one provider account',async()=>{
  const f=await fixture();await expect(f.run(s=>s.state({...f.scope,organization_id:'foreign'},f.sub.id))).rejects.toMatchObject({code:'not_found'});
  await expect(f.run(s=>s.createSubscription(f.scope,{provider_account_id:f.account.id,tariff_version_id:f.sub.tariff_version_id,starts_at:'2026-01-01T00:00:00Z',installation_share:{requests:'10',pages:'20'},reason:'Duplicate'},actor))).rejects.toMatchObject({code:'provider_subscription_exists'});
 });
});

integration('Allowance notifications',()=>{
 it('filters resources and metrics, emits percent thresholds once, recovers and renews once',async()=>{
  const f=await fixture(),other=await fixture();
  const rule=await transaction(pool!,tx=>new NotificationService(tx,f.clock).saveRule(f.scope,{signal:'allowance.low',severity:'warning',threshold:'30',minimum_samples:1,recipients:[],cooldown_seconds:60,enabled:true,allowance:{subscription_id:f.sub.id,metric:'requests',unit:'percent'}},actor));
  await transaction(pool!,tx=>new NotificationService(tx,f.clock).saveRule(f.scope,{signal:'allowance.renewed',severity:'info',minimum_samples:1,recipients:[],cooldown_seconds:0,enabled:true,allowance:{subscription_id:f.sub.id,unit:'native'}},actor));
  const monitor=()=>runOperationalMonitors(pool!,f.clock,{scope:f.scope,interval_ms:0});
  await monitor();expect((await pool!.query('SELECT id FROM notification_incidents WHERE rule_id=$1',[rule.id])).rowCount).toBe(0);
  const hold=await f.reserve('low',demands('8'));await monitor();f.clock.advance(120000);await monitor();
  const events=()=>pool!.query('SELECT type,data FROM outbox_events WHERE organization_id=$1 AND type IN ($2,$3,$4) ORDER BY sequence',[f.scope.organization_id,'incident.opened','incident.recovered','allowance.renewed']);
  expect((await events()).rows).toHaveLength(1);expect((await events()).rows[0].data).toMatchObject({threshold_unit:'percent',allowance:{subscription_id:f.sub.id,metric:{metric:'requests',remaining_percent:'20'}}});
  await f.run(s=>s.release(f.scope,hold.id,'Not dispatched'));await monitor();expect((await events()).rows.map(r=>r.type)).toEqual(['incident.opened','incident.recovered']);
  f.clock.advance(32*86400000);await monitor();await monitor();expect((await events()).rows.filter(r=>r.type==='allowance.renewed')).toHaveLength(1);
  expect((await pool!.query('SELECT id FROM notification_incidents WHERE organization_id=$1',[other.scope.organization_id])).rowCount).toBe(0);
 });
 it('caps allocated package cost and keeps incremental overage separate',async()=>{
  const f=await fixture(t=>{t.cost_allocation={mode:'allocated',subscription_fee_units:'10000000',allocation_rates:{requests:'0.01'}};});
  const first=await f.reserve('one');await f.send(first);await f.settle(first);
  const second=await f.reserve('two');await f.send(second);await f.settle(second);
  const rows=(await pool!.query('SELECT allocated_cost_units,overage_spent_units FROM allowance_reservations WHERE subscription_id=$1 ORDER BY identity',[f.sub.id])).rows;
  expect(rows).toEqual([{allocated_cost_units:'10000000',overage_spent_units:'0'},{allocated_cost_units:'0',overage_spent_units:'0'}]);
 });
});
