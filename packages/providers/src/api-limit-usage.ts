import {DomainError} from '../../contracts/src/index.js';
import {quantity,SCALE} from '../../allowance/src/quantity.js';
import type {LimitUsage} from './contracts.js';
/** Rolling counters use conservative whole native units; allowance retains decimal precision. */
export function apiLimitUsage(measurements:Record<string,string>):LimitUsage{
 const usage:LimitUsage={requests:1};
 for(const [key,value] of Object.entries(measurements)){
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||['constructor','prototype'].includes(key))throw new DomainError('quota_metric_invalid');
  const n=(quantity(value)+SCALE-1n)/SCALE;if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new DomainError('quota_metric_out_of_range');usage[key]=Number(n);
 }
 // Token API measurements also satisfy total-token quota rules. Explicit totals take precedence.
 if(usage.tokens===undefined&&(usage.input_tokens!==undefined||usage.output_tokens!==undefined)){const total=(usage.input_tokens??0)+(usage.output_tokens??0);if(!Number.isSafeInteger(total))throw new DomainError('quota_metric_out_of_range');usage.tokens=total;}
 return usage;
}
