import {QueueSignal} from './queue-signal';
import {MutationButton} from './admin-permissions';
import {useEffect,useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Input} from '@uai/ui/components/input';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '@uai/ui/components/card';
import {api,command} from '../client';
interface Policy {account_limit:number;application_limit:number;max_queue_age_ms:number;revision:number;enabled:boolean}
export function AdmissionPolicy(){
 const [policy,setPolicy]=useState<Policy|null>(null),[draft,setDraft]=useState<{account:number;application:number;minutes:number;reason:string;key:string}|null>(null),[pending,setPending]=useState(false),[error,setError]=useState('');
 const load=async()=>{setPending(true);setError('');try{setPolicy(await api('admission_policy'));setDraft(null)}catch(e){setError((e as Error).message)}finally{setPending(false)}};
 useEffect(()=>{let active=true;api('admission_policy').then(p=>{if(active)setPolicy(p)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[]);
 const change=(value:Partial<NonNullable<typeof draft>>)=>{setError('');setDraft(old=>old?{...old,...value,key:crypto.randomUUID()}:null)};
 async function save(event:React.FormEvent){
  event.preventDefault();if(!draft||!policy||pending)return;
  const age=Math.round(draft.minutes*60000);
  if(!Number.isSafeInteger(draft.account)||!Number.isSafeInteger(draft.application)||draft.account<1||draft.account>100000||draft.application<draft.account||draft.application>1000000||!Number.isSafeInteger(age)||age<1000||age>86400000){setError('Use account ≤ application, and a queue age between 1 second and 24 hours.');return}
  setPending(true);setError('');
  try{const result=await command('admission_policy_update',{revision:policy.revision,settings:{account_limit:draft.account,application_limit:draft.application,max_queue_age_ms:age},reason:draft.reason},draft.key);setPolicy(result);setDraft(null)}catch(e){setError((e as Error).message)}finally{setPending(false)}
 }
 const fields=[['account','Per account',policy?.account_limit,1,100000],['application','Per application',policy?.application_limit,1,1000000],['minutes','Oldest queued task, min',policy?policy.max_queue_age_ms/60000:0,1/60,1440]] as const;
 return <Card className="admission-policy"><CardHeader><CardTitle>Accepting new work</CardTitle><CardDescription>Limits for this application. New operations are rejected when these limits are reached, before reserving credits.</CardDescription></CardHeader><CardContent>
  <div className="dispatch-capacity-title"><QueueSignal tone={policy?(policy.enabled?'positive':'neutral'):error?'negative':'neutral'}>{policy?(policy.enabled?`Enabled · Revision ${policy.revision}`:'Not enabled · Suggested limits'):error?'Limits unavailable':'Loading limits…'}</QueueSignal><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={pending} onClick={()=>void load()}>Reload limits</Button>{policy&&(draft?<Button variant="ghost" disabled={pending} onClick={()=>{setDraft(null);setError('')}}>Cancel</Button>:<MutationButton size="sm" variant="outline" disabled={pending} onClick={()=>setDraft({account:policy.account_limit,application:policy.application_limit,minutes:policy.max_queue_age_ms/60000,reason:'',key:crypto.randomUUID()})}>{policy.enabled?'Edit admission limits':'Enable admission limits'}</MutationButton>)}</div></div>
  {policy&&<form onSubmit={save}><fieldset disabled={pending}><div className={draft?"dispatch-capacity-grid":"admission-limit-summary"}><span className="text-muted-foreground text-sm">Waiting tasks</span>{fields.map(([key,label,value,min,max])=>draft?<label key={key}><span>{label}</span><Input aria-label={label} type="number" min={min} max={max} step={key==='minutes'?'any':1} required value={Number.isNaN(draft[key])?'':draft[key]} onChange={e=>change({[key]:e.target.valueAsNumber})}/></label>:<div key={key}><small>{label}</small><span>{value}</span></div>)}</div>{draft&&<div className="dispatch-policy-save"><label><span>Reason for change</span><Input aria-label="Admission change reason" required value={draft.reason} onChange={e=>change({reason:e.target.value})}/></label><MutationButton type="submit">{pending?'Saving…':'Save admission limits'}</MutationButton></div>}</fieldset></form>}
  {error&&<p role="alert" className="text-destructive text-sm mt-2">{error}</p>}
 </CardContent></Card>;
}
