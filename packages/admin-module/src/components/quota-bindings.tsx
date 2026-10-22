import {MutationButton} from './admin-permissions';
import {useEffect,useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Input} from '@uai/ui/components/input';
import {api,command} from '../client';
import {modelLabel} from './configuration-labels';
import type {QuotaGroup} from './provider-quotas';
interface Connection {id:string;name:string;provider:string}
interface Model {id:string;provider:string;status:string}
interface Catalog {status:string;payload:{models:Model[]}}
interface BindingSnapshot {connection_id:string;model:string;bindings_revision:string;groups:{id:string;name:string;provider:string;coordination_domain:string|null}[]}
const rows=<T,>(value:T[]|{data:T[]}):T[]=>Array.isArray(value)?value:value.data;
export function QuotaBindings({groups,disabled,onSaved,onEditingChange}:{groups:QuotaGroup[];disabled:boolean;onSaved:()=>void;onEditingChange:(value:boolean)=>void}){
 const [open,setOpen]=useState(false),[connections,setConnections]=useState<Connection[]>([]),[models,setModels]=useState<Model[]>([]);
 const [connection,setConnection]=useState(''),[model,setModel]=useState(''),[snapshot,setSnapshot]=useState<BindingSnapshot|null>(null);
 const [selected,setSelected]=useState<string[]>([]),[reason,setReason]=useState(''),[key,setKey]=useState('');
 const [loadingOptions,setLoadingOptions]=useState(false),[loadingBindings,setLoadingBindings]=useState(false),[pending,setPending]=useState(false),[reload,setReload]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{
  if(!open)return;let cancelled=false;setLoadingOptions(true);setError('');
  Promise.all([api('providers'),api('models')]).then(([providers,catalogs])=>{
   if(cancelled)return;
   setConnections(rows<Connection>(providers));setModels(rows<Catalog>(catalogs).filter(c=>c.status==='published').flatMap(c=>c.payload.models).filter(m=>m.status==='active'));
  }).catch(e=>{if(!cancelled)setError((e as Error).message)}).finally(()=>{if(!cancelled)setLoadingOptions(false)});
  return()=>{cancelled=true};
 },[open]);
 useEffect(()=>{
  if(!open||!connection||!model)return;let cancelled=false;setLoadingBindings(true);setSnapshot(null);setError('');setNotice('');
  api('quota_bindings',undefined,{connection_id:connection,model}).then((value:BindingSnapshot)=>{
   if(cancelled)return;
   if(value.connection_id!==connection||value.model!==model)throw new Error('Quota bindings do not match the selected model. Reload them.');
   setSnapshot(value);setSelected(value.groups.map(g=>g.id));setReason('');setKey(crypto.randomUUID());
  }).catch(e=>{if(!cancelled)setError((e as Error).message)}).finally(()=>{if(!cancelled)setLoadingBindings(false)});
  return()=>{cancelled=true};
 },[open,connection,model,reload]);
 const provider=connections.find(c=>c.id===connection)?.provider;
 const choices=[...new Set([...models.filter(m=>m.provider===provider).map(m=>m.id),...groups.flatMap(g=>g.bindings.filter(b=>b.connection_id===connection).map(b=>b.model))])].sort((a,b)=>modelLabel(a).localeCompare(modelLabel(b)));
 const available=[...new Map([...groups,...(snapshot?.groups??[])].filter(g=>g.provider===provider).map(g=>[g.id,g])).values()];
 const reset=()=>{setSnapshot(null);setSelected([]);setNotice('');setError('');setReason('')};
 async function save(event:React.FormEvent){
  event.preventDefault();if(!snapshot||pending||loadingBindings)return;setPending(true);setError('');setNotice('');
  try{
   const saved:BindingSnapshot=await command('quota_bindings_update',{connection_id:connection,model,bindings_revision:snapshot.bindings_revision,group_ids:selected,reason},key);
   setSnapshot(saved);setSelected(saved.groups.map(g=>g.id));setKey(crypto.randomUUID());setReason('');setNotice('Model quota groups saved.');onSaved();
  }catch(e){setError((e as Error).message)}finally{setPending(false)}
 }
 if(!open)return <MutationButton size="sm" variant="outline" disabled={disabled||!groups.length} onClick={()=>{setOpen(true);onEditingChange(true)}}>Assign models</MutationButton>;
 return <section aria-label="Model quota assignments" className="space-y-3 mt-3">
  <div className="flex items-center justify-between gap-2"><span className="text-sm">Model quota assignments</span><Button size="sm" variant="ghost" disabled={pending} onClick={()=>{setOpen(false);onEditingChange(false);reset();setConnection('');setModel('')}}>Close assignments</Button></div>
  {loadingOptions?<p role="status">Loading connections and models…</p>:<div className="quota-group-fields">
   <label><span>Connection</span><select aria-label="Quota connection" disabled={pending} value={connection} onChange={e=>{reset();setConnection(e.target.value);setModel('')}}><option value="">Choose connection</option>{connections.map(c=><option key={c.id} value={c.id}>{c.name} · {c.provider}</option>)}</select></label>
   <label><span>Model</span><select aria-label="Quota model" disabled={pending||!connection} value={model} onChange={e=>{reset();setModel(e.target.value)}}><option value="">Choose model</option>{choices.map(value=><option key={value} value={value}>{modelLabel(value)}</option>)}</select></label>
  </div>}
  {loadingBindings&&connection&&model&&<p role="status">Loading model quota groups…</p>}
  {snapshot&&<form onSubmit={save}><fieldset disabled={pending||loadingBindings} className="space-y-3">
   <div className="grid gap-2">{available.map(group=><label key={group.id} className="quota-assignment-option"><input type="checkbox" aria-label={`Assign ${group.name}`} checked={selected.includes(group.id)} onChange={e=>{setSelected(old=>e.target.checked?[...old,group.id]:old.filter(id=>id!==group.id));setKey(crypto.randomUUID());setNotice('')}}/><span>{group.name}</span><span className="text-muted-foreground" title={group.coordination_domain??undefined}>{group.coordination_domain??'Independent quota'}</span></label>)}</div>
   {!selected.length&&<p className="text-sm text-muted-foreground">No groups selected. New requests for this connection and model will wait for quota configuration.</p>}
   <p className="text-sm text-muted-foreground">Groups checked together must share a domain. A group with recent usage or held calls cannot be removed yet.</p>
   <label className="block"><span>Reason for change</span><Input aria-label="Quota assignment reason" required value={reason} onChange={e=>{setReason(e.target.value);setKey(crypto.randomUUID())}}/></label>
   <MutationButton type="submit" disabled={selected.length>16}>{pending?'Saving…':'Save assignments'}</MutationButton>{selected.length>16&&<p role="alert">Choose at most 16 groups.</p>}
  </fieldset></form>}
  {connection&&model&&!pending&&<Button size="sm" variant="ghost" disabled={loadingBindings} onClick={()=>{reset();setReload(n=>n+1)}}>Reload assignments</Button>}
  {notice&&<p role="status" className="text-sm">{notice}</p>}{error&&<p role="alert" className="text-destructive text-sm">{error}</p>}
 </section>;
}
