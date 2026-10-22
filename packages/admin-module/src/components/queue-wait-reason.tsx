import type {QuotaWaitDetails} from '../../../contracts/src/index.js';
const names:Record<string,string>={requests:'Requests',tokens:'Tokens',input_tokens:'Input tokens',output_tokens:'Output tokens',images:'Images',audio_seconds:'Audio seconds',credits:'Provider credits',pages:'Pages',files:'Files',bytes:'Bytes',concurrency:'Concurrent calls'};
const reasons:Record<string,string>={waiting_rate_limit:'Waiting for provider quota',quota_request_too_large:'Request exceeds quota capacity',quota_not_ready:'Restoring quota state',quota_infrastructure_unavailable:'Waiting for infrastructure',quota_group_missing:'Quota group is not configured',quota_rules_missing:'Quota rules are not configured',quota_metric_estimate_missing:'Quota estimate is unavailable',quota_revision_changed:'Quota settings changed',quota_slot_lost:'Checking quota permission again',requote_required:'Price approval required',provider_recovery_exhausted:'Provider recovery needs attention',deadline_exceeded:'Deadline exceeded',rate_limit_starved:'Never got a provider rate-limit slot',admission_timeout:'Never admitted before the deadline'};
const count=(value:string|null)=>value===null?'Unknown':/^\d+$/.test(value)?BigInt(value).toLocaleString(): 'Unknown';
const period=(ms:number|null)=>ms===null?'':ms===60000?' / minute':ms===3600000?' / hour':ms===86400000?' / day':` / ${ms/1000}s`;
export function QueueWaitReason({reason,status,details}:{reason?:string|null;status:string;details?:QuotaWaitDetails|null}){
 const waiting=['queued','waiting_retry','waiting_recovery','paused'].includes(status);
 const label=reason?reasons[reason]??reason.replaceAll('_',' '):status==='queued'?'Waiting for a worker':status==='leased'?'Preparing request':status==='running'?'Provider is working':status==='submitting'?'Sending request':status==='outcome_unknown'?'Outcome needs recovery':status==='waiting_recovery'?'Recovering provider':'Waiting to retry';
 if(!details||!waiting)return <span title={reason??undefined}>{label}</span>;
 const date=new Date(details.checked_at),validDate=Number.isFinite(date.getTime());
 return <div className="grid min-w-0 gap-1 break-words text-sm" aria-label="Quota wait details">
  <span>{label}</span>
  <span className="text-xs text-muted-foreground" title={details.rule}>{details.group_name} · {names[details.metric]??details.metric}{period(details.window_ms)}</span>
  <span className="text-xs tabular-nums">Needs {count(details.demand)} · Available {count(details.available)} · Limit {count(details.capacity)}</span>
  <span className="text-xs text-muted-foreground">At last check{validDate&&<> · <time dateTime={details.checked_at} title={date.toLocaleString()}>{date.toLocaleTimeString()}</time></>}</span>
 </div>;
}
