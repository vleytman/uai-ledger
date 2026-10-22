import type {LimitUsage} from '../../providers/src/contracts.js';
import {DomainError} from '../../contracts/src/index.js';
import type {QuotaDemand} from './quota.js';
/** Shared by actual admission and its read-only preview. */
export function quotaDemands(rules:Array<{key:string;metric:string;capacity:string|number;window_ms:number}>,quantities:LimitUsage):QuotaDemand[]{
 return rules.map(rule=>{
  const amount=quantities[rule.metric as keyof LimitUsage];if(!Number.isSafeInteger(amount)||(amount??-1)<0)throw new DomainError('quota_metric_estimate_missing');
  return {key:rule.key,capacity:Number(rule.capacity),amount:amount!,window_ms:rule.window_ms};
 });
}
