import {useEffect,useRef,useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {api} from '../client';
import type {QuotaGroup} from './provider-quotas';
type Snapshot={group_id:string;rules_revision:number;status:string;sampled_at:string|null;rules:{key:string;used:string;local_remaining:string;available:string;blocked_until:string|null;provider:{remaining:string;observed_at:string|null;reset_at:string}|null}[]};
const statuses:Record<string,string>={not_ready:'Quota state is being restored.',not_configured:'Quota monitoring is not configured.',no_rules:'No quota rules configured.',configuration_changed:'Quota settings changed. Refresh the group settings.',too_many_events:'The quota journal is too large for this diagnostic view.',invalid_usage:'Quota usage could not be verified.',unavailable:'Quota monitoring is unavailable.'};
const number=(value:string)=>BigInt(value).toLocaleString();
const metrics:Record<string,string>={requests:'Requests',tokens:'Tokens',input_tokens:'Input tokens',output_tokens:'Output tokens',images:'Images',audio_seconds:'Audio seconds',credits:'Provider credits',pages:'Pages',files:'Files',bytes:'Bytes'};
const metric=(value:string)=>metrics[value]??value;
export function QuotaAvailability({group}:{group:QuotaGroup}){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const refresh=useRef(()=>{});
 useEffect(()=>{
  let active=true,busy=false;setSnapshot(null);setError('');
  async function load(){
   if(busy||!active)return;busy=true;setLoading(true);
   try{
    const result:Snapshot=await api('quota_snapshot',group.id);
    if(!active)return;
    if(result.group_id!==group.id||result.rules_revision!==group.rules_revision){setSnapshot(null);setError(statuses.configuration_changed);return}
    setSnapshot(result);setError('');
   }catch{if(active)setError('Unable to refresh quota availability. Displayed values may be outdated.')}
   finally{busy=false;if(active)setLoading(false)}
  }
  refresh.current=()=>{void load()};void load();const timer=setInterval(()=>{void load()},15000);
  return()=>{active=false;clearInterval(timer)};
 },[group.id,group.rules_revision]);
 return <section className="mt-4" aria-label="Quota availability">
  <div className="dispatch-capacity-title"><span className="text-sm">Current availability</span><Button type="button" size="sm" variant="ghost" disabled={loading} onClick={()=>refresh.current()}>{loading?'Refreshing…':'Refresh availability'}</Button></div>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {snapshot?.sampled_at&&<p className="uai-footnote">Checked {new Date(snapshot.sampled_at).toLocaleString()}{error?' · Outdated':''}</p>}
  {snapshot?.status==='ready'?<div className="queue-metrics-scroll"><table aria-label="Quota availability values"><thead><tr><th>Rule</th><th>Used</th><th>Local remaining</th><th>Available now</th><th>Provider observation</th></tr></thead><tbody>{snapshot.rules.map(rule=><tr key={rule.key}>
   <td>{metric(group.rules.find(r=>r.key===rule.key)?.metric??rule.key)}<small>{rule.key}</small></td><td>{number(rule.used)}</td><td>{number(rule.local_remaining)}</td><td>{number(rule.available)}{rule.blocked_until&&<small>Paused until {new Date(rule.blocked_until).toLocaleTimeString()}</small>}</td>
   <td>{rule.provider?<>{number(rule.provider.remaining)}<small>{rule.provider.observed_at?new Date(rule.provider.observed_at).toLocaleString():'Date unavailable'} · resets {new Date(rule.provider.reset_at).toLocaleTimeString()}</small></>:'No active observation'}</td>
  </tr>)}</tbody></table><p className="uai-footnote mt-2">Local estimate. Provider availability includes subsequent local usage. A new request checks quotas again.</p></div>:<p role="status" className="text-muted-foreground text-sm">{snapshot?(statuses[snapshot.status]??statuses.unavailable):loading?'Loading availability…':'No current quota snapshot.'}</p>}
 </section>;
}
