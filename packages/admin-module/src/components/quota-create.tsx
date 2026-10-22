import {MutationButton} from './admin-permissions';
import {openaiTier4QuotaTemplates,typesafeQuotaTemplate} from '../../../contracts/src/quota-templates.js';
import {useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Input} from '@uai/ui/components/input';
import {command} from '../client';
import type {QuotaGroup} from './provider-quotas';
const templates=[...openaiTier4QuotaTemplates,typesafeQuotaTemplate];
const metrics={requests:'Requests',input_tokens:'Input tokens',output_tokens:'Output tokens',tokens:'Total tokens',images:'Images',audio_seconds:'Audio seconds',credits:'Provider credits',pages:'Pages',files:'Files',bytes:'Bytes'};
interface Rule {key:string;metric:string;capacity:string;provider_capacity:string;window_ms:number}
const initialRule=():Rule=>({key:'rpm',metric:'requests',capacity:'',provider_capacity:'',window_ms:60000});
export function QuotaCreate({disabled,onSaved,onEditingChange}:{disabled:boolean;onSaved:(group:QuotaGroup)=>void;onEditingChange:(editing:boolean)=>void}){
 const [draft,setDraft]=useState<{template:string;checked_at:string|null;name:string;provider:string;source:string;concurrency:number;account:string;project:string;domain:string;reason:string;rules:Rule[];key:string}|null>(null),[pending,setPending]=useState(false),[error,setError]=useState('');
 const change=(patch:Partial<NonNullable<typeof draft>>)=>setDraft(old=>old?{...old,...(('rules' in patch||'source' in patch||'provider' in patch)?{checked_at:null}:{}),...patch,key:crypto.randomUUID()}:null);
 const updateRule=(index:number,patch:Partial<Rule>)=>{if(draft)change({rules:draft.rules.map((rule,i)=>i===index?{...rule,...patch}:rule)})};
 async function save(event:React.FormEvent){
  event.preventDefault();if(!draft||pending)return;
  const positive=(value:string)=>/^[1-9]\d{0,15}$/.test(value)&&BigInt(value)<=9007199254740991n;
  if(new Set(draft.rules.map(rule=>rule.key.trim())).size!==draft.rules.length||draft.rules.some(rule=>!rule.key.trim()||!positive(rule.capacity)||(rule.provider_capacity!==''&&(!positive(rule.provider_capacity)||BigInt(rule.capacity)>BigInt(rule.provider_capacity))))){setError('Use distinct rule keys and positive limits. Our limit cannot exceed the provider limit.');return}
  setPending(true);setError('');
  try{
   const saved=await command('quota_group_create',{group:{name:draft.name,provider:draft.provider,source:draft.source,checked_at:draft.checked_at,concurrency_limit:draft.concurrency,scope:{...(draft.account.trim()?{provider_account:draft.account.trim()}:{}),...(draft.project.trim()?{provider_project:draft.project.trim()}:{})},coordination_domain:draft.domain.trim()||null,rules:draft.rules.map(rule=>({...rule,key:rule.key.trim(),provider_capacity:rule.provider_capacity||null}))},reason:draft.reason},draft.key);
   setDraft(null);onEditingChange(false);onSaved(saved);
  }catch(e){setError((e as Error).message)}finally{setPending(false)}
 }
 if(!draft)return <MutationButton variant="outline" size="sm" disabled={disabled} onClick={()=>{setError('');setDraft({template:'',checked_at:null,name:'',provider:'openai',source:'',concurrency:8,account:'',project:'',domain:'',reason:'',rules:[initialRule()],key:crypto.randomUUID()});onEditingChange(true)}}>New quota group</MutationButton>;
 return <form onSubmit={save} aria-label="New quota group"><fieldset disabled={pending} className="space-y-3">
  <label className="block"><span>Start from template</span><select aria-label="Quota template" value={draft.template} onChange={e=>{
   const template=templates.find(t=>t.id===e.target.value);
   if(!template){change({template:'',checked_at:null});return}
   change({template:template.id,name:template.name,provider:template.provider,source:template.source,checked_at:template.checked_at,rules:template.rules.map(rule=>({...rule}))});
  }}><option value="">Custom</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
  {draft.template&&<p className="text-sm text-muted-foreground">Public baseline. Confirm account limits and shared groups before assigning models. Concurrent calls is our local setting. Model IDs: {templates.find(t=>t.id===draft.template)?.models.join(', ')}.</p>}
  <div className="quota-group-fields">
   <label><span>Group name</span><Input aria-label="New group name" required maxLength={200} value={draft.name} onChange={e=>change({name:e.target.value})}/></label>
   <label><span>Provider</span><Input aria-label="New group provider" required maxLength={100} value={draft.provider} onChange={e=>change({provider:e.target.value})}/></label>
   <label><span>Concurrent calls</span><Input aria-label="New group concurrent calls" required type="number" min={1} max={100000} step={1} value={Number.isNaN(draft.concurrency)?'':draft.concurrency} onChange={e=>change({concurrency:e.target.valueAsNumber})}/></label>
   <label><span>Provider account</span><Input aria-label="Provider account" maxLength={200} value={draft.account} onChange={e=>change({account:e.target.value})}/></label>
   <label><span>Provider project</span><Input aria-label="Provider project" maxLength={200} value={draft.project} onChange={e=>change({project:e.target.value})}/></label>
   <label><span>Shared quota domain</span><Input aria-label="Shared quota domain" maxLength={200} value={draft.domain} onChange={e=>change({domain:e.target.value})}/></label>
   <label className="quota-group-wide"><span>Source</span><Input aria-label="New group source" required maxLength={2000} value={draft.source} onChange={e=>change({source:e.target.value})}/></label>
  </div>
  <p className="text-sm text-muted-foreground">Use the same domain for groups checked together against one provider account. New groups have no models assigned.</p>
  <div className="queue-metrics-scroll"><table aria-label="New quota rules"><thead><tr><th>Metric</th><th>Window</th><th>Provider limit</th><th>Our limit</th><th>Rule key</th><th/></tr></thead><tbody>{draft.rules.map((rule,index)=><tr key={index}>
   <td><select aria-label={`Metric ${index+1}`} value={rule.metric} onChange={e=>updateRule(index,{metric:e.target.value})}>{Object.entries(metrics).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></td>
   <td><select aria-label={`Window ${index+1}`} value={rule.window_ms} onChange={e=>updateRule(index,{window_ms:Number(e.target.value)})}>{[[1000,'Second'],[60000,'Minute'],[3600000,'Hour'],[86400000,'Day']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></td>
   <td><Input aria-label={`New provider limit ${index+1}`} inputMode="numeric" pattern="[0-9]+" placeholder="Not set" value={rule.provider_capacity} onChange={e=>updateRule(index,{provider_capacity:e.target.value})}/></td>
   <td><Input aria-label={`New local limit ${index+1}`} required inputMode="numeric" pattern="[0-9]+" value={rule.capacity} onChange={e=>updateRule(index,{capacity:e.target.value})}/></td>
   <td><Input aria-label={`Rule key ${index+1}`} required maxLength={200} value={rule.key} onChange={e=>updateRule(index,{key:e.target.value})}/></td>
   <td><Button type="button" variant="ghost" size="sm" aria-label={`Remove rule ${index+1}`} disabled={draft.rules.length===1} onClick={()=>change({rules:draft.rules.filter((_,i)=>i!==index)})}>Remove</Button></td>
  </tr>)}</tbody></table></div>
  <Button type="button" variant="outline" size="sm" disabled={draft.rules.length>=32} onClick={()=>change({rules:[...draft.rules,{...initialRule(),key:`rule-${crypto.randomUUID().slice(0,8)}`} ]})}>Add rule</Button>
  <label className="block"><span>Reason for change</span><Input aria-label="New group reason" required value={draft.reason} onChange={e=>change({reason:e.target.value})}/></label>
  <div className="flex gap-2"><MutationButton type="submit">{pending?'Creating…':'Create quota group'}</MutationButton><Button type="button" variant="ghost" onClick={()=>{setDraft(null);setError('');onEditingChange(false)}}>Cancel</Button></div>
 </fieldset>{error&&<p role="alert" className="text-destructive text-sm mt-3">{error}</p>}</form>;
}
