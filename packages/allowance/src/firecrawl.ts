import {DomainError,type Clock} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';
import {AllowanceService} from './index.js';
import type {Actor,OperationsScope} from '../../reconciliation/src/connections.js';
import type {FirecrawlAdapter} from '../../providers/src/firecrawl.js';
/** Credit usage has no coverage timestamp: it may constrain local allowance, never confirm a request cost. */
export async function importFirecrawlAllowance(tx:Tx,scope:OperationsScope,clock:Clock,connectionId:string,snapshot:Awaited<ReturnType<FirecrawlAdapter['readCreditUsage']>>,identity:string,actor:Actor){
 const service=new AllowanceService(tx,clock),binding=await service.binding(scope,connectionId);
 if(!binding?.subscription_id)throw new DomainError('allowance_subscription_missing');
 const state=await service.state(scope,binding.subscription_id);
 if(state.period_start!==snapshot.period_start||state.period_end!==snapshot.period_end)throw new DomainError('allowance_period_mismatch','Provider billing period differs from the configured tariff',409);
 if(!state.metrics.some(m=>m.metric==='credits'&&m.unit==='credits'))throw new DomainError('invalid_allowance_metric');
 return service.snapshot(scope,binding.subscription_id,{identity,provider_account_id:binding.provider_account_id,period_id:state.period_id,metric:'credits',remaining:snapshot.remaining,observed_at:clock.now().toISOString(),covered_through:null,precision:'estimated',scope:'provider_account',reason:actor.reason},actor);
}
