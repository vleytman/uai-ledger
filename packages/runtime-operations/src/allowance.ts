import {AllowanceService} from '../../allowance/src/index.js';
import {quantity,decimal,positive} from '../../allowance/src/quantity.js';
import {NotificationService} from '../../notifications/src/index.js';
import type {Tx} from '../../db/src/index.js';
import type {Clock} from '../../contracts/src/index.js';
import type {MonitorObservation} from './index.js';
export async function collectAllowanceObservations(tx:Tx,clock:Clock,scope:{organization_id:string;application_id:string}):Promise<MonitorObservation[]>{
 const notifications=new NotificationService(tx,clock),rules=(await notifications.listRules(scope)).filter(r=>r.enabled&&r.allowance),result:MonitorObservation[]=[];
 const subscriptions=[...new Set(rules.map(r=>r.allowance.subscription_id))].sort();
 for(const subscriptionId of subscriptions){
  const sub=(await tx.query('SELECT * FROM provider_subscriptions WHERE id=$1 AND organization_id=$2 AND application_id=$3',[subscriptionId,scope.organization_id,scope.application_id])).rows[0];if(!sub||new Date(sub.starts_at)>clock.now())continue;
  const state=await new AllowanceService(tx,clock).state(scope,subscriptionId);
  const previous=(await tx.query('SELECT 1 FROM allowance_periods WHERE subscription_id=$1 AND starts_at<$2 LIMIT 1',[subscriptionId,state.period_start])).rowCount!>0;
  // Renewal resolves the previous period's alerts, without touching operational provider locks.
  const incidents=(await tx.query("SELECT * FROM notification_incidents WHERE organization_id=$1 AND application_id=$2 AND resource_id=$3 AND state<>'resolved' AND details->>'period_id' IS NOT NULL AND details->>'period_id'<>$4",[scope.organization_id,scope.application_id,subscriptionId,state.period_id])).rows;
  for(const incident of incidents)await notifications.resolve(scope,incident.id,incident.revision,{actor_id:'monitor',reason:'Allowance period renewed'});
  for(const rule of rules.filter(r=>r.allowance.subscription_id===subscriptionId)){
   const filter=rule.allowance,metric=state.metrics.find(m=>m.metric===filter.metric);let observed:string|undefined,active=true;
   const overage=positive(BigInt(state.overage.limit_units)-BigInt(state.overage.spent_units)-BigInt(state.overage.reserved_units)).toString();
   switch(rule.signal){
    case 'allowance.low':observed=filter.unit==='percent'?metric?.remaining_percent??undefined:metric?.available;active=observed!==undefined;break;
    case 'allowance.exhausted':active=!!metric&&quantity(metric.available)===0n;break;
    case 'allowance.renewed':active=previous;break;
    case 'allowance.discrepancy':if(metric){observed=decimal(positive(quantity(metric.included)+quantity(metric.rollover)-quantity(metric.consumed)-quantity(metric.reserved)-quantity(metric.available)));active=quantity(observed)>0n;}else active=false;break;
    case 'overage.budget_low':observed=overage;active=BigInt(state.overage.limit_units)>0n;break;
    case 'overage.budget_exhausted':active=BigInt(state.overage.limit_units)>0n&&overage==='0';break;
    case 'usage.snapshot_stale':{
     const snapshot=(await tx.query('SELECT max(observed_at) observed_at FROM allowance_snapshots WHERE period_id=$1 AND ($2::text IS NULL OR metric=$2)',[state.period_id,filter.metric??null])).rows[0];
     observed=String(Math.max(0,Math.floor((clock.now().getTime()-new Date(snapshot.observed_at??sub.created_at).getTime())/1000)));active=state.freshness!=='fresh';break;
    }
    default:continue;
   }
   result.push({scope,signal:rule.signal,resource_id:subscriptionId,failure_scope:`${state.period_id}:${filter.metric??'subscription'}:${filter.unit}`,metric:filter.metric,rule_ids:[rule.id],observed_value:observed,samples:1,active,source:'provider_allowance_ledger',details:{...state,provider_account_id:sub.provider_account_id,metric:metric??null,source:'provider_allowance_ledger'}});
  }
 }
 return result;
}
