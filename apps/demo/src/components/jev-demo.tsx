import {credits} from '@uai/ui/format';
import {useEffect,useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Card,CardContent,CardHeader,CardTitle,CardDescription} from '@uai/ui/components/card';
import {jevExample} from '../jev-settings';
import {ApiResult} from './api-result';
export function JevDemo({api,history,refresh}:{api:(body?:unknown)=>Promise<any>;history:any[];refresh:()=>Promise<void>}){
 const [state,setState]=useState<any>(null),[input,setInput]=useState(JSON.stringify(jevExample,null,2)),[quote,setQuote]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[key,setKey]=useState('');
 useEffect(()=>{void api({action:'jev_status'}).then(setState).catch(e=>setError(e.message));},[]);
 async function action(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <Card><CardHeader><CardTitle>Jev: пакет вопросов</CardTitle><CardDescription>Один запрос с Noul, Choice и Score. Низкая уверенность остаётся результатом.</CardDescription></CardHeader><CardContent className="space-y-4">
 <p>{state?.enabled?(state.fixture?'Локальная проверка с тестовыми ответами. TypeSafe не вызывается.':'Подключён профиль Jev.'):'Профиль Jev не подключён к demo.'}</p>
 <label className="block space-y-2"><span>Состояние и вопросы</span><textarea aria-label="Jev JSON" className="min-h-64 w-full rounded-lg border bg-card p-3 font-mono text-sm" value={input} disabled={busy} onChange={e=>{setInput(e.target.value);setQuote(null)}}/></label>
 {error&&<p role="alert">{error}</p>}
 <Button disabled={busy||!state?.enabled} onClick={()=>void action(async()=>{setQuote(await api({action:'jev_quote',input:JSON.parse(input),key:crypto.randomUUID()}));setKey(crypto.randomUUID())})}>Рассчитать Jev</Button>
 {quote&&<div className="space-y-2"><p>Максимальный резерв: {credits(quote.max_units)} тестовых кр. Итог по фактическому расходу в пределах резерва.</p><Button disabled={busy} onClick={()=>void action(async()=>{await api({action:'invoke',quote_id:quote.id,prompt:'Jev: смешанный пакет',key});setQuote(null);await refresh()})}>Подтвердить запуск Jev</Button></div>}
 {history.filter(row=>row.profile===state?.profile).map(row=><div key={row.id} className="space-y-3 rounded-lg border p-3"><p>{({queued:'В очереди',running:'Выполняется',succeeded:'Готово',failed:'Ошибка',canceled:'Отменено',outcome_unknown:'Исход уточняется'} as Record<string,string>)[row.status]??row.status}</p>{row.result?.content?.text&&<ApiResult text={row.result.content.text}/>}<Button variant="outline" disabled={busy} onClick={()=>void action(async()=>{await api({action:'refresh',id:row.id});await refresh()})}>Получить результат Jev</Button></div>)}
 </CardContent></Card>;
}
