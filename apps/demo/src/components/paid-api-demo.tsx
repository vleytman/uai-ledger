import {JevDemo} from './jev-demo';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '@uai/ui/components/card';
import {Input} from '@uai/ui/components/input';
import {credits} from '@uai/ui/format';
import {paidApiScenarios} from '../paid-api-settings';
import {ApiResult} from './api-result';
import {RequestDetails} from './request-details';

type Props={api:(body?:unknown)=>Promise<any>;history:any[];refresh:()=>Promise<void>};
const terminal=['succeeded','failed','canceled','refused','outcome_unknown'];
export function PaidApiDemo({api,history,refresh}:Props){
 const [operation,setOperation]=useState<string>('scrape'),[value,setValue]=useState<string>(paidApiScenarios[0].example);
 const [state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[quote,setQuote]=useState<any>(null),[key,setKey]=useState('');
 const revision=useRef(0),loaded=useRef(0);
 const load=async()=>{const seq=++loaded.current;try{const next=await api({action:'api_status'});if(seq===loaded.current)setState(next)}catch(e){if(seq===loaded.current)setError((e as Error).message)}};
 useEffect(()=>{void load()},[history]);
 const invalidate=()=>{revision.current++;setQuote(null);setKey('')};
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}};
 const scenario=paidApiScenarios.find(s=>s.operation===operation)!;
 const metric=state?.allowance?.metrics?.find((m:any)=>m.metric==='credits');
 const rows=history.filter(row=>state?.profiles?.some((p:any)=>p.profile===row.profile));
 return <div className="space-y-6">
  <JevDemo api={api} history={history} refresh={refresh}/>
  <Card><CardHeader><CardTitle>Firecrawl: страницы, поиск и патенты</CardTitle><CardDescription>Настоящие API-запросы. Сначала рассчитайте цену, затем подтвердите запуск. Деньги с карты demo не списывает.</CardDescription></CardHeader><CardContent className="space-y-4">
   {error&&<p role="alert" className="text-destructive">{error}</p>}
   {state?.enabled===false?<p>API-demo ещё не настроено. Запустите локальную настройку Firecrawl.</p>:<>
    <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2"><span className="block text-sm font-medium">Операция</span><select aria-label="API-операция" className="w-full rounded-lg border bg-card p-2" disabled={busy} value={operation} onChange={e=>{setOperation(e.target.value);setValue(paidApiScenarios.find(s=>s.operation===e.target.value)!.example);invalidate()}}>{paidApiScenarios.map(s=><option key={s.operation} value={s.operation}>{s.label}</option>)}</select></label><label className="space-y-2"><span className="block text-sm font-medium">{scenario.field}</span><Input aria-label={scenario.field} disabled={busy} value={value} onChange={e=>{setValue(e.target.value);invalidate()}}/></label></div>
    <p className="text-sm text-muted-foreground">{scenario.hint}</p>
    <p className="text-sm">Цена в тестовом кошельке: 1 кредит за вызов + 1 кредит за каждый credit Firecrawl. Это демонстрационная цена приложения.</p>
    <Button disabled={busy||!value.trim()||!state?.enabled} onClick={()=>void run(async()=>{const current=revision.current;const next=await api({action:'api_quote',operation,value,key:crypto.randomUUID()});if(current===revision.current){setQuote(next);setKey(crypto.randomUUID())}})}>Рассчитать API-запрос</Button>
    {quote&&<div className="space-y-3 rounded-lg border bg-muted p-4"><p>Резерв до <strong>{credits(quote.max_units)} тестовых кр.</strong> Итог по фактическому расходу, не выше принятого максимума.</p><p className="text-sm">Расчёт цены не вызывает Firecrawl. Кнопка ниже выполняет платный запрос.</p><Button disabled={busy} onClick={()=>void run(async()=>{await api({action:'invoke',quote_id:quote.id,prompt:`${scenario.label}: ${value}`,key});invalidate();await refresh();await load()})}>Подтвердить и вызвать Firecrawl</Button><p className="text-xs text-muted-foreground">Оценка действует до {new Date(quote.expires_at).toLocaleTimeString('ru')}.</p></div>}
   </>}
  </CardContent></Card>
  <Card><CardHeader><CardTitle>Квота Firecrawl для demo</CardTitle><CardDescription>Отдельный лимит этой установки. Он не равен общему остатку аккаунта Firecrawl.</CardDescription></CardHeader><CardContent>
   {metric?<><dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">{[['Доступно',metric.available],['Потрачено',metric.consumed],['В резерве',metric.reserved],['Лимит периода',metric.included]].map(([label,amount])=><div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-xl font-semibold">{amount} <small className="text-xs font-normal">credits</small></dd></div>)}</dl><p className="mt-4 text-sm text-muted-foreground">Период: {new Date(state.allowance.period_start).toLocaleDateString('ru')} — {new Date(state.allowance.period_end).toLocaleDateString('ru')}. При нехватке квоты новый вызов не отправляется.</p></>:<p className="text-sm text-muted-foreground">{state?.enabled===false?'Квота не подключена.':'Получаем остаток квоты…'}</p>}
   <Button className="mt-3" variant="outline" disabled={busy} onClick={()=>void run(async()=>{for(const row of rows.filter(r=>!terminal.includes(r.status)))await api({action:'refresh',id:row.id});await refresh();await load()})}>Обновить квоту и результаты</Button>
  </CardContent></Card>
  <section aria-label="Результаты API" className="space-y-4"><h2 className="text-xl font-semibold">Результаты API</h2>{!rows.length&&<p className="text-muted-foreground">Запустите один из примеров. Здесь появятся ответ и расход.</p>}{rows.map(row=><Card key={row.id}><CardHeader><CardTitle>{row.title}</CardTitle><CardDescription>{({succeeded:'Готово',queued:'В очереди',paused:'Нужно решение администратора',waiting_retry:'Ожидание лимита или повтора',waiting_recovery:'Восстановление провайдера',running:'Выполняется',submitting:'Отправляется',failed:'Ошибка',canceled:'Отменено',outcome_unknown:'Исход уточняется; не повторяйте запрос'} as Record<string,string>)[row.status]??row.status}{row.operation?.captured_units?` · Списано ${credits(row.operation.captured_units)} тестовых кр.`:''}</CardDescription></CardHeader><CardContent>{row.result?.content?.text&&<ApiResult text={row.result.content.text}/>}{row.diagnostics&&<RequestDetails diagnostics={row.diagnostics}/>}<Button variant="outline" className="mt-3" disabled={busy} onClick={()=>void run(async()=>{await api({action:'refresh',id:row.id});await refresh();await load()})}>Получить результат</Button>{!terminal.includes(row.status)&&<Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{await api({action:'cancel',id:row.id});await refresh();await load()})}>Отменить запрос</Button>}</CardContent></Card>)}</section>
 </div>;
}
