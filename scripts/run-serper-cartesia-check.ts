import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,open,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {UaiClient,type InvocationResponse,type RequestResponse} from '../packages/sdk/src/index.js';
import {createPool} from '../packages/db/src/index.js';
import {hash,DomainError} from '../packages/contracts/src/index.js';
import {loadRuntimeSecrets} from '../packages/runtime-config/src/index.js';
import {defaultRuntime} from '../packages/execution/src/default-runtime.js';
import {executeOne} from '../packages/execution/src/runtime.js';

if(!process.argv.includes('--execute-approved-050')||process.env.UAI_ENV!=='test')throw new Error('Explicit approved-run flag and UAI_ENV=test required');
const database=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(database.hostname)||database.pathname!=='/uai_local')throw new Error('Only local uai_local is permitted');
const prepared=JSON.parse(await readFile('.data/serper-cartesia-check.json','utf8'));
assert.equal(prepared.budget_units,'500000000');assert.equal(prepared.checks.length,2);
const conf=JSON.parse(await readFile('.data/demo-config.json','utf8'));
assert.equal(conf.account_id,prepared.scope.account_id);
const api=new URL(conf.api_url);assert.equal(api.origin,'http://127.0.0.1:4310');
const root='.data/serper-cartesia-live';await mkdir(root,{recursive:true});
const marker=await open(`${root}/run-started.json`,'wx',0o600);
await marker.writeFile(JSON.stringify({started_at:new Date().toISOString(),approved_usd:'0.50'}));await marker.sync();await marker.close();
await loadRuntimeSecrets();
process.env.UAI_ALLOW_REAL_PROVIDERS='true';process.env.CARTESIA_API_VERSION=prepared.cartesia_api_version;
const pool=createPool();const originalFetch=globalThis.fetch;
const evidence:any={started_at:new Date().toISOString(),approved_usd:'0.50',network:[],results:[]};
const save=()=>writeFile(`${root}/evidence.json`,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
try{
 const budgets=(await pool.query("SELECT kind,budget_key,limit_units,reserved_units,spent_units FROM execution_budgets WHERE organization_id=$1 AND ((kind='provider' AND budget_key=ANY($2::text[])) OR (kind='period' AND budget_key=$3))",[prepared.scope.organization_id,prepared.checks.map((c:any)=>c.connection_id),prepared.period_budget_key])).rows;
 assert.equal(budgets.length,3);assert(budgets.every(b=>b.spent_units==='0'&&b.reserved_units==='0'));
 assert.equal(budgets.filter(b=>b.kind==='provider').reduce((n,b)=>n+BigInt(b.limit_units),0n),500000000n);
 const expected:any={
  'https://google.serper.dev/search':{provider:'serper',body:{gl:'us',hl:'en',num:10,page:1,q:'OpenAI official website'}},
  'https://api.cartesia.ai/tts/bytes':{provider:'cartesia',body:{language:'en',voice:'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',output_format:{container:'wav',encoding:'pcm_s16le',sample_rate:44100},model_id:'sonic-3.6-2026-08-27',transcript:'Hello from UAI.'}},
 };
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(new URL(url).origin===api.origin)return originalFetch(input,{...init,signal:init?.signal??AbortSignal.timeout(30000)});
  const plan=expected[url];if(!plan||init?.method!=='POST'||typeof init.body!=='string'||hash(JSON.parse(init.body))!==hash(plan.body))throw new Error('Provider request outside approved plan');
  const once=await open(`${root}/${plan.provider}-sent.json`,'wx',0o600);
  await once.writeFile(JSON.stringify({sent_at:new Date().toISOString(),endpoint:url}));await once.sync();await once.close();
  const network:any={provider:plan.provider,started_at:new Date().toISOString(),endpoint:url};evidence.network.push(network);await save();
  try{
   const response=await originalFetch(input,{...init,redirect:'error',signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(60000)])});
   network.http_status=response.status;network.content_type=response.headers.get('content-type');network.finished_at=new Date().toISOString();
   if(!response.ok){const body=await response.clone().json().catch(()=>null);const code=body?.error?.code??body?.code;if(typeof code==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(code))network.error_code=code;}
   await save();return response;
  }catch{network.transport_outcome='unknown';await save();throw new Error('Provider transport outcome unknown');}
 };
 const client=new UaiClient({baseUrl:conf.api_url,token:conf.app_token,pollIntervalMs:200});
 const deps=defaultRuntime(pool);deps.limits={scope:prepared.scope,global:1,application:1,account:1};
 const context=deps.context;let expectedRequest='';
 deps.context=async(scope,request,variant)=>{if(request.id!==expectedRequest||!prepared.checks.some((c:any)=>c.connection_id===variant.connection_id&&c.model===variant.model))throw new DomainError('check_scope_mismatch');return context(scope,request,variant);};
 for(const check of prepared.checks){
  const pending=(await pool.query("SELECT count(*)::int n FROM execution_requests WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND execution_status NOT IN ('succeeded','canceled','failed')",[prepared.scope.organization_id,prepared.scope.application_id,prepared.scope.account_id])).rows[0];assert.equal(pending.n,0,'Other work is pending in the test account');
  const row:any={provider:check.provider};evidence.results.push(row);
  const quote=await client.quotes.create(check.body,`live-050:${check.provider}:quote`);assert.equal(quote.max_units,check.max_units);row.quote_id=quote.id;row.max_units=quote.max_units;await save();
  const accepted=await client.request<InvocationResponse>('POST','/v1/invocations',{...check.body,quote_id:quote.id},{key:`live-050:${check.provider}:invoke`});expectedRequest=accepted.request_id;row.operation_id=accepted.operation_id;row.request_id=accepted.request_id;await save();
  const dispatched=await executeOne(pool,deps);assert.equal(dispatched.request_id,expectedRequest);row.worker=dispatched;
  const current=await client.requests.get(expectedRequest);
  if(current.execution_status!=='succeeded'){
   if(['queued','waiting_retry','waiting_recovery','paused'].includes(current.execution_status))await client.requests.cancel(expectedRequest,`stop-check:${expectedRequest}`);
   row.execution_status=current.execution_status;row.reason=current.reason;row.settlement_status=current.settlement_status;await save();continue;
  }
  const resumed=await client.resume(expectedRequest,{persist:async(result:RequestResponse)=>{
   const files=[];
   for(const asset of result.result?.assets??[]){
    const bytes=await client.assets.download(asset.id);const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');assert.equal(digest,asset.content_hash);assert.equal(String(bytes.length),asset.size_bytes);
    const path=`${root}/${check.provider}-${asset.id}.${asset.media_type==='audio/wav'?'wav':'bin'}`;const file=await open(path,'wx',0o600);await file.writeFile(bytes);await file.sync();await file.close();
    files.push({path,size_bytes:bytes.length,content_hash:digest,media_type:asset.media_type,saved_at:(await stat(path)).mtime.toISOString()});
   }
   const path=`${root}/${check.provider}-result.json`;const file=await open(path,'wx',0o600);await file.writeFile(JSON.stringify(result.result,null,2));await file.sync();await file.close();row.files=files;row.result_path=path;row.persisted_at=new Date().toISOString();
  }});
  row.execution_status=resumed.execution_status;row.settlement_status=resumed.settlement_status;row.charged_units=resumed.charged_units??null;
  const manifest=(await pool.query('SELECT acknowledged_at,status FROM storage_manifests WHERE request_id=$1',[expectedRequest])).rows[0];assert(manifest?.acknowledged_at);assert(new Date(row.persisted_at)<=new Date(manifest.acknowledged_at));row.acknowledged_at=manifest.acknowledged_at;
  const reloaded=await new UaiClient({baseUrl:conf.api_url,token:conf.app_token}).requests.get(expectedRequest);assert.equal(reloaded.execution_status,'succeeded');row.reloaded=true;await save();
  console.log(JSON.stringify({provider:row.provider,execution_status:row.execution_status,settlement_status:row.settlement_status,acknowledged:true}));
 }
 const ids=evidence.results.map((r:any)=>r.request_id).filter(Boolean);
 evidence.attempts=(await pool.query("SELECT id,request_id,number,status,cost_units,charged_units,remote_request_id,variant->>'model' model,finished_at FROM execution_attempts WHERE request_id=ANY($1::text[]) ORDER BY created_at",[ids])).rows;
 const attempts=evidence.attempts.map((r:any)=>r.id);
 evidence.usage=(await pool.query('SELECT attempt_id,model,usage,provider_request_id FROM provider_usage_observations WHERE attempt_id=ANY($1::text[])',[attempts])).rows;
 evidence.costs=(await pool.query('SELECT attempt_id,model,state,rounded_units,exact_amount FROM provider_cost_entries WHERE attempt_id=ANY($1::text[])',[attempts])).rows;
 evidence.requests=(await pool.query('SELECT id,execution_status,settlement_status,attempt_count,max_units,unresolved_at,financial_closed_at FROM execution_requests WHERE id=ANY($1::text[])',[ids])).rows;
 evidence.budgets=(await pool.query("SELECT kind,budget_key,limit_units,spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1 AND ((kind='provider' AND budget_key=ANY($2::text[])) OR (kind='period' AND budget_key=$3))",[prepared.scope.organization_id,prepared.checks.map((c:any)=>c.connection_id),prepared.period_budget_key])).rows;
 assert.equal(evidence.network.length,2);assert.equal(evidence.attempts.length,2);assert(evidence.requests.every((r:any)=>r.attempt_count===1));
 const providerExposure=evidence.budgets.filter((b:any)=>b.kind==='provider').reduce((n:bigint,b:any)=>n+BigInt(b.spent_units)+BigInt(b.reserved_units),0n);assert(providerExposure<=500000000n);
 evidence.completed_at=new Date().toISOString();await save();console.log(JSON.stringify({network_calls:evidence.network.length,provider_exposure_units:providerExposure.toString(),results:evidence.results.map((r:any)=>({provider:r.provider,execution_status:r.execution_status,settlement_status:r.settlement_status}))}));
}finally{globalThis.fetch=originalFetch;process.env.UAI_ALLOW_REAL_PROVIDERS='false';await save();await pool.end();}
