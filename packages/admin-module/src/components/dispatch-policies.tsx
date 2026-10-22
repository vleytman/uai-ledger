import {DataTable} from './data-table';
import {QueueSignal,QueueIcon} from './queue-signal';
import {MutationButton} from './admin-permissions';
import {useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Input} from '@uai/ui/components/input';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '@uai/ui/components/card';
import {command} from '../client';
interface Policy {interactive_reserve?:number;queue_kind:string;account_limit:number;application_limit:number;queue_limit:number;active_account_limit?:number;active_application_limit?:number;active_queue_limit?:number;revision:number}
const names:Record<string,string>={text:'Text',image:'Images',audio:'Audio',tools:'Tools',observe:'Job monitoring',maintenance:'Maintenance'};
const waitingFields=[['account_limit','Per account'],['application_limit','Per application'],['queue_limit','Whole queue']] as const;
const activeFields=[['active_account_limit','Per account'],['active_application_limit','Per application'],['active_queue_limit','Whole queue']] as const;
const generation=(kind:string)=>['text','image','audio','tools'].includes(kind);
export function DispatchPolicies({policies,onSaved}:{policies:Policy[];onSaved:(result:unknown)=>void}){
 const [draft,setDraft]=useState<(Policy&{reason:string;key:string})|null>(null),[pending,setPending]=useState(false),[error,setError]=useState('');
 const edit=(policy:Policy)=>{setDraft({...policy,reason:'',key:crypto.randomUUID()});setError('')};
 const change=(values:Partial<NonNullable<typeof draft>>)=>{setError('');setDraft(old=>old?{...old,...values,key:crypto.randomUUID()}:null)};
 async function save(event:React.FormEvent){
  event.preventDefault();if(!draft||pending)return;
  const groups=generation(draft.queue_kind)?[waitingFields,activeFields]:[waitingFields];
  for(const fields of groups){const values=fields.map(([key])=>draft[key]);if(values.some(n=>!Number.isSafeInteger(n)||n!<1||n!>100000)||values[0]!>values[1]!||values[1]!>values[2]!){setError('Use account ≤ application ≤ whole queue, from 1 to 100000.');return}}
  setPending(true);setError('');
  try{const {interactive_reserve,account_limit,application_limit,queue_limit,active_account_limit,active_application_limit,active_queue_limit}=draft;
   const settings={interactive_reserve,account_limit,application_limit,queue_limit,...(generation(draft.queue_kind)?{active_account_limit,active_application_limit,active_queue_limit}:{})};
   const result=await command('dispatch_policy_update',{revision:draft.revision,settings,reason:draft.reason},draft.key,draft.queue_kind);setDraft(null);onSaved(result);
  }catch(e){setError((e as Error).message)}finally{setPending(false)}
 }
 return <Card className="queue-capacity"><CardHeader><CardTitle>Queue capacity</CardTitle><CardDescription>Limit running tasks separately from jobs delivered to the queue. Lowering a limit does not interrupt work already started.</CardDescription></CardHeader><CardContent>
  <div className="capacity-policy-list">{policies.map(policy=>{const editing=draft?.queue_kind===policy.queue_kind,enabled=generation(policy.queue_kind),ready=!enabled||activeFields.every(([key])=>Number.isSafeInteger(policy[key]));
   const limits=(title:string,fields:typeof waitingFields|typeof activeFields)=><div className="dispatch-capacity-grid"><span className="text-muted-foreground text-sm">{title}</span>{fields.map(([key,label])=>editing?<label key={key}><span>{label}</span><Input aria-label={`${title}: ${label}`} type="number" min={1} max={100000} step={1} required value={draft[key]??''} onChange={event=>change({[key]:event.target.valueAsNumber})}/></label>:<div key={key}><small>{label}</small><span>{policy[key]??'Unavailable'}</span></div>)}</div>;
   return <section key={policy.queue_kind} className="dispatch-policy" aria-label={`${names[policy.queue_kind]??policy.queue_kind} queue`}>
    <div className="dispatch-capacity-title"><div className="queue-workload"><QueueIcon kind={policy.queue_kind}/><div>{names[policy.queue_kind]??policy.queue_kind}<small>{policy.queue_kind==='maintenance'?'One maintenance cycle at a time':`Revision ${policy.revision}`}</small></div></div><QueueSignal tone={ready?'positive':'negative'}>{ready?'Configured':'Limits unavailable'}</QueueSignal>{editing?<Button disabled={pending} type="button" variant="ghost" onClick={()=>{setDraft(null);setError('')}}>Cancel</Button>:<MutationButton size="sm" variant="outline" disabled={!!draft||policy.queue_kind==='maintenance'||!ready} onClick={()=>edit(policy)} aria-label={`Edit ${names[policy.queue_kind]??policy.queue_kind} queue`}>Edit</MutationButton>}</div>
    {policy.queue_kind!=='maintenance'&&(editing?<form onSubmit={save}><fieldset disabled={pending}>
     {enabled&&limits('Running tasks',activeFields)}{enabled&&<label><span>Slots reserved for interactive calls</span><Input aria-label="Interactive reserve" type="number" min={0} max={100000} required value={draft.interactive_reserve??1} onChange={e=>change({interactive_reserve:e.target.valueAsNumber})}/></label>}{limits(enabled?'Published jobs':'Concurrent checks',waitingFields)}
     <div className="dispatch-policy-save"><label><span>Reason for change</span><Input required value={draft.reason} onChange={event=>change({reason:event.target.value})} placeholder="Why are these limits changing?"/></label><MutationButton type="submit">{pending?'Saving…':'Save limits'}</MutationButton></div>
     {error&&<p role="alert" className="text-destructive text-sm mt-2">{error}</p>}
    </fieldset></form>:<><DataTable compact label={`${names[policy.queue_kind]??policy.queue_kind} capacity`} layout="content" data={[...(enabled?[{kind:'Running tasks',account:policy.active_account_limit,application:policy.active_application_limit,queue:policy.active_queue_limit}]:[]),{kind:enabled?'Published jobs':'Concurrent checks',account:policy.account_limit,application:policy.application_limit,queue:policy.queue_limit}]} columns={[{title:'Limit',key:'kind'},{title:'Per account',key:'account',render:r=>r.account??<QueueSignal tone="negative">Unavailable</QueueSignal>},{title:'Per application',key:'application',render:r=>r.application??<QueueSignal tone="negative">Unavailable</QueueSignal>},{title:'Whole queue',key:'queue',render:r=>r.queue??<QueueSignal tone="negative">Unavailable</QueueSignal>}]}/>{enabled&&<small>Interactive reserve: {policy.interactive_reserve??1} slots per queue, application and account; at least one background slot remains available.</small>}{!ready&&<small className="queue-tone-negative">Apply database migrations to configure running tasks.</small>}</>)}
   </section>;
  })}</div>
  <p className="text-muted-foreground text-sm mt-4">Provider rate limits and concurrency of each worker process are configured separately.</p>
 </CardContent></Card>;
}
