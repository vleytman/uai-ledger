import {MutationButton} from './admin-permissions';
import {QuotaBindings} from './quota-bindings';
import {QuotaCreate} from './quota-create';
import {QuotaRuleLimits} from './quota-rule-limits';
import {QuotaAvailability} from './quota-availability';
import {useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Input} from '@uai/ui/components/input';
import {Card,CardHeader,CardTitle,CardContent} from '@uai/ui/components/card';
import {command} from '../client';
import {modelLabel} from './configuration-labels';

export interface QuotaGroup {interactive_reserve?:number;id:string;name:string;provider:string;source:string;checked_at:string|null;settings_revision:number;rules_revision:number;concurrency_limit:number;held_slots:number;coordination_domain?:string|null;blocked_until:string|null;rules:{key:string;metric:string;capacity:string;provider_capacity?:string|null;window_ms:number}[];bindings:{connection_id:string;connection_name:string;model:string}[]}
export function ProviderQuotas({groups,onSaved,selectedId,onSelect}:{groups:QuotaGroup[];onSaved:(result:QuotaGroup)=>void;selectedId?:string;onSelect?:(id:string)=>void}){
 const [assigning,setAssigning]=useState(false);
 const [creating,setCreating]=useState(false);
 const [editingRules,setEditingRules]=useState(false);
 const [localSelected,setLocalSelected]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState('');
 const [draft,setDraft]=useState<{group_id:string;revision:number;name:string;source:string;concurrency:number;reserve:number;reason:string;key:string}|null>(null);
 const selected=selectedId??localSelected;
 const setSelected=(id:string)=>{setLocalSelected(id);onSelect?.(id)};
 const group=groups.find(g=>g.id===selected)??groups[0];
 const change=(patch:Partial<NonNullable<typeof draft>>)=>setDraft(old=>old?{...old,...patch,key:crypto.randomUUID()}:null);
 async function save(event:React.FormEvent){
  event.preventDefault();if(!draft||!group||pending)return;
  setPending(true);setError('');
  try{
   const saved=await command('quota_settings_update',{settings_revision:draft.revision,settings:{name:draft.name,source:draft.source,checked_at:draft.source===group.source?group.checked_at:null,concurrency_limit:draft.concurrency,interactive_reserve:draft.reserve},reason:draft.reason},draft.key,draft.group_id);
   setDraft(null);onSaved(saved);
  }catch(e){setError((e as Error).message)}finally{setPending(false)}
 }
 return <Card className="provider-quotas"><CardHeader><CardTitle>Provider quotas</CardTitle></CardHeader><CardContent>
  <QuotaCreate disabled={assigning||pending||!!draft||editingRules} onEditingChange={setCreating} onSaved={saved=>{setSelected(saved.id);onSaved(saved)}}/>
  {!creating&&<QuotaBindings groups={groups} disabled={pending||!!draft||editingRules} onEditingChange={setAssigning} onSaved={()=>{if(group)onSaved(group)}}/>}
  {!creating&&!assigning&&(!group?<p className="text-muted-foreground text-sm">No quota groups configured.</p>:<>
   <div className="quota-group-toolbar"><label><span>Quota group</span><select aria-label="Quota group" disabled={pending||!!draft||editingRules} value={group.id} onChange={e=>{setSelected(e.target.value);setError('')}}>{groups.map(g=><option key={g.id} value={g.id}>{g.name} · {g.provider}</option>)}</select></label>
    {!draft&&<MutationButton variant="outline" size="sm" disabled={editingRules} onClick={()=>{setError('');setDraft({group_id:group.id,revision:group.settings_revision,name:group.name,source:group.source,concurrency:group.concurrency_limit,reserve:group.interactive_reserve??1,reason:'',key:crypto.randomUUID()})}}>Edit group settings</MutationButton>}
   </div>
   <p className="uai-footnote mt-2">{group.id} · Rules v{group.rules_revision} · Settings v{group.settings_revision}</p>
   <div className="quota-group-summary"><span>{group.held_slots} / {group.concurrency_limit} slots held</span>{group.blocked_until&&new Date(group.blocked_until)>new Date()&&<span>Paused until {new Date(group.blocked_until).toLocaleString()}</span>}<span>{group.checked_at?`Source checked ${new Date(group.checked_at).toLocaleString()}`:'Source not verified'}</span></div>
   {draft?<form onSubmit={save}><fieldset disabled={pending}><div className="quota-group-fields">
    <label><span>Group name</span><Input aria-label="Group name" required maxLength={200} value={draft.name} onChange={e=>change({name:e.target.value})}/></label>
    <label><span>Concurrent calls</span><Input aria-label="Concurrent calls" type="number" min={1} max={100000} step={1} required value={Number.isNaN(draft.concurrency)?'':draft.concurrency} onChange={e=>change({concurrency:e.target.valueAsNumber})}/></label>
    <label><span>Slots reserved for interactive calls</span><Input aria-label="Interactive reserve" type="number" min={0} max={100000} required value={draft.reserve} onChange={e=>change({reserve:e.target.valueAsNumber})}/></label>
    <label className="quota-group-wide"><span>Source</span><Input aria-label="Quota source" required maxLength={2000} value={draft.source} onChange={e=>change({source:e.target.value})}/></label>
    <label className="quota-group-wide"><span>Reason for change</span><Input aria-label="Quota change reason" required value={draft.reason} onChange={e=>change({reason:e.target.value})}/></label>
   </div><div className="flex gap-2 mt-3"><MutationButton type="submit">{pending?'Saving…':'Save group settings'}</MutationButton><Button variant="ghost" type="button" onClick={()=>{setDraft(null);setError('')}}>Cancel</Button></div></fieldset></form>:<p className="text-muted-foreground text-sm mt-3">{group.source}</p>}
   {error&&<p role="alert" className="text-destructive text-sm mt-3">{error}</p>}
   <QuotaRuleLimits key={group.id} group={group} disabled={!!draft} onSaved={onSaved} onEditingChange={setEditingRules}/>
   <QuotaAvailability key={`${group.id}:${group.rules_revision}`} group={group}/>
   <div className="quota-group-models"><span>Models</span>{group.bindings.length?group.bindings.slice(0,3).map((binding,i)=><span key={`${binding.connection_id}-${binding.model}`} title={binding.connection_name}>{i>0?' · ':''}{modelLabel(binding.model)}</span>):<span className="text-muted-foreground">No models assigned</span>}{group.bindings.length>3&&<span tabIndex={0} title={group.bindings.map(b=>`${modelLabel(b.model)} · ${b.connection_name}`).join('\n')}>+{group.bindings.length-3}</span>}</div>
  </>)}
 </CardContent></Card>;
}
