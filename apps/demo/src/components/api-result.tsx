function label(value:unknown):string{return typeof value==='string'||typeof value==='number'?String(value):Array.isArray(value)?value.map(label).filter(Boolean).join(', '):''}
function sourceLink(value:unknown){if(typeof value!=='string')return null;try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null}catch{return null}}
export function ApiResult({text}:{text:string}){
 let data:any;try{data=JSON.parse(text)}catch{return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{text}</pre>}
 if(data?.model&&data?.answers)return <div className="space-y-3"><p>Модель: {String(data.model)}</p>{Object.entries(data.answers).map(([key,a]:[string,any])=><div key={key} className="rounded-lg border p-3"><p>{key}: {String(a.noul??a.choice??a.score)}</p>{a.confidence!==undefined&&<p>Уверенность: {a.confidence}</p>}{a.probabilities&&<pre className="overflow-auto text-xs">{JSON.stringify(a.probabilities,null,2)}</pre>}</div>)}<p>Вход: {data.usage?.input_tokens??'неизвестно'} токенов. Выход: {data.usage?.output_tokens??'неизвестно'}.</p></div>;
 const patent=data?.alexandria?.[0]?.data;
 const patents=Array.isArray(patent?.patents)?patent.patents:patent?.invention_title?[patent]:[];
 const web=Array.isArray(data?.web)?data.web:[];
 return <div className="min-w-0 space-y-3">
  {typeof data?.markdown==='string'&&<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">{data.markdown}</pre>}
  {patent?.total_results!==undefined&&<p className="text-sm">Найдено: {label(patent.total_results)}. Показано: {patents.length}.</p>}
  {patents.map((p:any,i:number)=><div key={i} className="space-y-2 rounded-lg border p-4"><h3 className="font-medium">{label(p.invention_title)||'Патент'}</h3><p className="text-sm">{label(p.publication_number||p.document_id)} · {label(p.date_published)}</p>{label(p.inventors_short)&&<p className="text-sm text-muted-foreground">{label(p.inventors_short)}</p>}{sourceLink(p.source_url)&&<a className="text-sm underline" href={sourceLink(p.source_url)!} target="_blank" rel="noreferrer">Открыть источник USPTO</a>}</div>)}
  {web.map((r:any,i:number)=><div key={i} className="space-y-2 rounded-lg border p-4"><h3 className="font-medium">{sourceLink(r.url)?<a href={sourceLink(r.url)!} target="_blank" rel="noreferrer" className="underline">{label(r.title)||label(r.url)}</a>:label(r.title)}</h3><p className="text-sm text-muted-foreground">{label(r.description)}</p></div>)}
  <details className="min-w-0 rounded-lg border p-3"><summary className="cursor-pointer text-sm">Полный ответ API</summary><pre tabIndex={0} aria-label="Ответ API" className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(data,null,2)}</pre></details>
 </div>;
}
