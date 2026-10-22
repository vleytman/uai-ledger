import {Card,CardHeader,CardTitle,CardContent,CardDescription} from '@uai/ui/components/card';
import {Badge} from '@uai/ui/components/badge';

interface Metric {
 metric:string;source:string;precision:string;freshness:string;native_unit:string;
 total:string|null;used:string|null;remaining:string|null;fetched_at:string;covered_through:string|null;
}
interface Limit {role:string;model:string;provider:string|null;scope:'provider_account';status:'known'|'unknown';metrics:Metric[]}
interface Profile {id:string;key:string;version:number;provider_limits?:Limit[]}
const metricName:Record<string,string>={prepaid_balance:'Предоплаченный баланс',spending_cap:'Предел расходов',quota:'Квота',credit_limit:'Кредитный лимит'};
const sourceName:Record<string,string>={provider_api:'API поставщика',manual:'Ручная запись',derived:'Расчёт'};
const precisionName:Record<string,string>={exact:'Подтверждено источником',estimated:'Предварительно',unknown:'Точность неизвестна'};
interface Recipe {key:string;version:number;definition:{components:{route_version_id:string}[]}}
export function ProviderLimits({profiles,selected,recipes}:{profiles:Profile[];selected:string;recipes:Recipe[]}){
 const recipe=recipes.filter(r=>r.key===selected).sort((a,b)=>b.version-a.version)[0];
 const routeIds=recipe?.definition.components.map(c=>c.route_version_id)??[];
 const selectedProfiles=recipe?profiles.filter(p=>routeIds.includes(p.id)):profiles.filter(p=>p.key===selected).sort((a,b)=>b.version-a.version).slice(0,1);
 const rows=selectedProfiles.flatMap(p=>(p.provider_limits??[]).map(limit=>({...limit,profile:p.key})));
 return <Card><CardHeader><CardTitle>Лимиты провайдеров</CardTitle><CardDescription>Данные для выбранного профиля. Общий аккаунт поставщика может обслуживать другие приложения.</CardDescription></CardHeader><CardContent className="space-y-4">
  {!rows.length&&<p className="text-sm">Лимиты провайдера неизвестны.</p>}
  {rows.map((row,index)=><section key={`${row.profile}:${row.role}:${index}`} className="space-y-2 text-sm">
   <p className="break-words font-medium">{row.provider==='unavailable'||!row.provider?'Поставщик недоступен':row.provider} · {row.model}<span className="ml-2 text-muted-foreground">{row.role==='fallback'?'Резервный маршрут':'Основной маршрут'}</span></p>
   {!row.metrics.length?<p className="text-muted-foreground">Лимиты неизвестны: нет доступного отчёта.</p>:row.metrics.map(metric=><div key={metric.metric} className="space-y-2 rounded-lg border p-3">
    <div className="flex flex-wrap items-center gap-2"><strong>{metricName[metric.metric]??metric.metric}</strong><Badge variant={metric.freshness==='stale'?'outline':'secondary'}>{metric.freshness==='stale'?'Устарело':'Актуально'}</Badge></div>
    <dl className="space-y-1">{[['Остаток по отчёту',metric.remaining],['Всего',metric.total],['Использовано',metric.used]].map(([label,value])=><div className="flex flex-wrap justify-between gap-x-3" key={label}><dt>{label}</dt><dd className="break-all tabular-nums">{value==null?'Неизвестно':`${value} ${metric.native_unit}`}</dd></div>)}</dl>
    <p className="text-xs text-muted-foreground">{sourceName[metric.source]??metric.source} · {precisionName[metric.precision]??metric.precision}</p>
    <p className="text-xs text-muted-foreground">Получено {new Date(metric.fetched_at).toLocaleString('ru')}. {metric.covered_through?`Данные по ${new Date(metric.covered_through).toLocaleString('ru')}.`:'Конец периода покрытия неизвестен.'}</p>
   </div>)}
  </section>)}
  <p className="text-xs text-muted-foreground">Это данные аккаунта поставщика, отдельно от кредитов demo. Они не обещают точное количество доступных генераций.</p>
 </CardContent></Card>;
}
