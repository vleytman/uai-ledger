import {Decimal,rateUsage,type RateCard,type RatingContext} from './index.js';
import {DomainError,hash,id,systemClock,type Clock,type Scope} from '../../contracts/src/index.js';
import type {SqlExecutor} from '../../db/src/index.js';
import type {NormalizedUsage,UsageObservation} from '../../providers/src/contracts.js';
export interface ObservationInput extends UsageObservation { attempt_id:string;connection_id:string;model:string;provider_at?:string }
export async function persistObservation(db:SqlExecutor,scope:Scope,input:ObservationInput,clock:Clock=systemClock){
  if(!input.event_id||!input.attempt_id||!Number.isSafeInteger(input.revision)||input.revision<0)throw new DomainError('invalid_observation');
  if(input.usage.state==='known')for(const item of input.usage.items)Decimal.parse(item.quantity);
  // Raw provider responses belong to temporary storage. Only their digest survives here.
  const source_hash=hash(input);const row=(await db.query('INSERT INTO provider_usage_observations(id,organization_id,application_id,account_id,attempt_id,connection_id,model,provider_event_id,kind,revision,usage,source_hash,provider_request_id,observed_at,provider_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING RETURNING *',[id('usage'),scope.organization_id,scope.application_id,scope.account_id,input.attempt_id,input.connection_id,input.model,input.event_id,input.kind,input.revision,JSON.stringify(input.usage),source_hash,input.provider_request_id??null,clock.now(),input.provider_at??null])).rows[0];
  if(row)return row;
  const prior=(await db.query('SELECT * FROM provider_usage_observations WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND attempt_id=$4 AND provider_event_id=$5',[scope.organization_id,scope.application_id,scope.account_id,input.attempt_id,input.event_id])).rows[0];
  if(!prior||prior.source_hash!==source_hash)throw new DomainError('idempotency_conflict');return prior;
}
export async function getAttemptUsage(db:SqlExecutor,scope:Scope,attemptId:string):Promise<NormalizedUsage>{
  const rows=(await db.query('SELECT * FROM provider_usage_observations WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND attempt_id=$4 ORDER BY revision DESC,observed_at DESC',[scope.organization_id,scope.application_id,scope.account_id,attemptId])).rows;
  if(!rows.length)return {state:'unknown',reason:'missing_usage'};
  const final=rows.find(r=>r.kind==='final');if(final)return final.usage;
  const cumulative=rows.find(r=>r.kind==='cumulative');const selected=cumulative?[cumulative,...rows.filter(r=>r.kind==='delta'&&r.revision>cumulative.revision)]:rows.filter(r=>r.kind==='delta');
  if(selected.some(r=>r.usage.state==='unknown'))return {state:'unknown',reason:'incomplete_observation'};
  const groups=new Map<string,{item:any;quantity:Decimal}>();for(const row of selected)for(const item of row.usage.items){const key=hash({dimension:item.dimension,unit:item.unit,conditions:item.conditions??{}});const existing=groups.get(key);groups.set(key,{item,quantity:(existing?.quantity??Decimal.parse('0')).add(Decimal.parse(item.quantity))});}
  return {state:'known',items:[...groups.values()].map(v=>({...v.item,quantity:v.quantity.toString()}))};
}
export interface CostEntryInput { allowance_cost?:{reservation_id:string;tariff_version_id:string;incremental_units:string;allocated_units:string;mode:'incremental'|'allocated'}; identity:string;connection_id:string;model:string;attempt_id?:string;observation_id?:string;usage:NormalizedUsage;rate_card:RateCard;context:RatingContext;provider_completed_at?:string;reason?:string }
export async function persistCost(db:SqlExecutor,scope:Scope,input:CostEntryInput,clock:Clock=systemClock){
  const subscription=input.allowance_cost;
  const total=subscription?BigInt(subscription.incremental_units)+(subscription.mode==='allocated'?BigInt(subscription.allocated_units):0n):undefined;
  const rating=total!==undefined?{state:'calculated' as const,exact_amount:new Decimal(total,9).toString(),rounded_units:total,items:[{allowance:subscription}]}:rateUsage(input.usage,input.rate_card,input.context);const source_hash=hash(input);
  const row=(await db.query('INSERT INTO provider_cost_entries(id,organization_id,application_id,account_id,attempt_id,connection_id,model,observation_id,rate_card_id,state,currency,exact_amount,rounded_units,rated_items,provider_completed_at,priced_at,entry_type,reason,identity,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT DO NOTHING RETURNING *',[id('cost'),scope.organization_id,scope.application_id,scope.account_id,input.attempt_id??null,input.connection_id,input.model,input.observation_id??null,input.rate_card.id,rating.state,'USD',rating.state==='calculated'?rating.exact_amount:null,rating.state==='calculated'?rating.rounded_units.toString():null,JSON.stringify(rating.state==='calculated'?rating.items:[]),input.provider_completed_at??null,clock.now(),'original',input.reason??'',input.identity,source_hash])).rows[0];
  if(row)return row;
  const prior=(await db.query('SELECT * FROM provider_cost_entries WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND identity=$4',[scope.organization_id,scope.application_id,scope.account_id,input.identity])).rows[0];if(!prior||prior.source_hash!==source_hash)throw new DomainError('idempotency_conflict');return prior;
}
