import {MutationButton} from './admin-permissions';
import {useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Input} from '@uai/ui/components/input';
import {command} from '../client';
import type {QuotaGroup} from './provider-quotas';
const metrics:Record<string,string>={requests:'Requests',tokens:'Tokens',input_tokens:'Input tokens',output_tokens:'Output tokens',images:'Images',audio_seconds:'Audio seconds',credits:'Provider credits',pages:'Pages',files:'Files',bytes:'Bytes'};
type RuleDraft={rowId:string;key:string;metric:string;window_ms:number;capacity:string;provider_capacity:string};
const period=(ms:number)=>ms===60000?'minute':ms===86400000?'day':`${ms/1000} seconds`;
export function QuotaRuleLimits({group,disabled,onSaved,onEditingChange}:{group:QuotaGroup;disabled:boolean;onSaved:(group:QuotaGroup)=>void;onEditingChange:(editing:boolean)=>void}){
 const [draft,setDraft]=useState<{revision:number;rules:RuleDraft[];reason:string;key:string}|null>(null),[pending,setPending]=useState(false),[error,setError]=useState('');
 const update=(rowId:string,field:keyof RuleDraft,value:string|number)=>setDraft(old=>old?{...old,key:crypto.randomUUID(),rules:old.rules.map(r=>r.rowId===rowId?{...r,[field]:value}:r)}:null);
 async function save(event:React.FormEvent){
  event.preventDefault();if(!draft||pending)return;
  const positive=(s:string)=>/^[1-9]\d{0,15}$/.test(s)&&BigInt(s)<=9007199254740991n;
  if(draft.rules.some(r=>!positive(r.capacity)||(r.provider_capacity!==''&&(!positive(r.provider_capacity)||BigInt(r.capacity)>BigInt(r.provider_capacity))))){setError('Our limit must be positive and no greater than the provider limit.');return}
  if(!draft.rules.length||draft.rules.length>32||new Set(draft.rules.map(r=>r.key.trim())).size!==draft.rules.length||draft.rules.some(r=>!r.key.trim()||!Number.isSafeInteger(r.window_ms)||r.window_ms<1||r.window_ms>86400000)){setError('Use 1–32 distinct rule keys and a window between 0.001 and 86400 seconds.');return}
  const structural=draft.rules.length!==group.rules.length||draft.rules.some(r=>!group.rules.some(old=>old.key===r.key.trim()&&old.metric===r.metric&&old.window_ms===r.window_ms));
  setPending(true);setError('');
  try{
   const saved=await command(structural?'quota_rules_replace':'quota_rule_limits_update',{rules_revision:draft.revision,rules:draft.rules.map(r=>({key:r.key.trim(),capacity:r.capacity,provider_capacity:r.provider_capacity||null,...(structural?{metric:r.metric,window_ms:r.window_ms}:{})})),reason:draft.reason},draft.key,group.id);
   setDraft(null);onEditingChange(false);onSaved(saved);
  }catch(e){setError((e as Error).message)}finally{setPending(false)}
 }
 return <form onSubmit={save} className="mt-4"><fieldset disabled={pending||disabled}>
  <div className="dispatch-capacity-title"><span className="text-sm">Quota rules</span>{!draft&&<MutationButton type="button" size="sm" variant="outline" onClick={()=>{setError('');setDraft({revision:group.rules_revision,rules:group.rules.map(r=>({...r,rowId:crypto.randomUUID(),provider_capacity:r.provider_capacity??''})),reason:'',key:crypto.randomUUID()});onEditingChange(true)}}>Edit rule limits</MutationButton>}</div>
  {draft&&<p className="text-xs text-muted-foreground my-3">Limits can change immediately. Adding, removing or changing a rule requires no pending calls and no quota activity in the last 25 hours.</p>}
  <div className="queue-metrics-scroll"><table aria-label="Provider quota rules"><thead><tr><th>Metric / key</th><th>{draft?'Window, seconds':'Window'}</th><th>Provider limit</th><th>Our limit</th>{draft&&<th><span className="sr-only">Actions</span></th>}</tr></thead><tbody>{(draft?.rules??group.rules).map((rule,index)=>{
   const edit=draft?.rules[index];
   return <tr key={edit?.rowId??rule.key}><td>{edit?<div className="quota-rule-identity"><select aria-label={`Rule metric ${index+1}`} value={edit.metric} onChange={e=>update(edit.rowId,'metric',e.target.value)}>{Object.entries(metrics).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><Input aria-label={`Rule key ${index+1}`} maxLength={200} required value={edit.key} onChange={e=>update(edit.rowId,'key',e.target.value)}/></div>:<>{metrics[rule.metric]??rule.metric}<small>{rule.key}</small></>}</td>
    <td>{edit?<Input aria-label={`Rule window ${index+1}`} type="number" min="0.001" max="86400" step="0.001" required value={edit.window_ms/1000} onChange={e=>update(edit.rowId,'window_ms',Math.round(Number(e.target.value)*1000))}/>:period(rule.window_ms)}</td>
    <td>{edit?<Input aria-label={`Provider limit ${rule.key}`} inputMode="numeric" pattern="[0-9]+" placeholder="Not set" value={edit.provider_capacity} onChange={e=>update(edit.rowId,'provider_capacity',e.target.value)}/>:rule.provider_capacity?Number(rule.provider_capacity).toLocaleString():'Not set'}</td>
    <td>{edit?<Input aria-label={`Our limit ${rule.key}`} required inputMode="numeric" pattern="[0-9]+" value={edit.capacity} onChange={e=>update(edit.rowId,'capacity',e.target.value)}/>:Number(rule.capacity).toLocaleString()}</td>
    {edit&&<td><Button type="button" size="sm" variant="ghost" disabled={draft!.rules.length<=1} aria-label={`Remove rule ${index+1}`} onClick={()=>setDraft(old=>old?{...old,key:crypto.randomUUID(),rules:old.rules.filter(r=>r.rowId!==edit.rowId)}:null)}>Remove</Button></td>}
   </tr>;
  })}</tbody></table></div>
  {draft&&<Button type="button" size="sm" variant="outline" disabled={draft.rules.length>=32} onClick={()=>setDraft(old=>{if(!old)return null;let n=old.rules.length+1;while(old.rules.some(r=>r.key===`rule-${n}`))n++;return {...old,key:crypto.randomUUID(),rules:[...old.rules,{rowId:crypto.randomUUID(),key:`rule-${n}`,metric:'requests',window_ms:60000,capacity:'1',provider_capacity:''}]}})}>Add rule</Button>}
  {draft&&<div className="dispatch-policy-save"><label><span>Reason for change</span><Input aria-label="Rule limits change reason" required value={draft.reason} onChange={e=>setDraft(old=>old?{...old,reason:e.target.value,key:crypto.randomUUID()}:null)}/></label><MutationButton type="submit">{pending?'Saving…':'Save rule limits'}</MutationButton><Button type="button" variant="ghost" onClick={()=>{setDraft(null);setError('');onEditingChange(false)}}>Cancel</Button></div>}
 </fieldset>{error&&<p role="alert" className="text-destructive text-sm mt-3">{error}</p>}</form>;
}
