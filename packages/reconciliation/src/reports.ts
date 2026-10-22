import {DomainError,hash,systemClock,type Clock} from '../../contracts/src/index.js';
import {Decimal} from '../../pricing/src/index.js';
import type {ReconcileInput} from './index.js';
export interface CostReportRequest {provider:'openai'|'anthropic'|'cartesia'|'serper';account_scope:Record<string,string>;credential_scope:Record<string,string>;period_start:string;period_end:string;reporting_lag_seconds:number|null}
export interface ImportedCostReport {provider:string;account_scope:Record<string,string>;period_start:string;period_end:string;timezone:'UTC';native_unit:'USD';exact_usd:string|null;provider_units:string|null;all_pages_loaded:boolean;coverage_complete:boolean;reason:string|null;fetched_at:string;source_hash:string;pages:number;time_semantics:'provider_report_bucket';buckets:{start:string;end:string;exact_usd:string}[]}
export interface ReportTransport {credential:string;fetch?:typeof fetch;clock?:Clock;allow_network?:boolean;max_pages?:number;signal?:AbortSignal}
// Preserve every JSON numeric lexeme before JSON.parse can round money through binary64.
export function parseReportJson(text:string):any {if(text.length>10_000_000)throw new DomainError('report_too_large');return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,token=>token[0]==='"'?token:JSON.stringify(token)));}
function decimal(value:unknown):Decimal {if(typeof value!=='string'||!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value))throw new Error('invalid_report_amount');const [mantissa,exponent='0']=value.split(/[eE]/);const exp=Number(exponent);if(!Number.isSafeInteger(exp)||Math.abs(exp)>100)throw new Error('invalid_report_amount');const d=Decimal.parse(mantissa);return d.scale-exp>=0?new Decimal(d.coefficient,d.scale-exp):new Decimal(d.coefficient*10n**BigInt(exp-d.scale),0);}
const midnight=(v:string)=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v&&Date.parse(v)%86400000===0;
const scopedKeys={openai:['organization_id','project_id','api_key_id'],anthropic:['organization_id','workspace_id']};
/** Read-only administration APIs; no model request, no retry, no wallet allocation. Network disabled by default. */
export async function fetchProviderCostReport(input:CostReportRequest,transport:ReportTransport):Promise<ImportedCostReport>{
 if(Number.isFinite(Date.parse(input.period_start))&&Number.isFinite(Date.parse(input.period_end)))input={...input,period_start:new Date(input.period_start).toISOString(),period_end:new Date(input.period_end).toISOString()};
 const clock=transport.clock??systemClock;const base={provider:input.provider,account_scope:input.account_scope,period_start:input.period_start,period_end:input.period_end,timezone:'UTC' as const,native_unit:'USD' as const,fetched_at:clock.now().toISOString(),time_semantics:'provider_report_bucket' as const};
 if(!['openai','anthropic'].includes(input.provider))return {...base,exact_usd:null,provider_units:null,all_pages_loaded:false,coverage_complete:false,reason:'reporting_unsupported',source_hash:hash(input),pages:0,buckets:[]};
 if(!midnight(input.period_start)||!midnight(input.period_end)||Date.parse(input.period_end)<=Date.parse(input.period_start)||Date.parse(input.period_end)-Date.parse(input.period_start)>366*86400000)throw new DomainError('report_requires_utc_days','Report period must contain whole UTC days, at most 366',422);
 const provider=input.provider as 'openai'|'anthropic';const keys=scopedKeys[provider];
 if(!input.account_scope.organization_id||Object.keys(input.account_scope).some(k=>!keys.includes(k))||Object.values(input.account_scope).some(v=>typeof v!=='string'||!v||v.length>200)||hash(input.account_scope)!==hash(input.credential_scope))throw new DomainError('report_scope_mismatch','Configured credential and report scope must match',422);
 if(input.reporting_lag_seconds!==null&&(!Number.isSafeInteger(input.reporting_lag_seconds)||input.reporting_lag_seconds<0))throw new DomainError('invalid_reporting_lag');
 if(!transport.fetch&&!transport.allow_network)throw new DomainError('report_network_disabled');if(!transport.credential)throw new DomainError('credential_missing');
 const maxPages=transport.max_pages??100;if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>1000)throw new DomainError('invalid_page_limit');
 const http=transport.fetch??fetch;const buckets:ImportedCostReport['buckets']=[];const seen=new Set<string>();const pageHashes:string[]=[];let pages=0,all=false,reason:string|null=null;let page:string|undefined;let total=Decimal.parse('0');
 try {for(;pages<maxPages;){
  const url=new URL(provider==='openai'?'https://api.openai.com/v1/organization/costs':'https://api.anthropic.com/v1/organizations/cost_report');const q=url.searchParams;
  const headers:Record<string,string>=provider==='openai'?{authorization:`Bearer ${transport.credential}`,'OpenAI-Organization':input.account_scope.organization_id}:{'x-api-key':transport.credential,'anthropic-version':'2023-06-01'};
  if(provider==='openai'){q.set('start_time',String(Date.parse(input.period_start)/1000));q.set('end_time',String(Date.parse(input.period_end)/1000));q.set('limit','180');for(const [key,param] of [['project_id','project_ids[]'],['api_key_id','api_key_ids[]']] as const)if(input.account_scope[key]){q.append(param,input.account_scope[key]);q.append('group_by[]',key);}}
  else{q.set('starting_at',input.period_start);q.set('ending_at',input.period_end);q.set('limit','31');if(input.account_scope.workspace_id)q.append('group_by[]','workspace_id');}
  q.set('bucket_width','1d');if(page)q.set('page',page);
  const response=await http(url,{method:'GET',headers,redirect:'error',signal:transport.signal??AbortSignal.timeout(30000)});
  if(!response.ok){reason=response.status===401||response.status===403?'report_access_denied':`report_http_${response.status}`;break;}
  const body=parseReportJson(await response.text());pages++;pageHashes.push(hash(body));
  if(!Array.isArray(body.data)||typeof body.has_more!=='boolean')throw new Error('invalid_report_shape');
  for(const bucket of body.data){
   const start=provider==='openai'?new Date(Number(bucket.start_time)*1000).toISOString():new Date(bucket.starting_at).toISOString();const end=provider==='openai'?new Date(Number(bucket.end_time)*1000).toISOString():new Date(bucket.ending_at).toISOString();
   if(!midnight(start)||!midnight(end)||Date.parse(end)-Date.parse(start)!==86400000||start<input.period_start||end>input.period_end||buckets.some(b=>b.start===start)||!Array.isArray(bucket.results))throw new Error('report_bucket_mismatch');
   let amount=Decimal.parse('0');
   for(const row of bucket.results){
    if(provider==='anthropic'&&input.account_scope.workspace_id){if(typeof row.workspace_id!=='string')throw new Error('report_scope_missing');if(row.workspace_id!==input.account_scope.workspace_id)continue;}
    if(provider==='openai')for(const key of ['project_id','api_key_id'])if(input.account_scope[key]&&row[key]!==input.account_scope[key])throw new Error('report_scope_mismatch');
    const currency=provider==='openai'?row.amount?.currency:row.currency;if(typeof currency!=='string'||currency.toUpperCase()!=='USD')throw new Error('report_currency_unsupported');
    let value=decimal(provider==='openai'?row.amount?.value:row.amount);if(provider==='anthropic')value=value.per('100');amount=amount.add(value);
   }
   total=total.add(amount);buckets.push({start,end,exact_usd:amount.toString()});
  }
  if(!body.has_more){all=true;break;}if(typeof body.next_page!=='string'||!body.next_page||seen.has(body.next_page))throw new Error('report_pagination_invalid');seen.add(body.next_page);page=body.next_page;
 }}catch(error){reason=error instanceof Error&&/^report_|^invalid_report_/.test(error.message)?error.message:'report_transport_error';}
 if(!all&&!reason)reason='report_page_limit';
 const sorted=[...buckets].sort((a,b)=>a.start.localeCompare(b.start));const days=(Date.parse(input.period_end)-Date.parse(input.period_start))/86400000;
 if(all&&!reason&&(sorted.length!==days||sorted[0]?.start!==input.period_start||sorted.at(-1)?.end!==input.period_end))reason='report_coverage_gap';
 if(!reason&&(input.reporting_lag_seconds===null||Date.parse(input.period_end)+input.reporting_lag_seconds*1000>clock.now().getTime()))reason='reporting_lag';
 const valid=all&&!reason;return {...base,exact_usd:valid?total.toString():null,provider_units:valid?total.units('half-up').toString():null,all_pages_loaded:all,coverage_complete:valid,reason,source_hash:hash({input,pages:pageHashes}),pages,buckets:sorted};
}
/** Comparison uses local provider completion time; upstream time bucket semantics remain explicit in evidence. */
export function reportToReconcileInput(report:ImportedCostReport,connection_id:string,identity:string):ReconcileInput{return {identity,connection_id,account_scope:report.account_scope,period_start:report.period_start,period_end:report.period_end,timezone:'UTC',native_unit:'USD',...(report.provider_units!==null?{provider_units:report.provider_units}:{}),all_pages_loaded:report.all_pages_loaded&&report.coverage_complete,time_semantics:'provider_completed_at',...(report.reason==='reporting_lag'?{classification:'reporting_lag' as const}:{}),evidence:JSON.stringify({source:'provider_admin_cost_api',provider:report.provider,source_hash:report.source_hash,pages:report.pages,fetched_at:report.fetched_at,upstream_time_semantics:report.time_semantics,coverage_complete:report.coverage_complete,reason:report.reason})};}
