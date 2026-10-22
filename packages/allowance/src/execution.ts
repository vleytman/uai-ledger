import {DomainError,type Scope,type Clock} from '../../contracts/src/index.js';
import type {AllowanceDemand,TariffTemplate} from '../../contracts/paid-api.js';
import type {BillableItem,ProviderResult} from '../../providers/src/contracts.js';
import type {Tx} from '../../db/src/index.js';
import {AllowanceService} from './index.js';
import {quantity,decimal} from './quantity.js';
export interface AllowanceAuthorization {subscription_id:string;demands:AllowanceDemand[];metrics:Array<{key:string;unit:string;dimensions?:string[]}>}
function measured(items:BillableItem[],metric:{key:string;unit:string;dimensions?:string[]}):string|undefined {
 const selected=items.filter(i=>(metric.dimensions??[metric.key]).includes(i.dimension)&&i.unit===metric.unit);
 return selected.length?decimal(selected.reduce((sum,i)=>sum+quantity(i.quantity),0n)):undefined;
}
export async function quoteAllowance(tx:Tx,scope:Scope,clock:Clock,connectionId:string,maximum:BillableItem[]):Promise<AllowanceAuthorization|undefined>{
 const service=new AllowanceService(tx,clock),binding=await service.binding(scope,connectionId);if(!binding?.subscription_id)return;
 const row=(await tx.query('SELECT t.definition FROM provider_subscriptions s JOIN provider_tariff_versions t ON t.id=s.tariff_version_id WHERE s.id=$1 AND s.organization_id=$2 AND s.application_id=$3',[binding.subscription_id,scope.organization_id,scope.application_id])).rows[0];if(!row)throw new DomainError('allowance_subscription_missing');
 const tariff=row.definition as TariffTemplate,demands:AllowanceDemand[]=[],metrics:Array<{key:string;unit:string;dimensions?:string[]}>=[];
 for(const counter of tariff.counters){const amount=counter.key==='requests'?'1':measured(maximum,counter);if(amount!==undefined){demands.push({metric:counter.key,quantity:amount});metrics.push({key:counter.key,unit:counter.unit,dimensions:counter.dimensions});}}
 if(!demands.length)throw new DomainError('allowance_maximum_missing','Route cannot measure the bound subscription',422);
 return {subscription_id:binding.subscription_id,demands,metrics};
}
export async function prepareAttemptAllowance(tx:Tx,scope:Scope,clock:Clock,request:any,variant:any,attemptId:string){
 const service=new AllowanceService(tx,clock),authorization=variant.allowance as AllowanceAuthorization|undefined;
 let reservationId:string|undefined=request.route.initial_allowance_reservation_id;
 const initial=reservationId?(await tx.query('SELECT subscription_id FROM allowance_reservations WHERE id=$1',[reservationId])).rows[0]:null;
 const locks=[...new Set([initial?.subscription_id,authorization?.subscription_id].filter(Boolean))].sort();
 await tx.query('SELECT id FROM provider_subscriptions WHERE id=ANY($1::text[]) AND organization_id=$2 AND application_id=$3 ORDER BY id FOR UPDATE',[locks,scope.organization_id,scope.application_id]);
 if(reservationId){
  const original=(await tx.query('SELECT * FROM allowance_reservations WHERE id=$1',[reservationId])).rows[0];
  if(original?.state!=='reserved')reservationId=undefined;
  else if(!authorization||original.subscription_id!==authorization.subscription_id){await service.release(scope,reservationId!,'Unsent route changed before dispatch');reservationId=undefined;}
 }
 if(!authorization)return;
 if(!reservationId)reservationId=(await service.reserve(scope,authorization.subscription_id,`attempt:${attemptId}`,authorization.demands)).id;
 await service.markSent(scope,reservationId!);
 await tx.query('UPDATE execution_attempts SET allowance_reservation_id=$2 WHERE id=$1',[attemptId,reservationId]);
 return reservationId;
}
export async function observeAttemptAllowance(tx:Tx,scope:Scope,clock:Clock,attempt:any,result:ProviderResult,identity:string){
 const row=(await tx.query('SELECT allowance_reservation_id FROM execution_attempts WHERE id=$1',[attempt.id])).rows[0];if(!row?.allowance_reservation_id)return;
 const authorization=attempt.variant.allowance as AllowanceAuthorization;
 const items:AllowanceDemand[]=[];let known=true;
 for(const metric of authorization.metrics){
  const amount=result.outcome==='failure'&&!result.failure.sent?'0':metric.key==='requests'&&result.outcome==='success'?'1':result.usage.state==='known'?measured(result.usage.items,metric):undefined;
  if(amount===undefined)known=false;else items.push({metric:metric.key,quantity:amount});
 }
 const previous=(await tx.query('SELECT * FROM allowance_observations WHERE reservation_id=$1 AND identity=$2',[row.allowance_reservation_id,identity])).rows[0];
 const reservation=(await tx.query('SELECT observation_revision,state FROM allowance_reservations WHERE id=$1',[row.allowance_reservation_id])).rows[0];
 if(reservation.state==='settled'&&!known)return;
 return new AllowanceService(tx,clock).observe(scope,row.allowance_reservation_id,{identity,revision:previous?.revision??reservation.observation_revision+1,attempt_id:attempt.id,state:known?'known':'unknown',items:known?items:[],source:'adapter'});
}
export async function releaseUnsentAllowance(tx:Tx,scope:Scope,clock:Clock,reservationId:string|undefined,reason:string){
 if(!reservationId)return;
 const row=(await tx.query('SELECT state FROM allowance_reservations WHERE id=$1',[reservationId])).rows[0];
 if(row?.state==='reserved')await new AllowanceService(tx,clock).release(scope,reservationId,reason);
}

export async function allowanceCost(tx:Tx,scope:Scope,attemptId:string){
 const row=(await tx.query('SELECT r.*,s.tariff_version_id,t.definition FROM execution_attempts a JOIN allowance_reservations r ON r.id=a.allowance_reservation_id JOIN provider_subscriptions s ON s.id=r.subscription_id JOIN provider_tariff_versions t ON t.id=s.tariff_version_id WHERE a.id=$1 AND s.organization_id=$2 AND s.application_id=$3',[attemptId,scope.organization_id,scope.application_id])).rows[0];
 if(!row||row.state!=='settled')return undefined;
 return {reservation_id:row.id,tariff_version_id:row.tariff_version_id,incremental_units:row.overage_spent_units as string,allocated_units:row.allocated_cost_units as string,mode:row.definition.cost_allocation.mode as 'incremental'|'allocated'};
}
