import type {QuotaStore} from './quota.js';
/** Reset durations are provider relative durations, never arbitrary JavaScript date strings. */
export function resetDuration(value:string|undefined):number|undefined{
 if(!value)return;
 const pattern=/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;let total=0,end=0;
 for(const match of value.matchAll(pattern)){if(match.index!==end)return;end=match.index+match[0].length;total+=Number(match[1])*({ms:1,s:1000,m:60000,h:3600000,d:86400000}[match[2]]!)}
 if(end!==value.length||!Number.isFinite(total)||total>86400000)return;
 return Math.ceil(total);
}
export async function applyQuotaHeaders(store:QuotaStore,rules:Array<{key:string;metric:string;window_ms:number}>,observation:{headers:Record<string,string>;sent_at:string;received_at:string}){
 const sentAt=Date.parse(observation.sent_at),receivedAt=Date.parse(observation.received_at);
 if(!Number.isFinite(sentAt)||!Number.isFinite(receivedAt)||sentAt>receivedAt)return;
 for(const rule of rules){
  // Generic OpenAI minute headers must not overwrite daily or input-only quotas.
  if(rule.window_ms!==60000||!['requests','tokens'].includes(rule.metric))continue;
  const raw=observation.headers[`x-ratelimit-remaining-${rule.metric}`];
  if(raw===undefined||!/^\d+$/.test(raw))continue;
  const remaining=Number(raw),duration=resetDuration(observation.headers[`x-ratelimit-reset-${rule.metric}`]);
  if(!Number.isSafeInteger(remaining)||duration===undefined)continue;
  await store.observe(rule.key,remaining,sentAt,receivedAt+duration,receivedAt);
 }
}
