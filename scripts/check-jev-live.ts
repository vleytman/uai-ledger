/** Five isolated Jev checks. Preflight is offline; live mode requires explicit USD 0.05 approval. */
import assert from 'node:assert/strict';
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import bundle from '../configurations/api/typesafe/jev.json' with {type:'json'};
import {transaction} from '../packages/db/src/index.js';
import {id,systemClock as clock} from '../packages/contracts/src/index.js';
import {ConnectionService,CredentialVault} from '../packages/reconciliation/src/connections.js';
import {loadRuntimeSecrets} from '../packages/runtime-config/src/index.js';
import {publishConfiguration,activateConfiguration} from '../packages/configuration/src/index.js';
import {grant,getWallet} from '../packages/accounting/src/index.js';
import {configureBudget} from '../packages/execution/src/index.js';
import {defaultRuntime} from '../packages/execution/src/default-runtime.js';
import {executeOne} from '../packages/execution/src/runtime.js';
import {TypeSafeAdapter} from '../packages/providers/src/typesafe.js';
import {JEV_MODEL,JEV_OPERATION,validateJevInput,validateJevResult,type JevInput} from '../packages/contracts/jev.js';
import {createApi} from '../apps/api/src/server.js';
import {issueToken} from '../packages/auth/src/index.js';
import {UaiClient,jev,serviceJson} from '../packages/sdk/src/index.js';
import {jevExample} from '../apps/demo/src/jev-settings.js';
const live=process.argv.includes('--execute-approved-005');
assert(process.argv.slice(2).every(a=>['--preflight','--execute-approved-005'].includes(a)));
assert.equal(process.env.UAI_ENV,'test');
const target=new URL(process.env.UAI_TEST_DATABASE_URL??'');
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/uai_jev_live_test_20260926');assert.notEqual(target.href,process.env.DATABASE_URL);
const root=resolve('.data/jev-live',live?'approved-005':'preflight-'+Date.now());await mkdir(root,{recursive:true,mode:0o700});
const checks:{name:string;input:JevInput}[]=[
 {name:'noul',input:{state:'The meeting starts tomorrow.',questions:{urgent:{type:'noul',instructions:'Is the meeting scheduled for today?'}}}},
 {name:'choice',input:{state:'Please refund the duplicate invoice.',questions:{team:{type:'choice',instructions:'Which team should handle this request?',criteria:{billing:'Invoices and payments',technical:'Technical issues'}}}}},
 {name:'score',input:{state:'Service is unavailable for all users.',questions:{severity:{type:'score',instructions:'Rate the severity.',criteria:['Minor inconvenience','Significant problem','Critical outage']}}}},
 {name:'mixed',input:jevExample},
 {name:'ambiguous',input:{state:'Something seems wrong.',questions:{team:{type:'choice',instructions:'Which team should handle this request?',criteria:{billing:'Invoices and payments',technical:'Technical issues'}}}}}
];
for(const c of checks){validateJevInput(c.input);assert(Buffer.byteLength(JSON.stringify(c.input))<2000);}
process.env.UAI_ALLOW_REAL_PROVIDERS=live?'true':'false';process.env.UAI_ALLOW_REPORTING_API='false';process.env.UAI_ENABLE_WEBHOOK_DELIVERY='false';process.env.UAI_EXECUTION_BACKEND='legacy';process.env.UAI_WORKER_BACKEND='legacy';process.env.UAI_BLOB_BACKEND='local';process.env.UAI_BLOB_ROOT=resolve(root,'blobs');
const pool=new pg.Pool({connectionString:target.href}),scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};
const evidence:any={mode:live?'live':'offline',approved_usd:live?'0.05':null,profile_input_tokens:32768,scope,started_at:clock.now().toISOString(),network:[],results:[],checks};
const save=()=>writeFile(resolve(root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
let api:ReturnType<typeof createApi>|undefined;
try{
 let apiKey='fixture-only';
 if(live){
  if(process.env.UAI_TYPESAFE_KEY_FILE){const text=(await readFile(process.env.UAI_TYPESAFE_KEY_FILE,'utf8')).trim();const line=text.split('\n').find(l=>/^\s*(?:export\s+)?(?:TYPESAFE_API_KEY|Jev)\s*=/i.test(l));apiKey=(line?line.replace(/^\s*(?:export\s+)?(?:TYPESAFE_API_KEY|Jev)\s*=/i,'').trim():text).replace(/^(['"])(.*)\1$/,'$2');assert(apiKey&&!/\s/.test(apiKey),'Key file must contain a raw key or TYPESAFE_API_KEY assignment');}
  else{await loadRuntimeSecrets();assert(process.env.UAI_VAULT_KEY,'Local vault required');const source=new pg.Pool({connectionString:process.env.DATABASE_URL});try{const rows=(await source.query("SELECT id,organization_id,application_id FROM provider_connections WHERE provider='typesafe' AND status='enabled' AND credential_status='configured'")).rows;const selected=process.env.UAI_SOURCE_CONNECTION_ID?rows.find(r=>r.id===process.env.UAI_SOURCE_CONNECTION_ID):rows.length===1?rows[0]:undefined;assert(selected,'Select one configured TypeSafe connection');apiKey=await new ConnectionService(source,clock,new CredentialVault(Buffer.from(process.env.UAI_VAULT_KEY,'base64'))).resolveCredential(selected,selected.id);evidence.source_connection_id=selected.id;}finally{await source.end();}}
  const models=await fetch('https://api.typesafe.ai/v1/models',{headers:{authorization:`Bearer ${apiKey}`},redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(models.status,200,'Model access check failed');const json=await models.json() as any;assert(Array.isArray(json.models));evidence.available_models=json.models.map((m:any)=>m.name);assert(evidence.available_models.some((name:string)=>['jev-latest','jev-preview',JEV_MODEL].includes(name)));
  // Exclusive durable marker prevents a second run from silently repeating paid requests.
  const marker=await open(resolve(root,'started.json'),'wx',0o600);await marker.writeFile(JSON.stringify({approved_usd:'0.05',calls:5,started_at:clock.now().toISOString()}));await marker.sync();await marker.close();
 }
 const document=structuredClone(bundle) as any;document.resources[3].payload.execution={max_attempts:1};
 const prepared=await transaction(pool,async tx=>{
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Jev isolated acceptance']);await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$1)',[scope.account_id,scope.organization_id,scope.application_id]);
  const c=await new ConnectionService(tx,clock).create(scope,{provider:'typesafe',name:'Jev bounded acceptance',account_scope:{acceptance:scope.application_id},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'jev-live',reason:'Owner approved USD 0.05, five short calls'});
  await tx.query("UPDATE provider_connections SET credential_status='configured' WHERE id=$1",[c.id]);
  await configureBudget(tx,scope,'provider',c.id,'50000000');await configureBudget(tx,scope,'period','jev-live','50000000');
  const release=await publishConfiguration(tx,scope,document,{connections:{primary:c.id},budgets:{period:'jev-live'}},{path:'configurations/api/typesafe/jev.json',git_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),git_dirty:true,content_hash:createHash('sha256').update(JSON.stringify(document)).digest('hex'),publisher:'jev-live'},clock);await activateConfiguration(tx,scope,release.id,0,'jev-live');
  await grant(tx,scope,clock,{amount_units:'50000000',source:'internal',reason:'Acceptance wallet, not revenue',external_reference:scope.application_id,idempotency_key:'fund',expires_at:null,terms_version:'test'});
  return {connection_id:c.id,release_id:release.id,token:(await issueToken(tx,{...scope,account_ids:[scope.account_id],scopes:['ai:quote','ai:execute','ai:read','content:write'],max_grant_units:null,expires_at:null})).token};
 });
 evidence.connection_id=prepared.connection_id;evidence.release_id=prepared.release_id;await save();
 let active=checks[0],spent=0n;
 const deps=defaultRuntime(pool,clock);deps.limits={scope};deps.adapter=async()=>new TypeSafeAdapter({apiKey,models:[JEV_OPERATION],fetch:async(url,init)=>{
  assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(String(init.body)),{model:JEV_MODEL,...active.input});assert(evidence.network.length<5);assert(!evidence.network.some((n:any)=>n.name===active.name));assert(spent+1376256n<=50000000n);
  const n:any={name:active.name,sent_at:clock.now().toISOString(),body_sha256:createHash('sha256').update(String(init.body)).digest('hex')};evidence.network.push(n);await save();const start=performance.now();
  let response:Response;
  try{if(live)response=await fetch(url,init);else{const answers=Object.fromEntries(Object.entries(active.input.questions).map(([key,q])=>[key,q.type==='noul'?{type:q.type,noul:0.5}:q.type==='choice'?{type:q.type,choice:Object.keys(q.criteria)[0],confidence:0,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,1/Object.keys(q.criteria).length]))}:{type:q.type,score:(q.criteria.length-1)/2,confidence:0,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,1/q.criteria.length])),legend:Object.fromEntries(q.criteria.map((v,i)=>[i,v]))}]));response=Response.json({model:JEV_MODEL,answers,usage:{input_tokens:100,output_tokens:20}});}
  const raw=await response.text();n.http_ms=Math.round(performance.now()-start);n.status=response.status;assert(Buffer.byteLength(raw)<=1048576);try{const json=JSON.parse(raw);n.model=json.model;n.usage=json.usage;}catch{n.invalid_json=true;}await save();return new Response(raw,{status:response.status,headers:response.headers});}catch{n.transport_error=true;await save();throw Error('typesafe_transport_unknown');}
 }});
 api=createApi(pool,clock);const client=new UaiClient({baseUrl:'http://jev-acceptance.local',token:prepared.token,fetch:async(url,options)=>{const r=await api!.inject({method:(options?.method??'GET') as any,url:new URL(String(url)).pathname,headers:options?.headers as any,payload:options?.body as string});return new Response(new Uint8Array(r.rawPayload),{status:r.statusCode,headers:{'content-type':r.headers['content-type'] as string}});}});
 for(const check of checks){
  active=check;const quote=await jev(client,{account_id:scope.account_id}).quote(check.input,'quote-'+check.name);assert.equal(quote.max_units,'1376256');
  const start=performance.now();const payload={account_id:scope.account_id,profile:bundle.bundle_key,input:check.input,budget:{max_units:quote.max_units},execution:{max_attempts:1,deadline_seconds:90,retry_reasons:[]}};
  const accepted:any=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:'Bearer '+prepared.token,'idempotency-key':'run-'+check.name},payload});assert.equal(accepted.statusCode,202,'Invocation rejected');const request=accepted.json();
  const entry:any={name:check.name,request_id:request.request_id,quote_id:quote.id,max_units:quote.max_units};evidence.results.push(entry);await save();await executeOne(pool,deps,clock);
  const result=await client.requests.get(request.request_id);entry.total_ms=Math.round(performance.now()-start);entry.execution_status=result.execution_status;entry.settlement_status=result.settlement_status;entry.attempts=(await pool.query('SELECT id,number,status,cost_units,charged_units,validation_error FROM execution_attempts WHERE request_id=$1',[request.request_id])).rows;
  entry.usage=(await pool.query('SELECT usage FROM provider_usage_observations WHERE attempt_id IN (SELECT id FROM execution_attempts WHERE request_id=$1)',[request.request_id])).rows;entry.wallet=await transaction(pool,tx=>getWallet(tx,scope,clock));await save();
  await writeFile(resolve(root,check.name+'-result.json'),JSON.stringify(result,null,2),{mode:0o600});assert.equal(entry.attempts.length,1);assert.equal(result.execution_status,'succeeded','Stop: execution did not succeed');assert.equal(result.settlement_status,'settled','Stop: financial settlement unresolved');assert.equal(entry.wallet.reserved_units,'0');
  const value=validateJevResult(serviceJson(result),check.input.questions);assert.equal(value.model,JEV_MODEL);entry.value=value;
  const attempt=entry.attempts[0];assert(attempt.cost_units!==null);assert.equal(attempt.cost_units,String(value.usage!.input_tokens*42));assert(BigInt(attempt.charged_units)<=1376256n);spent+=BigInt(attempt.cost_units);evidence.total_cost_units=spent.toString();assert(spent<=50000000n);assert(value.usage!.input_tokens<=32768,'Stop: selected token bound exceeded');
  assert(result.delivery);const ack={result_version:result.delivery.result_version,manifest_hash:result.delivery.manifest_hash};await client.requests.acknowledge(result.id,ack,'ack-'+check.name);entry.acknowledged=true;await save();
 }
 evidence.budgets=(await pool.query('SELECT kind,limit_units,spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1',[scope.organization_id])).rows;assert(evidence.budgets.every((b:any)=>b.reserved_units==='0'));assert.equal(evidence.network.length,5);evidence.passed=true;evidence.finished_at=clock.now().toISOString();await save();console.log(JSON.stringify({passed:true,calls:5,total_cost_units:evidence.total_cost_units,evidence:root}));
}catch(error){evidence.passed=false;evidence.stopped=true;evidence.error=error instanceof assert.AssertionError?error.message:'Acceptance stopped; inspect local evidence';await save();console.error(JSON.stringify({passed:false,calls:evidence.network.length,error:evidence.error,evidence:root}));process.exitCode=1;}
finally{await api?.close();await pool.end();process.env.UAI_ALLOW_REAL_PROVIDERS='false';}
