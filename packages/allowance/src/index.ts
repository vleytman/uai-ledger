import {DomainError,hash,id,systemClock,units,type Clock} from '../../contracts/src/index.js';
import {paidApiSchemas,type TariffTemplate,type AllowanceDemand} from '../../contracts/paid-api.js';
import type {Tx} from '../../db/src/index.js';
import {audit,type Actor,type OperationsScope} from '../../reconciliation/src/connections.js';
import {allowancePeriod,periodBoundary} from './calendar.js';
import {quantity,decimal,positive,min,overageUnits,SCALE} from './quantity.js';
export {allowancePeriod} from './calendar.js';
export {quantity,decimal} from './quantity.js';
type Allocation={metric:string;grant_id:string|null;quantity:string};
export function validateTariff(value:unknown):TariffTemplate {
 const tariff=paidApiSchemas.TariffTemplate.parse(value);allowancePeriod(tariff.calendar,new Date(tariff.calendar.anchor));units(tariff.overage.max_units);
 const keys=new Set<string>();for(const counter of tariff.counters){if(keys.has(counter.key))throw new DomainError('duplicate_allowance_metric');keys.add(counter.key);if(tariff.overage.enabled&&counter.overage_usd_per_unit===undefined)throw new DomainError('overage_rate_required');if(!counter.rollover.enabled&&quantity(counter.rollover.cap)!==0n)throw new DomainError('disabled_rollover_cap');}
 if(!tariff.overage.enabled&&units(tariff.overage.max_units)!==0n)throw new DomainError('disabled_overage_budget');
 if(tariff.cost_allocation.mode==='allocated'){units(tariff.cost_allocation.subscription_fee_units);for(const key of Object.keys(tariff.cost_allocation.allocation_rates))if(!keys.has(key))throw new DomainError('unknown_allowance_metric');}
 return tariff;
}
/** All mutating methods require the caller's transaction. Locks span money/allowance admission. */
export class AllowanceService {
 constructor(private db:Tx,private clock:Clock=systemClock){}
 private async subscription(scope:OperationsScope,subscriptionId:string){
  const sub=(await this.db.query('SELECT s.*,t.definition FROM provider_subscriptions s JOIN provider_tariff_versions t ON t.id=s.tariff_version_id WHERE s.id=$1 AND s.organization_id=$2 AND s.application_id=$3 FOR UPDATE OF s',[subscriptionId,scope.organization_id,scope.application_id])).rows[0];
  if(!sub)throw new DomainError('not_found','Provider subscription not found',404);return sub;
 }
 async createAccount(scope:OperationsScope,value:unknown,actor:Actor){
  const input=paidApiSchemas.ProviderAccountCreate.parse(value);const accountId=id('pa');
  await audit(this.db,scope,this.clock,actor,'provider_account.create',accountId);
  return (await this.db.query('INSERT INTO provider_accounts(id,organization_id,application_id,provider,name,external_reference,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[accountId,scope.organization_id,scope.application_id,input.provider,input.name,input.external_reference,this.clock.now()])).rows[0];
 }
 async createSubscription(scope:OperationsScope,value:unknown,actor:Actor){
  const input=paidApiSchemas.SubscriptionCreate.parse(value);
  const account=(await this.db.query('SELECT * FROM provider_accounts WHERE id=$1 AND organization_id=$2 AND application_id=$3 FOR UPDATE',[input.provider_account_id,scope.organization_id,scope.application_id])).rows[0];
  const version=(await this.db.query('SELECT * FROM provider_tariff_versions WHERE id=$1 AND organization_id=$2 AND application_id=$3',[input.tariff_version_id,scope.organization_id,scope.application_id])).rows[0];
  if(!account||!version)throw new DomainError('not_found','Account or tariff not found',404);
  if(!(await this.db.query('SELECT 1 FROM configuration_activations WHERE organization_id=$1 AND application_id=$2 AND release_id=$3',[scope.organization_id,scope.application_id,version.file_source.release_id])).rowCount)throw new DomainError('tariff_not_active');
  const tariff=validateTariff(version.definition);if(account.provider!==tariff.provider)throw new DomainError('incompatible_provider_account');
  if(Object.keys(input.installation_share).length!==tariff.counters.length||tariff.counters.some(c=>input.installation_share[c.key]===undefined||quantity(input.installation_share[c.key])>quantity(c.included)))throw new DomainError('invalid_installation_share');
  // A second active subscription would create another copy of the same provider package.
  if((await this.db.query('SELECT id FROM provider_subscriptions WHERE provider_account_id=$1',[account.id])).rowCount)throw new DomainError('provider_subscription_exists');
  const subscriptionId=id('sub');await audit(this.db,scope,this.clock,actor,'provider_subscription.create',subscriptionId);
  return (await this.db.query('INSERT INTO provider_subscriptions(id,organization_id,application_id,provider_account_id,tariff_version_id,installation_share,starts_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[subscriptionId,scope.organization_id,scope.application_id,account.id,version.id,input.installation_share,input.starts_at,this.clock.now()])).rows[0];
 }
 async bindConnection(scope:OperationsScope,connectionId:string,value:unknown,revision:number,actor:Actor){
  const input=paidApiSchemas.ConnectionBinding.parse(value);
  const connection=(await this.db.query('SELECT * FROM provider_connections WHERE id=$1 AND organization_id=$2 AND application_id=$3 FOR UPDATE',[connectionId,scope.organization_id,scope.application_id])).rows[0];
  const account=(await this.db.query('SELECT * FROM provider_accounts WHERE id=$1 AND organization_id=$2 AND application_id=$3',[input.provider_account_id,scope.organization_id,scope.application_id])).rows[0];
  if(!connection||!account)throw new DomainError('not_found','Connection or provider account not found',404);
  if(account.provider!==connection.provider)throw new DomainError('incompatible_provider_account');
  if(input.subscription_id&&(await this.subscription(scope,input.subscription_id)).provider_account_id!==account.id)throw new DomainError('incompatible_provider_subscription');
  const old=(await this.db.query('SELECT * FROM provider_allowance_bindings WHERE connection_id=$1',[connectionId])).rows[0];
  if((old?.revision??0)!==revision)throw new DomainError('revision_conflict');
  if(old?.subscription_id&&old.subscription_id!==input.subscription_id&&(await this.db.query("SELECT 1 FROM allowance_reservations WHERE subscription_id=$1 AND state IN ('reserved','sent','unknown') LIMIT 1",[old.subscription_id])).rowCount)throw new DomainError('allowance_reservations_open','Resolve open reservations before reassignment',409);
  await audit(this.db,scope,this.clock,actor,'provider_account.bind',connectionId,{...input,revision});
  return (await this.db.query('INSERT INTO provider_allowance_bindings(connection_id,organization_id,application_id,provider_account_id,subscription_id,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(connection_id) DO UPDATE SET provider_account_id=EXCLUDED.provider_account_id,subscription_id=EXCLUDED.subscription_id,revision=EXCLUDED.revision RETURNING *',[connectionId,scope.organization_id,scope.application_id,account.id,input.subscription_id,revision+1])).rows[0];
 }
 async binding(scope:OperationsScope,connectionId:string){return (await this.db.query('SELECT * FROM provider_allowance_bindings WHERE connection_id=$1 AND organization_id=$2 AND application_id=$3',[connectionId,scope.organization_id,scope.application_id])).rows[0]??null;}
 private async grants(periodId:string,metric:string){
  const rows=(await this.db.query('SELECT g.*,COALESCE(SUM(l.reserved_delta),0)::text reserved,COALESCE(SUM(l.consumed_delta),0)::text consumed,COALESCE(SUM(l.transferred_delta),0)::text transferred FROM allowance_grants g LEFT JOIN allowance_ledger l ON l.grant_id=g.id WHERE g.period_id=$1 AND g.metric=$2 GROUP BY g.id ORDER BY g.expires_at,g.created_at,g.id',[periodId,metric])).rows;
  return rows.map(g=>({...g,available:positive(quantity(g.quantity)-signed(g.reserved)-signed(g.consumed)-signed(g.transferred))}));
 }
 private async ledger(periodId:string,a:Allocation,kind:string,evidence:unknown,reserved=0n,consumed=0n,transferred=0n,reservationId:string|null=null){
  await this.db.query('INSERT INTO allowance_ledger(period_id,grant_id,reservation_id,metric,reserved_delta,consumed_delta,transferred_delta,kind,evidence,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[periodId,a.grant_id,reservationId,a.metric,decimal(reserved),decimal(consumed),decimal(transferred),kind,evidence,this.clock.now()]);
 }
 private async grant(periodId:string,metric:string,amount:bigint,expires:Date,kind:string,originId:string|null=null){
  const grantId=id('ag');await this.db.query('INSERT INTO allowance_grants(id,period_id,metric,quantity,expires_at,kind,origin_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[grantId,periodId,metric,decimal(amount),expires,kind,originId,this.clock.now()]);return grantId;
 }
 private async period(sub:any){
  if(new Date(sub.starts_at)>this.clock.now())throw new DomainError('subscription_not_started');
  const tariff=sub.definition as TariffTemplate,current=allowancePeriod(tariff.calendar,this.clock.now());
  let previous=(await this.db.query('SELECT * FROM allowance_periods WHERE subscription_id=$1 ORDER BY month_index DESC LIMIT 1',[sub.id])).rows[0];
  if(previous&&previous.month_index>current.index)throw new DomainError('allowance_clock_regressed');
  const first=previous?previous.month_index+1:allowancePeriod(tariff.calendar,new Date(sub.starts_at)).index;
  if(current.index-first>1200)throw new DomainError('allowance_backfill_too_large');
  for(let index=first;index<=current.index;index++){
   const start=periodBoundary(tariff.calendar,index),end=periodBoundary(tariff.calendar,index+1),periodId=id('ap');
   await this.db.query('INSERT INTO allowance_periods(id,subscription_id,month_index,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)',[periodId,sub.id,index,start,end]);
   for(const counter of tariff.counters){
    const carryExpiry=periodBoundary(tariff.calendar,index+1+counter.rollover.expires_after_periods);
    await this.grant(periodId,counter.key,quantity(sub.installation_share[counter.key]),counter.rollover.enabled?carryExpiry:end,'included');
    if(previous&&counter.rollover.enabled){
     let remaining=quantity(counter.rollover.cap);
     for(const grant of await this.grants(previous.id,counter.key)){
      if(new Date(grant.expires_at)<=start||remaining===0n)continue;
      const amount=min(remaining,grant.available);if(!amount)continue;
      await this.grant(periodId,counter.key,amount,new Date(grant.expires_at),'rollover',grant.origin_id??grant.id);
      await this.ledger(previous.id,{metric:counter.key,grant_id:grant.id,quantity:decimal(amount)},'rollover',{to_period_id:periodId},0n,0n,amount);remaining-=amount;
     }
    }
   }
   previous={id:periodId,subscription_id:sub.id,month_index:index,starts_at:start,ends_at:end};
  }
  return previous;
 }
 private demands(tariff:TariffTemplate,items:AllowanceDemand[]){
  if(!items.length)throw new DomainError('allowance_maximum_missing');const keys=new Set<string>();
  return items.map(value=>{const d=paidApiSchemas.AllowanceDemand.parse(value);if(keys.has(d.metric)||!tariff.counters.some(c=>c.key===d.metric))throw new DomainError('invalid_allowance_metric');keys.add(d.metric);return d;});
 }
 private async allocate(sub:any,period:any,items:AllowanceDemand[],enforce:boolean){
  const tariff=sub.definition as TariffTemplate,allocations:Allocation[]=[];let overage=0n;
  for(const d of items){
   const counter=tariff.counters.find(c=>c.key===d.metric)!;let remaining=quantity(d.quantity);
   for(const grant of await this.grants(period.id,d.metric)){
    // Consumption settles against the original period, even when the callback is late.
    const amount=min(remaining,grant.available);if(amount){allocations.push({metric:d.metric,grant_id:grant.id,quantity:decimal(amount)});remaining-=amount;}
   }
   if(remaining){
    if(enforce&&!tariff.overage.enabled)throw this.exhausted(period,d.metric);
    if(counter.overage_usd_per_unit!==undefined)overage+=overageUnits(remaining,counter.overage_usd_per_unit);
    allocations.push({metric:d.metric,grant_id:null,quantity:decimal(remaining)});
   }
  }
  if(enforce){
   // Unpriced excess in any old period blocks later work until an evidenced correction.
   if(!tariff.overage.enabled&&(await this.db.query('SELECT 1 FROM allowance_ledger l JOIN allowance_periods p ON p.id=l.period_id WHERE p.subscription_id=$1 AND l.grant_id IS NULL GROUP BY l.period_id,l.metric HAVING SUM(l.consumed_delta)>0 LIMIT 1',[sub.id])).rowCount)throw this.exhausted(period,'unresolved_overdraw');
   const budget=(await this.db.query('SELECT COALESCE(SUM(overage_reserved_units+overage_spent_units),0)::text amount FROM allowance_reservations WHERE period_id=$1',[period.id])).rows[0];
   if(BigInt(budget.amount)+overage>units(tariff.overage.max_units))throw new DomainError('overage_budget_exhausted','Provider overage budget exhausted',409,{retryable:false,resets_at:new Date(period.ends_at).toISOString()});
  }
  return {allocations,overage};
 }
 private exhausted(period:any,metric:string){return new DomainError('allowance_exhausted','Provider allowance exhausted',409,{metric,retryable:false,resets_at:new Date(period.ends_at).toISOString()});}
 async reserve(scope:OperationsScope,subscriptionId:string,identity:string,items:AllowanceDemand[]){
  const sub=await this.subscription(scope,subscriptionId),demands=this.demands(sub.definition,items),digest=hash(demands);
  const old=(await this.db.query('SELECT * FROM allowance_reservations WHERE subscription_id=$1 AND identity=$2',[sub.id,identity])).rows[0];
  if(old){if(old.input_hash!==digest)throw new DomainError('idempotency_conflict');return old;}
  const period=await this.period(sub);
  await this.checkSnapshots(sub,period,demands);
  const {allocations,overage}=await this.allocate(sub,period,demands,true),reservationId=id('ar');
  const reservation=(await this.db.query("INSERT INTO allowance_reservations(id,subscription_id,period_id,identity,input_hash,demands,allocations,overage_reserved_units,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9) RETURNING *",[reservationId,sub.id,period.id,identity,digest,JSON.stringify(demands),JSON.stringify(allocations),overage.toString(),this.clock.now()])).rows[0];
  for(const a of allocations)await this.ledger(period.id,a,'reserve',{identity},quantity(a.quantity),0n,0n,reservationId);
  return reservation;
 }
 private async reservation(scope:OperationsScope,reservationId:string){
  const row=(await this.db.query('SELECT r.* FROM allowance_reservations r JOIN provider_subscriptions s ON s.id=r.subscription_id WHERE r.id=$1 AND s.organization_id=$2 AND s.application_id=$3',[reservationId,scope.organization_id,scope.application_id])).rows[0];
  if(!row)throw new DomainError('not_found','Allowance reservation not found',404);
  const sub=await this.subscription(scope,row.subscription_id);
  return {sub,row:(await this.db.query('SELECT * FROM allowance_reservations WHERE id=$1',[reservationId])).rows[0]};
 }
 /** Called in the durable SQL send boundary, after rate-limit admission and before HTTP. */
 async markSent(scope:OperationsScope,reservationId:string){
  const {sub,row}=await this.reservation(scope,reservationId);if(['sent','unknown','settled'].includes(row.state))return row;
  if(row.state!=='reserved')throw new DomainError('allowance_not_reserved');
  const current=await this.period(sub);
  if(current.id!==row.period_id){
   for(const a of row.allocations as Allocation[])await this.ledger(row.period_id,a,'period_release',{to_period_id:current.id},-quantity(a.quantity),0n,0n,row.id);
   await this.db.query('UPDATE allowance_reservations SET overage_reserved_units=0 WHERE id=$1',[row.id]);
   await this.checkSnapshots(sub,current,row.demands);
   const next=await this.allocate(sub,current,row.demands,true);
   for(const a of next.allocations)await this.ledger(current.id,a,'period_reserve',{from_period_id:row.period_id},quantity(a.quantity),0n,0n,row.id);
   await this.db.query('UPDATE allowance_reservations SET period_id=$2,allocations=$3,overage_reserved_units=$4 WHERE id=$1',[row.id,current.id,JSON.stringify(next.allocations),next.overage.toString()]);
  }
  await this.checkSnapshots(sub,current,row.demands,row.id);
  return (await this.db.query("UPDATE allowance_reservations SET state='sent',sent_at=$2 WHERE id=$1 RETURNING *",[row.id,this.clock.now()])).rows[0];
 }
 async release(scope:OperationsScope,reservationId:string,reason:string){
  const {row}=await this.reservation(scope,reservationId);if(row.state==='released')return row;
  if(row.state!=='reserved')throw new DomainError('allowance_outcome_evidence_required');
  if(!reason.trim())throw new DomainError('reason_required');
  for(const a of row.allocations as Allocation[])await this.ledger(row.period_id,a,'release',{reason},-quantity(a.quantity),0n,0n,row.id);
  return (await this.db.query("UPDATE allowance_reservations SET state='released',overage_reserved_units=0 WHERE id=$1 RETURNING *",[row.id])).rows[0];
 }
 async observe(scope:OperationsScope,reservationId:string,value:unknown){
  const input=paidApiSchemas.UsageObservation.parse(value),{sub,row}=await this.reservation(scope,reservationId),digest=hash(input);
  const old=(await this.db.query('SELECT * FROM allowance_observations WHERE reservation_id=$1 AND (revision=$2 OR identity=$3)',[row.id,input.revision,input.identity])).rows;
  if(old.length){if(old.some(v=>v.hash!==digest))throw new DomainError('idempotency_conflict');return row;}
  if(input.revision<=row.observation_revision)throw new DomainError('stale_allowance_observation');
  if(!['sent','unknown','settled'].includes(row.state))throw new DomainError('allowance_not_sent');
  if(input.state==='unknown'&&row.state==='settled')throw new DomainError('allowance_observation_regression');
  if(input.source==='manual'&&!input.reason?.trim())throw new DomainError('reason_required');
  if(input.state==='known'){
   this.demands(sub.definition,input.items);
   if(hash(input.items.map(d=>d.metric).sort())!==hash(row.demands.map((d:AllowanceDemand)=>d.metric).sort()))throw new DomainError('incomplete_allowance_usage');
   if(row.state==='settled')for(const a of row.actual_allocations as Allocation[])await this.ledger(row.period_id,a,'usage_correction',{observation:input.identity},0n,-quantity(a.quantity),0n,row.id);
   else for(const a of row.allocations as Allocation[])await this.ledger(row.period_id,a,'settle_release',{observation:input.identity},-quantity(a.quantity),0n,0n,row.id);
   const period=(await this.db.query('SELECT * FROM allowance_periods WHERE id=$1',[row.period_id])).rows[0];
   const actual=await this.allocate(sub,period,input.items,false);
   let allocated=0n;const tariff=sub.definition as TariffTemplate;
   if(tariff.cost_allocation.mode==='allocated'){
    const policy=tariff.cost_allocation;
    for(const a of actual.allocations)if(a.grant_id&&policy.allocation_rates[a.metric])allocated+=overageUnits(quantity(a.quantity),policy.allocation_rates[a.metric]);
    const used=(await this.db.query('SELECT COALESCE(SUM(allocated_cost_units),0)::text amount FROM allowance_reservations WHERE period_id=$1 AND id<>$2',[row.period_id,row.id])).rows[0];
    allocated=min(allocated,positive(units(policy.subscription_fee_units)-BigInt(used.amount)));
   }
   await this.db.query('UPDATE allowance_reservations SET allocated_cost_units=$2 WHERE id=$1',[row.id,allocated.toString()]);
   for(const a of actual.allocations)await this.ledger(row.period_id,a,'consume',{observation:input.identity,attempt_id:input.attempt_id},0n,quantity(a.quantity),0n,row.id);
   await this.db.query("UPDATE allowance_reservations SET state='settled',actual_allocations=$2,overage_reserved_units=0,overage_spent_units=$3,observation_revision=$4,settled_at=$5 WHERE id=$1",[row.id,JSON.stringify(actual.allocations),actual.overage.toString(),input.revision,this.clock.now()]);
  }else await this.db.query("UPDATE allowance_reservations SET state='unknown',observation_revision=$2 WHERE id=$1",[row.id,input.revision]);
  await this.db.query('INSERT INTO allowance_observations(reservation_id,revision,identity,hash,observation,created_at) VALUES($1,$2,$3,$4,$5,$6)',[row.id,input.revision,input.identity,digest,input,this.clock.now()]);
  return (await this.db.query('SELECT * FROM allowance_reservations WHERE id=$1',[row.id])).rows[0];
 }
 async snapshot(scope:OperationsScope,subscriptionId:string,value:unknown,actor:Actor){
  const input=paidApiSchemas.ProviderSnapshot.parse(value),sub=await this.subscription(scope,subscriptionId),digest=hash(input);
  const old=(await this.db.query('SELECT * FROM allowance_snapshots WHERE subscription_id=$1 AND identity=$2',[sub.id,input.identity])).rows[0];
  if(old){if(old.hash!==digest)throw new DomainError('idempotency_conflict');return old;}
  const period=(await this.db.query('SELECT * FROM allowance_periods WHERE id=$1 AND subscription_id=$2',[input.period_id,sub.id])).rows[0];
  if(!period||input.provider_account_id!==sub.provider_account_id)throw new DomainError('not_found','Allowance period not found',404);
  if(!(sub.definition as TariffTemplate).counters.some(c=>c.key===input.metric))throw new DomainError('invalid_allowance_metric');
  if(new Date(input.observed_at)>this.clock.now()||new Date(input.observed_at)<new Date(period.starts_at)||input.covered_through&&(new Date(input.covered_through)>new Date(input.observed_at)||new Date(input.covered_through)<new Date(period.starts_at)||new Date(input.covered_through)>new Date(period.ends_at)))throw new DomainError('invalid_snapshot_coverage');
  const snapshotId=id('as');await audit(this.db,scope,this.clock,actor,'allowance.snapshot',snapshotId,{period_id:period.id,metric:input.metric});
  const saved=(await this.db.query('INSERT INTO allowance_snapshots(id,subscription_id,period_id,identity,hash,metric,remaining,observed_at,covered_through,precision,scope,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[snapshotId,sub.id,period.id,input.identity,digest,input.metric,input.remaining,input.observed_at,input.covered_through,input.precision,input.scope,this.clock.now()])).rows[0];
  for(const oldId of input.supersedes??[]){
   const previous=(await this.db.query('SELECT * FROM allowance_snapshots WHERE id=$1 AND subscription_id=$2 AND period_id=$3 AND metric=$4',[oldId,sub.id,period.id,input.metric])).rows[0];
   if(!previous||new Date(previous.observed_at)>new Date(input.observed_at))throw new DomainError('invalid_snapshot_supersession');
   if((await this.db.query('SELECT 1 FROM allowance_snapshot_supersessions WHERE snapshot_id=$1',[oldId])).rowCount)throw new DomainError('snapshot_already_superseded');
   await this.db.query('INSERT INTO allowance_snapshot_supersessions(snapshot_id,replacement_id,actor_id,reason) VALUES($1,$2,$3,$4)',[oldId,saved.id,actor.actor_id,actor.reason]);
  }
  return saved;
 }
 private async snapshotCeiling(periodId:string,metric:string,excludeReservation?:string){
  const snapshots=(await this.db.query('SELECT s.* FROM allowance_snapshots s WHERE period_id=$1 AND metric=$2 AND NOT EXISTS(SELECT 1 FROM allowance_snapshot_supersessions x WHERE x.snapshot_id=s.id)',[periodId,metric])).rows;
  const reservations=(await this.db.query("SELECT * FROM allowance_reservations WHERE period_id=$1 AND state<>'released'",[periodId])).rows;
  let ceiling:bigint|null=null;
  for(const snapshot of snapshots){
   let remaining=quantity(snapshot.remaining);
   for(const r of reservations){
    if(r.id===excludeReservation)continue;
    // Only confirmed coverage proves inclusion. Pending or uncertain calls always retain their maximum.
    if(r.state==='settled'&&snapshot.precision==='confirmed'&&snapshot.covered_through&&r.settled_at&&new Date(r.settled_at)<=new Date(snapshot.covered_through))continue;
    const items:AllowanceDemand[]=r.state==='settled'?r.actual_allocations:r.demands;
    for(const item of items)if(item.metric===metric)remaining-=quantity(item.quantity);
   }
   ceiling=ceiling===null?remaining:min(ceiling,remaining);
  }
  return ceiling;
 }
 private async checkSnapshots(_sub:any,period:any,items:AllowanceDemand[],excludeReservation?:string){
  for(const d of items){const ceiling=await this.snapshotCeiling(period.id,d.metric,excludeReservation);if(ceiling!==null&&ceiling<quantity(d.quantity))throw this.exhausted(period,d.metric);}
 }
 async adjust(scope:OperationsScope,subscriptionId:string,value:unknown,actor:Actor){
  const input=paidApiSchemas.AllowanceAdjustment.parse(value),sub=await this.subscription(scope,subscriptionId),digest=hash(input);
  const period=(await this.db.query('SELECT * FROM allowance_periods WHERE id=$1 AND subscription_id=$2',[input.period_id,sub.id])).rows[0];
  if(!period)throw new DomainError('not_found','Allowance period not found',404);
  if(!(sub.definition as TariffTemplate).counters.some(c=>c.key===input.metric))throw new DomainError('invalid_allowance_metric');
  const old=(await this.db.query('SELECT * FROM allowance_adjustments WHERE period_id=$1 AND evidence_id=$2',[period.id,input.evidence_id])).rows[0];
  if(old){if(old.hash!==digest)throw new DomainError('idempotency_conflict');return old;}
  const adjustmentId=id('aa');await audit(this.db,scope,this.clock,actor,'allowance.adjust',adjustmentId,{...input});
  const amount=quantity(input.quantity);
  if(input.direction==='increase'){
   const grantId=await this.grant(period.id,input.metric,amount,new Date(period.ends_at),'adjustment');
   const debt=(await this.db.query('SELECT COALESCE(SUM(consumed_delta),0)::text amount FROM allowance_ledger WHERE period_id=$1 AND metric=$2 AND grant_id IS NULL',[period.id,input.metric])).rows[0];
   const covered=min(amount,positive(signed(debt.amount)));
   if(covered){await this.ledger(period.id,{grant_id:null,metric:input.metric,quantity:decimal(covered)},'adjustment',{adjustment_id:adjustmentId},0n,-covered);await this.ledger(period.id,{grant_id:grantId,metric:input.metric,quantity:decimal(covered)},'adjustment',{adjustment_id:adjustmentId},0n,covered);}
  }
  else {
   let remaining=amount;for(const g of await this.grants(period.id,input.metric)){const take=min(remaining,g.available);if(take){await this.ledger(period.id,{grant_id:g.id,metric:input.metric,quantity:decimal(take)},'adjustment',{adjustment_id:adjustmentId},0n,take);remaining-=take;}}
   if(remaining)await this.ledger(period.id,{grant_id:null,metric:input.metric,quantity:decimal(remaining)},'adjustment',{adjustment_id:adjustmentId},0n,remaining);
  }
  return (await this.db.query('INSERT INTO allowance_adjustments(id,period_id,evidence_id,hash,adjustment,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[adjustmentId,period.id,input.evidence_id,digest,input,actor.actor_id,this.clock.now()])).rows[0];
 }
 async state(scope:OperationsScope,subscriptionId:string){
  const sub=await this.subscription(scope,subscriptionId),period=await this.period(sub),tariff=sub.definition as TariffTemplate;
  const metrics=[];
  for(const c of tariff.counters){
   const grants=await this.grants(period.id,c.key),sum=(key:string)=>grants.reduce((total,g)=>total+(key==='available'?g.available:signed(g[key])),0n);
   const totals=(await this.db.query('SELECT COALESCE(SUM(reserved_delta),0)::text reserved,COALESCE(SUM(consumed_delta),0)::text consumed FROM allowance_ledger WHERE period_id=$1 AND metric=$2',[period.id,c.key])).rows[0];
   const included=quantity(sub.installation_share[c.key]),rollover=grants.filter(g=>g.kind==='rollover').reduce((n,g)=>n+quantity(g.quantity),0n),ceiling=await this.snapshotCeiling(period.id,c.key);
   const local=sum('available'),available=ceiling===null?local:positive(min(local,ceiling)),consumed=signed(totals.consumed),reserved=signed(totals.reserved);
   const grantTotal=grants.reduce((n,g)=>n+quantity(g.quantity),0n);
   metrics.push({metric:c.key,unit:c.unit,included:decimal(included),rollover:decimal(rollover),consumed:decimal(consumed),reserved:decimal(reserved),available:decimal(available),overdrawn:decimal(positive(consumed+reserved-grantTotal)),remaining_percent:included+rollover?decimal(available*100n*SCALE/(included+rollover)):null});
  }
  const budget=(await this.db.query('SELECT COALESCE(SUM(overage_reserved_units),0)::text reserved,COALESCE(SUM(overage_spent_units),0)::text spent FROM allowance_reservations WHERE period_id=$1',[period.id])).rows[0];
  const snapshots=(await this.db.query('SELECT DISTINCT ON(metric) metric,observed_at,precision,covered_through FROM allowance_snapshots WHERE period_id=$1 ORDER BY metric,observed_at DESC',[period.id])).rows;
  const freshness=snapshots.length!==tariff.counters.length?'unknown':snapshots.some(s=>this.clock.now().getTime()-new Date(s.observed_at).getTime()>300000)?'stale':snapshots.some(s=>s.precision!=='confirmed'||!s.covered_through)?'unknown':'fresh';
  return {subscription_id:sub.id,period_id:period.id,period_start:new Date(period.starts_at).toISOString(),period_end:new Date(period.ends_at).toISOString(),metrics,overage:{limit_units:tariff.overage.max_units,spent_units:budget.spent,reserved_units:budget.reserved},freshness,sampled_at:this.clock.now().toISOString()};
 }
}
function signed(value:string):bigint{return value.startsWith('-')?-quantity(value.slice(1)):quantity(value);}
