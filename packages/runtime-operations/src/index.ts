import {collectAllowanceObservations} from './allowance.js';
import type pg from 'pg';
import {systemClock,type Clock} from '../../contracts/src/index.js';
import {transaction,type Tx} from '../../db/src/index.js';
import {NotificationService,type signals} from '../../notifications/src/index.js';
import {adjustedRemaining} from '../../reconciliation/src/index.js';
import {limiterSlotUsage} from '../../execution/src/limiter-slots.js';
type Signal=(typeof signals)[number];
type Scope={organization_id:string;application_id:string};
export interface MonitorObservation {details?:Record<string,unknown>;metric?:string;rule_ids?:string[];scope:Scope;signal:Signal;resource_id:string;failure_scope:string;observed_value?:string;samples:number;active:boolean;source:string}
export interface MonitorOptions {interval_ms?:number;error_window_ms?:number;scope?:Scope}
const age=(clock:Clock,date:Date|string)=>Math.max(0,Math.floor((clock.now().getTime()-new Date(date).getTime())/1000));
const abs=(n:bigint)=>n<0n?-n:n;
/** Reads local accounting/reporting evidence only. No provider report or health endpoint is called. */
export async function collectObservations(tx:Tx,clock:Clock,scope:Scope,options:MonitorOptions={}):Promise<MonitorObservation[]>{
 const result:MonitorObservation[]=[];const add=(signal:Signal,resource:string,failureScope:string,value:string|undefined,samples:number,active:boolean,source:string)=>result.push({scope,signal,resource_id:resource,failure_scope:failureScope,observed_value:value,samples,active,source});
 const v=[scope.organization_id,scope.application_id];
 const connections=(await tx.query('SELECT * FROM provider_connections WHERE organization_id=$1 AND application_id=$2',v)).rows;
 for(const connection of connections){
  const budget=(await tx.query(`SELECT * FROM execution_budgets WHERE organization_id=$1 AND kind='provider' AND budget_key=$2`,[scope.organization_id,connection.id])).rows[0];
  if(budget){const remaining=BigInt(budget.limit_units)-BigInt(budget.reserved_units)-BigInt(budget.spent_units);add('provider.budget_low',connection.id,'installation_budget',(remaining>0n?remaining:0n).toString(),1,true,'installation_budget');add('provider.budget_exhausted',connection.id,'installation_budget',undefined,1,remaining<=0n,'installation_budget');}
  add('provider.auth_failed',connection.id,'credential_state',undefined,1,connection.credential_status==='invalid','connection_state');
  const snapshots=(await tx.query('SELECT DISTINCT ON(metric) * FROM provider_snapshots WHERE organization_id=$1 AND application_id=$2 AND connection_id=$3 ORDER BY metric,fetched_at DESC,id',[...v,connection.id])).rows;
  if(!snapshots.length&&connection.capabilities.balance_reporting)add('provider.balance_stale',connection.id,'balance_report',String(age(clock,connection.created_at)),1,true,'missing_provider_report');
  for(const snapshot of snapshots){
   add('provider.balance_stale',connection.id,`snapshot:${snapshot.metric}`,String(age(clock,snapshot.fetched_at)),1,age(clock,snapshot.fetched_at)>snapshot.stale_after_seconds,'stored_snapshot');
   if(snapshot.native_unit==='USD'&&snapshot.remaining!==null&&snapshot.precision!=='unknown'&&age(clock,snapshot.fetched_at)<=snapshot.stale_after_seconds){
    const costs=(await tx.query(`SELECT rounded_units AS units,provider_completed_at AS completed_at FROM provider_cost_entries WHERE organization_id=$1 AND application_id=$2 AND connection_id=$3 AND rounded_units>0 AND provider_completed_at IS NOT NULL`,[...v,connection.id])).rows.map(r=>({units:r.units,completed_at:new Date(r.completed_at).toISOString()}));
    const adjusted=adjustedRemaining(snapshot,costs,budget?.reserved_units??'0',connection.risk_policy.snapshot_safety_margin_units??'0');
    if(adjusted.remaining_units!==null)add('provider.budget_low',connection.id,`snapshot:${snapshot.metric}`,adjusted.remaining_units,1,true,`snapshot_${snapshot.source}_${adjusted.precision}`);
   }
  }
  const counts=(await tx.query(`SELECT count(*)::int AS samples,count(*) FILTER(WHERE a.status IN ('transient','outcome_unknown','auth','quota'))::int AS errors FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id WHERE r.organization_id=$1 AND r.application_id=$2 AND a.variant->>'connection_id'=$3 AND a.created_at>=$4 AND a.status IN ('succeeded','transient','outcome_unknown','auth','quota')`,[...v,connection.id,new Date(clock.now().getTime()-(options.error_window_ms??300000))])).rows[0];
  const percent=counts.samples?String(Math.floor(counts.errors*10000/counts.samples)/100):'0';add('provider.degraded',connection.id,'availability_5m',percent,counts.samples,counts.errors>0,'attempt_outcomes');
 }
 const queued=(await tx.query(`SELECT count(*)::int AS count,min(enqueued_at) AS oldest FROM execution_requests WHERE organization_id=$1 AND application_id=$2 AND execution_status IN ('queued','waiting_retry','waiting_recovery')`,v)).rows[0];
 add('queue.delay_high',scope.application_id,'queue',queued.oldest?String(age(clock,queued.oldest)):'0',queued.count,queued.count>0,'durable_queue');
 // Unknown outcomes keep limiter slots while a result can still land; a full limiter starves every new request.
 for(const l of await limiterSlotUsage(tx,scope,clock.now()))result.push({scope,signal:'limiter.unknown_slots_held',resource_id:l.limiter_key,failure_scope:'limiter_concurrency',observed_value:String(l.unknown_held_slots),samples:1,active:l.unknown_held_slots>0,source:'limiter_slots',details:{concurrency_limit:l.concurrency_limit,held_slots:l.held_slots,oldest_unknown_held_seconds:l.oldest_unknown_held_seconds}});
 const exposure=(await tx.query(`SELECT e.budget_key,sum(CASE WHEN e.state='open' THEN e.reserved_units ELSE COALESCE(e.actual_units,0) END)::text AS total,count(*)::int AS count FROM execution_exposures e JOIN execution_attempts a ON a.id=e.attempt_id JOIN execution_requests r ON r.id=a.request_id WHERE r.organization_id=$1 AND r.application_id=$2 AND e.kind='period' GROUP BY e.budget_key`,v)).rows;
 for(const e of exposure)add('platform.exposure_high',`period:${e.budget_key}`,'platform_period',e.total,e.count,BigInt(e.total)>0n,'platform_exposure_and_funded_cost');
 const cards=(await tx.query(`SELECT DISTINCT ON(key) * FROM configuration_versions WHERE organization_id=$1 AND application_id=$2 AND kind='rate_card' AND status='published' ORDER BY key,version DESC`,v)).rows;
 if(!cards.length)add('pricing.missing_or_stale',scope.application_id,'rate_cards',undefined,1,true,'missing_rate_card');
 else{add('pricing.missing_or_stale',scope.application_id,'rate_cards',undefined,1,false,'published_rate_cards');for(const c of cards)add('pricing.missing_or_stale',`rate:${c.key}`,'rate_card_age',String(age(clock,c.payload.checked_at??c.published_at)),1,true,'published_rate_card');}
 const runs=(await tx.query('SELECT DISTINCT ON(connection_id,period_start,period_end,native_unit) * FROM reconciliation_runs WHERE organization_id=$1 AND application_id=$2 ORDER BY connection_id,period_start,period_end,native_unit,created_at DESC,id',v)).rows;
 for(const r of runs){const period=`${new Date(r.period_start).toISOString()}:${new Date(r.period_end).toISOString()}:${r.native_unit}`;add('reconciliation.discrepancy',r.connection_id,period,r.difference_units===null?undefined:abs(BigInt(r.difference_units)).toString(),1,r.status==='discrepancy','reconciliation_run');}
 return result;
}
/** Each scope cursor and resulting incidents commit together; overlapping schedulers do not duplicate observations. */
export async function runOperationalMonitors(pool:pg.Pool,clock:Clock=systemClock,options:MonitorOptions={}){
 return transaction(pool,async tx=>{
  const scopes=(await tx.query(`SELECT DISTINCT organization_id,application_id FROM notification_rules WHERE enabled AND ($1::text IS NULL OR (organization_id=$1 AND application_id=$2)) ORDER BY organization_id,application_id`,[options.scope?.organization_id??null,options.scope?.application_id??null])).rows;
  const all:MonitorObservation[]=[];
  for(const scope of scopes){
   const key=`numeric:${scope.organization_id}:${scope.application_id}`;await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
   const previous=(await tx.query('SELECT last_completed_at FROM runtime_monitor_runs WHERE monitor_key=$1',[key])).rows[0];if(previous&&clock.now().getTime()-new Date(previous.last_completed_at).getTime()<(options.interval_ms??60000))continue;
   const service=new NotificationService(tx,clock);const rules=await service.listRules(scope);const observations=[...await collectObservations(tx,clock,scope,options),...await collectAllowanceObservations(tx,clock,scope)];
   for(const o of observations){const enabled=rules.filter(r=>r.enabled&&r.signal===o.signal&&(!o.rule_ids||o.rule_ids.includes(r.id)));if(!enabled.length)continue;
    // Numeric policy without a threshold makes no actionable comparison. Missing data and hard states use undefined value.
    if(o.observed_value!==undefined&&enabled.every(r=>r.threshold===null)&&!o.rule_ids)continue;
    const ruleIds=enabled.filter(r=>!!o.rule_ids||o.observed_value===undefined||r.threshold!==null).map(r=>r.id);await service.observe(scope,{...o,rule_ids:ruleIds});all.push(o);
   }
   await tx.query('INSERT INTO runtime_monitor_runs(monitor_key,last_completed_at,observations) VALUES($1,$2,$3) ON CONFLICT(monitor_key) DO UPDATE SET last_completed_at=$2,observations=$3',[key,clock.now(),observations.length]);
  }return {observations:all.length,values:all};
 });
}
