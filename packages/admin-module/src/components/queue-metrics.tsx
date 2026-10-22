import {useEffect,useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '@uai/ui/components/card';
import {DataTable} from './data-table';
import {QueueSignal,QueueIcon} from './queue-signal';
import {Clock3,Activity,CircleAlert,RotateCcw} from 'lucide-react';
import {api} from '../client';
interface QueueMetric {queue_kind:string;waiting:number;running:number;active_leases:number;remote_pending:number;paused:number;unknown:number;unsettled_terminal:number;waiting_rate_limit:number;oldest_wait_seconds:number;unpublished_due:number;oldest_unpublished_seconds:number;first_dispatch_wait_p95_ms:number|null;http_observations_24h:number;http_429_observations_24h:number;recovered_execute_deliveries_24h:number;queue_wait_samples_24h:number;ready_queue_wait_p50_ms:number|null;ready_queue_wait_p95_ms:number|null}
interface WorkerHealth {admission_samples:number;admission_p95_ms:number|null;admission_denied:number;admission_errors:number;db_probe_p95_ms:number|null;redis_probe_p95_ms:number|null;db_probe_failures:number;redis_probe_failures:number;queue_kind:string;alive_workers:number;draining_workers:number;stale_workers:number;configured_concurrency:number;active_jobs:number}
interface Snapshot {settlement_errors?:{total_24h:number;domain_24h:number;infrastructure_24h:number};notification_outbox?:{pending:number;oldest_pending_seconds:number};sampled_at:string;data:QueueMetric[];workers?:{scope:'installation';freshness_seconds:number;data:WorkerHealth[]}|null}
const names:Record<string,string>={text:'Text',image:'Images',audio:'Audio',tools:'Tools',observe:'Observation',maintenance:'Maintenance'};
const milliseconds=(value:number|null|undefined)=>value==null?'—':`${Math.round(value*10)/10}ms`;
const duration=(seconds:number)=>seconds<60?`${Math.round(seconds)}s`:`${Math.round(seconds/60)}m`;
export function QueueMetrics(){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(true),[reload,setReload]=useState(0);
 useEffect(()=>{
  let alive=true,busy=false;
  async function load(){
   if(busy)return;busy=true;setPending(true);
   try{const next=await api('execution_metrics');if(alive){setSnapshot(next);setError('')}}
   catch(e){if(alive)setError((e as Error).message)}
   finally{busy=false;if(alive)setPending(false)}
  }
  void load();const timer=setInterval(()=>void load(),15000);
  return()=>{alive=false;clearInterval(timer)};
 },[reload]);
 const total=(key:keyof QueueMetric)=>snapshot?.data.reduce((sum,row)=>sum+Number(row[key]??0),0)??0;
 const attention=total('unknown')+total('paused')+total('unsettled_terminal');
 return <Card className="queue-metrics"><CardHeader><div className="queue-metrics-heading"><div><CardTitle>Queue status</CardTitle><CardDescription>{snapshot?`Updated ${new Date(snapshot.sampled_at).toLocaleTimeString()}`:pending?'Loading queue status…':'Queue status unavailable'}</CardDescription></div><Button size="sm" variant="outline" disabled={pending} onClick={()=>setReload(n=>n+1)}>Refresh status</Button></div></CardHeader><CardContent>
  {error&&<p role="alert" className="text-destructive text-sm mb-3">{snapshot?'Update failed. Showing the last snapshot. ':''}{error}</p>}
  {snapshot&&<><div className="queue-summary" aria-label="Queue summary">
   {[{label:'Waiting',value:total('waiting'),detail:'Ready or scheduled to run',Icon:Clock3,tone:'neutral'},
     {label:'In progress',value:total('running'),detail:'Currently executing',Icon:Activity,tone:'neutral'},
     {label:'Needs attention',value:attention,detail:attention?'Review requests below':'No requests need intervention',Icon:CircleAlert,tone:attention?'negative':'positive'},
     {label:'Restored deliveries',value:total('recovered_execute_deliveries_24h'),detail:'Recovered in the last 24 hours',Icon:RotateCcw,tone:total('recovered_execute_deliveries_24h')?'positive':'neutral'}
   ].map(({label,value,detail,Icon,tone})=><div key={label} className={`queue-summary-item queue-tone-${tone}`}><span className="queue-summary-label"><Icon size={17} aria-hidden="true"/>{label}</span><strong>{value}</strong><small>{detail}</small></div>)}
  </div>
  <div className="queue-section-heading"><h3>Queues by workload</h3><p>Current backlog and execution · latency and HTTP observations over 24 hours</p></div>
  <DataTable label="Queue status" layout="content" compact data={snapshot.data} columns={[
   {title:'Queue',width:150,sortValue:q=>names[q.queue_kind]??q.queue_kind,render:q=><span className="queue-workload"><QueueIcon kind={q.queue_kind}/>{names[q.queue_kind]??q.queue_kind}</span>},
   {title:'Waiting',width:110,key:'waiting',render:q=><><span className="queue-number">{q.waiting}</span>{q.waiting_rate_limit>0&&<small className="queue-tone-negative">{q.waiting_rate_limit} rate limited</small>}</>},
   {title:'In progress',width:110,key:'running',render:q=><span className="queue-number" title={`${q.active_leases} active leases; ${q.remote_pending} remote jobs pending`}>{q.running}</span>},
   {title:'Needs attention',width:210,sortValue:q=>q.unknown+q.paused+q.unsettled_terminal,render:q=>q.unknown+q.paused+q.unsettled_terminal===0?<QueueSignal tone="positive">None</QueueSignal>:<div className="queue-cell-signals">{q.unknown>0&&<QueueSignal tone="negative">{q.unknown} unknown</QueueSignal>}{q.paused>0&&<QueueSignal tone="negative">{q.paused} paused</QueueSignal>}{q.unsettled_terminal>0&&<QueueSignal tone="negative">{q.unsettled_terminal} awaiting settlement</QueueSignal>}</div>},
   {title:'Oldest wait',width:110,sortValue:q=>q.waiting?q.oldest_wait_seconds:undefined,render:q=>q.waiting?duration(q.oldest_wait_seconds):'—'},
   {title:'Not published',width:165,key:'unpublished_due',render:q=><><QueueSignal tone={q.unpublished_due?'negative':'positive'}>{q.unpublished_due}</QueueSignal>{q.unpublished_due>0&&<small>Oldest {duration(q.oldest_unpublished_seconds)}</small>}{q.recovered_execute_deliveries_24h>0&&<small className="queue-tone-positive">{q.recovered_execute_deliveries_24h} restored / 24h</small>}</>},
   {title:'HTTP 429',width:165,sortValue:q=>q.http_observations_24h?q.http_429_observations_24h:undefined,render:q=>q.http_observations_24h>0?<><QueueSignal tone={q.http_429_observations_24h?'negative':'positive'}>{q.http_429_observations_24h}</QueueSignal><small>{q.http_observations_24h} responses / 24h</small></>:<span className="queue-no-data">No HTTP samples</span>},
   {title:'Ready queue, p50 / p95',width:190,sortValue:q=>q.ready_queue_wait_p95_ms,render:q=><span title="Time from scheduled readiness to worker lease; excludes time before Retry-After">{q.ready_queue_wait_p50_ms==null||q.ready_queue_wait_p95_ms==null?<span className="queue-no-data">No samples</span>:<><span>{duration(q.ready_queue_wait_p50_ms/1000)} / {duration(q.ready_queue_wait_p95_ms/1000)}</span><small>{q.queue_wait_samples_24h} deliveries</small></>}</span>},
   {title:'First start, p95',width:140,sortValue:q=>q.first_dispatch_wait_p95_ms,render:q=>q.first_dispatch_wait_p95_ms==null?<span className="queue-no-data">No samples</span>:duration(q.first_dispatch_wait_p95_ms/1000)}
  ]}/>
  <div className="queue-service-signals">
  {snapshot.settlement_errors&&<div title="Recorded settlement failures after transaction rollback; counts failures, not unique requests"><span>Settlement errors / 24h</span><QueueSignal tone={snapshot.settlement_errors.total_24h?'negative':'positive'}>{snapshot.settlement_errors.total_24h? snapshot.settlement_errors.total_24h+' failures':'No errors'}</QueueSignal>{snapshot.settlement_errors.total_24h>0&&<small>Domain {snapshot.settlement_errors.domain_24h} · infrastructure {snapshot.settlement_errors.infrastructure_24h}</small>}</div>}
  {snapshot.notification_outbox&&<div title="Execution events awaiting the notification consumer; webhook delivery is tracked separately"><span>Notification outbox</span><QueueSignal tone={snapshot.notification_outbox.pending?'neutral':'positive'}>{snapshot.notification_outbox.pending? snapshot.notification_outbox.pending+' pending':'Up to date'}</QueueSignal>{snapshot.notification_outbox.pending>0&&<small>Oldest {duration(snapshot.notification_outbox.oldest_pending_seconds)}</small>}</div>}
  </div>
  {snapshot.workers&&<section aria-label="Worker health" className="mt-4"><div className="queue-section-heading"><h3>Worker processes</h3><p>Installation health and occupied execution slots</p></div><div className="worker-heartbeats">{snapshot.workers.data.map(w=><article key={w.queue_kind} aria-label={`${names[w.queue_kind]??w.queue_kind} workers`}>
   <div className="worker-card-heading"><span className="queue-workload"><QueueIcon kind={w.queue_kind}/>{names[w.queue_kind]??w.queue_kind}</span><QueueSignal tone={w.alive_workers===0||w.stale_workers>0||w.admission_errors>0||w.db_probe_failures+w.redis_probe_failures>0?'negative':'positive'}>{w.alive_workers===0?'Offline':w.stale_workers>0||w.admission_errors>0||w.db_probe_failures+w.redis_probe_failures>0?'Check worker':'Online'}</QueueSignal></div><small>{w.alive_workers} alive · {w.active_jobs} active jobs</small><div className="worker-slot-meter" role="meter" aria-label={`${names[w.queue_kind]??w.queue_kind} occupied slots`} aria-valuemin={0} aria-valuemax={Math.max(w.configured_concurrency,w.active_jobs,1)} aria-valuenow={w.active_jobs} aria-valuetext={`${w.active_jobs} active jobs, ${w.configured_concurrency} configured slots`}><span style={{width:`${Math.min(100,w.active_jobs/Math.max(w.configured_concurrency,1)*100)}%`}}/></div><small title="Configured slots exclude draining and stale workers">{w.configured_concurrency} configured slots</small>
   <small>{w.admission_samples>0?`Admission p95 ${milliseconds(w.admission_p95_ms)} · ${w.admission_samples} samples`:'No admission samples'}</small>
   {w.admission_denied>0&&<small className="queue-tone-negative">{w.admission_denied} admission denials</small>}{w.admission_errors>0&&<small className="queue-tone-negative">{w.admission_errors} admission errors</small>}
   <small>Probe p95 · DB {milliseconds(w.db_probe_p95_ms)} · Redis {milliseconds(w.redis_probe_p95_ms)}</small>
   {w.db_probe_failures+w.redis_probe_failures>0&&<small className="queue-tone-negative">Probe failures: DB {w.db_probe_failures}, Redis {w.redis_probe_failures}</small>}
   {w.draining_workers>0&&<small>{w.draining_workers} draining</small>}{w.stale_workers>0&&<small className="queue-tone-negative">{w.stale_workers} stale</small>}
  </article>)}</div><p className="uai-footnote">Heartbeat expires after {snapshot.workers.freshness_seconds}s. Covers all applications in this installation; does not confirm provider availability. Latencies use up to 256 admission samples per live worker from the last 15 minutes and each worker’s latest probes.</p></section>}
  <p className="uai-footnote mt-3">This application · Refreshes every 15 seconds. Latencies cover the last 24 hours. Ready queue excludes scheduled retry delays. First start includes quota and capacity waits.</p></>}
 </CardContent></Card>;
}
