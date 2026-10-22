import type {LimitUsage} from './contracts.js';
import {counter,object} from './usage.js';

/** Only explicit non-negative execution counters, never monetary quantities. */
export function validLimitUsage(value:unknown):LimitUsage|undefined{
 const raw=object(value),result:Record<string,number>={};
 for(const key of ['requests','tokens','input_tokens','output_tokens','images','audio_seconds','credits','pages','files','bytes']){
  if(raw[key]===undefined)continue;
  if(!Number.isSafeInteger(raw[key])||raw[key]<0)return;
  result[key]=raw[key];
 }
 if(result.requests===undefined)return;
 return result as unknown as LimitUsage;
}

/** Raw Responses counters are independent of cache-price attribution. */
export function openAILimitUsage(value:unknown):LimitUsage|undefined{
 const raw=object(value),input=counter(raw.input_tokens),output=counter(raw.output_tokens);
 if(input===null||output===null)return;
 const total=input+output;
 if(total>BigInt(Number.MAX_SAFE_INTEGER))return;
 if(raw.total_tokens!==undefined&&counter(raw.total_tokens)!==total)return;
 return {requests:1,input_tokens:Number(input),output_tokens:Number(output),tokens:Number(total)};
}

/** Anthropic input_tokens excludes both cache categories. */
export function anthropicLimitUsage(value:unknown):LimitUsage|undefined{
 const raw=object(value),input=counter(raw.input_tokens),read=counter(raw.cache_read_input_tokens),write=counter(raw.cache_creation_input_tokens),output=counter(raw.output_tokens);
 if(input===null||read===null||write===null||output===null)return;
 const totalInput=input+read+write,total=totalInput+output;if(total>BigInt(Number.MAX_SAFE_INTEGER))return;
 return {requests:1,input_tokens:Number(totalInput),output_tokens:Number(output),tokens:Number(total)};
}
