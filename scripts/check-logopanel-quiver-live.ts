/** The first, stop-on-unknown gate of LOGOPANEL_FOLLOWUP live acceptance. No paid retry. */
import assert from 'node:assert/strict';
import {mkdir,open,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {transaction} from '../packages/db/src/index.js';
import {id,systemClock as clock,type Scope} from '../packages/contracts/src/index.js';
import {ConnectionService,CredentialVault} from '../packages/reconciliation/src/connections.js';
import {loadRuntimeSecrets} from '../packages/runtime-config/src/index.js';
import {parseConfiguration,publishConfiguration,activateConfiguration} from '../packages/configuration/src/index.js';
import {grant,getWallet} from '../packages/accounting/src/index.js';
import {configureBudget} from '../packages/execution/src/index.js';
import {defaultRuntime} from '../packages/execution/src/default-runtime.js';
import {executeOne} from '../packages/execution/src/runtime.js';
import {createRegisteredAdapter} from '../packages/providers/src/registry.js';
import {createApi} from '../apps/api/src/server.js';
import {issueToken} from '../packages/auth/src/index.js';
import {UaiClient} from '../packages/sdk/src/index.js';

const live=process.argv.includes('--execute-approved-5');
const gitRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert(process.argv.slice(2).every(a=>['--preflight','--execute-approved-5'].includes(a)));
assert.equal(process.env.UAI_ENV,'test');
const target=new URL(process.env.UAI_TEST_DATABASE_URL??'');
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/uai_logopanel_live_test_20260925');
assert.notEqual(target.href,process.env.DATABASE_URL);
const root=resolve('.data/logopanel-live'),runRoot=resolve(root,live?'quiver-production-gate':'preflight-'+Date.now());
await mkdir(runRoot,{recursive:true,mode:0o700});
if(live){const marker=await open(resolve(runRoot,'started.json'),'wx',0o600);await marker.writeFile(JSON.stringify({approved_usd:'5',calls:1,started_at:clock.now().toISOString()}));await marker.sync();await marker.close();}
process.env.UAI_BLOB_BACKEND='local';process.env.UAI_BLOB_ROOT=resolve(runRoot,'blobs');
process.env.UAI_ALLOW_REAL_PROVIDERS=live?'true':'false';process.env.UAI_EXECUTION_BACKEND='legacy';process.env.UAI_WORKER_BACKEND='legacy';
process.env.UAI_ALLOW_REPORTING_API='false';process.env.UAI_ENABLE_WEBHOOK_DELIVERY='false';
const pool=new pg.Pool({connectionString:target.href});
const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};
const evidence:any={mode:live?'live':'mock',scope,approved_usd:'5',scenario:'arrow-2-generate-gate',model:'arrow-2',started_at:clock.now().toISOString(),network:[],configurations:[]};
const save=()=>writeFile(resolve(runRoot,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
let api:ReturnType<typeof createApi>|undefined;
try{
 const keys=new Map<string,string>();
 if(live){
  await loadRuntimeSecrets();assert(process.env.UAI_VAULT_KEY);
  const source=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try{const saved=JSON.parse(await readFile(resolve(root,'connections.json'),'utf8'));const vault=new CredentialVault(Buffer.from(process.env.UAI_VAULT_KEY,'base64'));
   for(const item of saved.connections){const row=(await source.query('SELECT id,organization_id,application_id FROM provider_connections WHERE id=$1',[item.id])).rows[0];assert(row);keys.set(item.provider,await new ConnectionService(source,clock,vault).resolveCredential(row,row.id));}
  }finally{await source.end()}
  assert(keys.get('quiver')?.startsWith('sk_live_'),'Quiver production key required before live dispatch');
 }
 const prepared=await transaction(pool,async tx=>{
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'LogoPanel bounded live acceptance']);
  await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$1)',[scope.account_id,scope.organization_id,scope.application_id]);
  const connections:Record<string,string>={};
  for(const provider of ['openai','anthropic','voyage','replicate','quiver']){
   const c=await new ConnectionService(tx,clock).create(scope,{provider,name:'Acceptance '+provider,account_scope:{test:scope.application_id},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{max_input_tokens:'80000'},risk_policy:{}},{actor_id:'logopanel-live',reason:'Owner approved isolated acceptance, total risk USD 5'});
   await tx.query("UPDATE provider_connections SET credential_status='configured' WHERE id=$1",[c.id]);connections[provider]=c.id;
   await configureBudget(tx,scope,'provider',c.id,'5000000000');
  }
  await configureBudget(tx,scope,'period','logopanel-live','5000000000');
  for(const file of (await readdir('configurations/ai/logopanel')).filter(f=>f.endsWith('.json'))){
   const bytes=await readFile('configurations/ai/logopanel/'+file),document=parseConfiguration(JSON.parse(bytes.toString()));
   const model=(document.resources.find(r=>r.kind==='catalog') as any).payload.models[0];
   const release=await publishConfiguration(tx,scope,document,{connections:{primary:connections[model.provider]},budgets:{period:'logopanel-live'}},{path:'configurations/ai/logopanel/'+file,git_dirty:true,git_revision:gitRevision,content_hash:createHash('sha256').update(bytes).digest('hex'),publisher:'logopanel-live'},clock);
   await activateConfiguration(tx,scope,release.id,0,'logopanel-live');evidence.configurations.push({file,release_id:release.id,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  await grant(tx,scope,clock,{amount_units:'5000000000',source:'internal',reason:'Acceptance fixture wallet; not external revenue',external_reference:scope.application_id,idempotency_key:'fund',expires_at:null,terms_version:'test'});
  const token=await issueToken(tx,{...scope,account_ids:[scope.account_id],scopes:['ai:quote','ai:execute','ai:read','content:write'],max_grant_units:null,expires_at:null});
  return {connections,token:token.token};
 });
 evidence.connections=prepared.connections;await save();
 const deps=defaultRuntime(pool,clock);deps.limits={scope};
 deps.adapter=async(_scope,variant)=>createRegisteredAdapter('quiver',{apiKey:keys.get('quiver')??'fixture-only',models:[variant.model],maxInputTokens:80000,fetch:async(url,options)=>{
  assert.equal(url,'https://api.quiver.ai/v1/svgs/generations');assert.equal(options.method,'POST');
  const body=JSON.parse(String(options.body));assert.equal(body.model,'arrow-2');assert.equal(body.max_output_tokens,4096);assert.equal(body.n,1);assert.equal(body.stream,false);assert.equal(body.reasoning_effort,'low');assert.equal(body.prompt,'A simple flat blue circle on white, no text');
  assert.equal(evidence.network.length,0,'No second paid submission is authorized by this gate');
  const entry:any={endpoint:url,body_sha256:createHash('sha256').update(String(options.body)).digest('hex'),sent_at:clock.now().toISOString()};evidence.network.push(entry);await save();
  const start=performance.now();
  let response:Response;
  try{response=live?await fetch(url,{...options,redirect:'error',signal:AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(120000)])}):Response.json({id:'fixture-response',data:[{mime_type:'image/svg+xml',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="64" fill="blue"/></svg>'}],usage:{input_tokens:100,output_tokens:100,total_tokens:200,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:20}}});}
  catch{entry.transport_error=true;entry.provider_ms=Math.round(performance.now()-start);await save();throw Error('provider_transport_unknown')}
  entry.http_status=response.status;entry.provider_environment=response.headers.get('x-quiver-environment');entry.request_id_header=response.headers.get('x-request-id');
  const raw=await response.text();entry.provider_ms=Math.round(performance.now()-start);assert(Buffer.byteLength(raw)<=8000000);
  try{const json=JSON.parse(raw);entry.usage=json.usage??null;entry.provider_request_id=json.id??json.request_id??null;entry.error_code=json.code??json.error?.code??null;entry.error_param=json.param??json.error?.param??null;entry.response_fields=Object.keys(json);entry.data_fields=Array.isArray(json.data)?json.data.map((d:any)=>Object.keys(d)):null;entry.sandbox_marker=Array.isArray(json.data)&&json.data.some((d:any)=>typeof d.svg==='string'&&/data-quiverai-sandbox|SANDBOX RESULT/.test(d.svg));}catch{entry.json_valid=false}
  await save();return new Response(raw,{status:response.status,headers:response.headers});
 }});
 api=createApi(pool,clock);
 const client=new UaiClient({baseUrl:'http://acceptance.local',token:prepared.token,fetch:async(url,options)=>{
  const response=await api!.inject({method:(options?.method??'GET') as any,url:new URL(String(url)).pathname,headers:options?.headers as any,payload:options?.body as string});
  return new Response(new Uint8Array(response.rawPayload),{status:response.statusCode,headers:{'content-type':response.headers['content-type'] as string}});
 }});
 const payload={account_id:scope.account_id,profile:'files.logopanel.arrow-2',input:{prompt:'A simple flat blue circle on white, no text'},parameters:{max_output_tokens:4096,reasoning_effort:'low'},priority:'interactive',budget:{max_units:'5000000000'},execution:{max_attempts:1,deadline_seconds:180,retry_reasons:[]}};
 const start=performance.now();
 const accepted=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:'Bearer '+prepared.token,'idempotency-key':'quiver-gate'},payload});assert.equal(accepted.statusCode,202,accepted.body);
 const invocation=accepted.json();evidence.request_id=invocation.request_id;evidence.accept_ms=Math.round(performance.now()-start);await save();
 evidence.execution=await executeOne(pool,deps,clock);
 const result=await client.requests.get(invocation.request_id);evidence.total_ms=Math.round(performance.now()-start);evidence.execution_status=result.execution_status;evidence.settlement_status=result.settlement_status;
 evidence.attempts=(await pool.query('SELECT id,number,status,cost_units,charged_units,validation_error FROM execution_attempts WHERE request_id=$1',[invocation.request_id])).rows;
 evidence.usage=(await pool.query('SELECT usage FROM provider_usage_observations WHERE attempt_id=$1',[evidence.attempts[0]?.id])).rows;
 evidence.wallet=await transaction(pool,tx=>getWallet(tx,scope,clock));
 evidence.budgets=(await pool.query('SELECT kind,limit_units,spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1',[scope.organization_id])).rows;
 await writeFile(resolve(runRoot,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
 if(result.result){
  for(const asset of result.result.assets){const bytes=await client.assets.download(asset.id);await writeFile(resolve(runRoot,'arrow-2.svg'),bytes,{mode:0o600});evidence.svg={file:'arrow-2.svg',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
  evidence.persisted_at=clock.now().toISOString();
  assert(result.delivery);const ack={result_version:result.delivery.result_version,manifest_hash:result.delivery.manifest_hash};
  const receipt=await client.requests.acknowledge(result.id,ack,'ack-gate');assert.deepEqual(await client.requests.acknowledge(result.id,ack,'ack-gate'),receipt);evidence.acknowledged=true;
 }
 const replay=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:'Bearer '+prepared.token,'idempotency-key':'quiver-gate'},payload});assert.equal(replay.statusCode,202);assert.equal(replay.json().request_id,invocation.request_id);
 assert.equal(evidence.network.length,1);assert.equal(evidence.attempts.length,1);
 evidence.passed=result.execution_status==='succeeded'&&result.settlement_status==='settled'&&evidence.usage.every((u:any)=>u.usage.state==='known');
 evidence.stop_reason=evidence.passed?null:'Live acceptance stopped: execution or authoritative token accounting was not confirmed. No next paid call.';
 evidence.finished_at=clock.now().toISOString();await save();
 console.log(JSON.stringify({mode:evidence.mode,passed:evidence.passed,status:evidence.execution_status,settlement:evidence.settlement_status,calls:evidence.network.length,svg:evidence.svg?.file??null,evidence:runRoot}));
 if(!evidence.passed)process.exitCode=2;
}catch(error){evidence.stopped=true;evidence.error=error instanceof Error?error.message:'acceptance_failed';await save();console.error(JSON.stringify({stopped:true,error:evidence.error,evidence:runRoot}));process.exitCode=1;}
finally{await api?.close();await pool.end();process.env.UAI_ALLOW_REAL_PROVIDERS='false';}
