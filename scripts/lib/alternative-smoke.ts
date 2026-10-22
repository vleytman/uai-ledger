import {smokeMeasurements} from './alternative-smoke-report.js';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type pg from 'pg';
import sharp from 'sharp';
import {transaction} from '../../packages/db/src/index.js';
import {id,systemClock,hash,type Scope} from '../../packages/contracts/src/index.js';
import {alternativeModels,alternativeBundle,alternativeRates} from '../../packages/model-pricing/src/alternative-examples.js';
import {getAttemptUsage,rateUsage} from '../../packages/pricing/src/index.js';
import {ConnectionService,CredentialVault} from '../../packages/reconciliation/src/connections.js';
import {publishConfiguration,activateConfiguration} from '../../packages/configuration/src/index.js';
import {grant} from '../../packages/accounting/src/index.js';
import {configureBudget,configureLimiter,getRequest} from '../../packages/execution/src/index.js';
import {invoke} from '../../packages/quoting/src/index.js';
import {defaultRuntime} from '../../packages/execution/src/default-runtime.js';
import {executeOne} from '../../packages/execution/src/runtime.js';
import {createRegisteredAdapter} from '../../packages/providers/src/registry.js';
import {registerAsset,getDelivery,acknowledge} from '../../packages/storage/src/index.js';
import {createBlobStore} from '../../packages/storage/src/blob-store.js';
export const smokeSchema={type:'object',properties:{color:{type:'string'}},required:['color'],additionalProperties:false};
export const smokeTools=[{name:'lookup_color',description:'Return a color name',parameters:smokeSchema}];
export function smokeManifest(){
 const calls=alternativeModels.flatMap(m=>['text','stream','forced_tool','schema',...(m.images?['vision']:[]),'round_trip_call','round_trip_result'].map(scenario=>{
  const rated=rateUsage({state:'known',items:[{dimension:'input.uncached',quantity:String(m.context),unit:'tokens'},{dimension:'output.text',quantity:String(m.output),unit:'tokens'}]},alternativeRates(m.provider,m.id),{at:'2026-09-25T00:00:00Z',conditions:{model:m.id,...(m.provider==='google_cloud'?{service_mode:'standard'}:{})}},'ceil');if(rated.state!=='calculated')throw new Error('missing_smoke_rate');
  return {provider:m.provider,model:m.id,scenario,stream:scenario==='stream',max_output_tokens:256,expected_output_tokens:64,max_input_bytes:16000,max_images:scenario==='vision'?1:0,image_dimensions:scenario==='vision'?'32x32':null,thinking_level:m.provider==='google_cloud'?'LOW':null,max_attempts:1,provider_exposure_input_tokens:m.context,provider_exposure_output_tokens:m.output,max_cost_units:rated.rounded_units.toString()};
 }));
 const manifest={version:1,checked_at:'2026-09-25T00:00:00Z',expires_at:'2027-01-01T00:00:00Z',service_mode:'standard',currency:'USD',max_cost_units:calls.reduce((n,c)=>n+BigInt(c.max_cost_units),0n).toString(),call_count:calls.length,stop_on_unknown:true,stop_on_failure:true,calls};return {...manifest,sha256:hash(manifest)};
}
/** A new, explicitly approved batch. Never retries an unknown financial outcome. */
export function continuationSmokeManifest(previous:any){
 const original=smokeManifest();
 if(previous.manifest_sha256!==original.sha256||previous.cost_state!=='known'||!['stopped','deferred'].includes(previous.status)||!previous.rows?.length||previous.cleanup?.budgets?.some((b:any)=>b.reserved_units!=='0'))throw new Error('Previous run cannot be safely continued');
 const key=(c:any)=>`${c.provider}/${c.model}/${c.scenario}`;
 const completed=new Set(previous.rows.filter((r:any)=>r.status==='succeeded'&&r.settlement==='settled'&&r.acknowledged&&r.attempts.length===1&&r.attempts[0].cost_units!==null).map(key));
 const pendingResults=new Set(original.calls.filter(c=>c.scenario==='round_trip_result'&&!completed.has(key(c))).map(c=>`${c.provider}/${c.model}`));
 const calls=original.calls.filter(c=>!completed.has(key(c))||c.scenario==='round_trip_call'&&pendingResults.has(`${c.provider}/${c.model}`)).map(c=>({...c,max_output_tokens:1024}));
 const maxCost=calls.reduce((n,c)=>n+BigInt(c.max_cost_units),0n);
 if(!calls.length||maxCost+BigInt(previous.cost_units)>BigInt(original.max_cost_units))throw new Error('Continuation exceeds original total budget');
 const {sha256:_,...base}=original;
 const manifest={...base,version:2,parent_manifest_sha256:original.sha256,parent_report_sha256:hash(previous),prior_cost_units:previous.cost_units,max_cost_units:maxCost.toString(),call_count:calls.length,calls};
 return {...manifest,sha256:hash(manifest)};
}
/** Skip submitted calls in the same approved batch; a failed call is never repeated. */
export function remainingSmokeCalls(manifest:ReturnType<typeof smokeManifest>,previous:any){
 if(previous.manifest_sha256!==manifest.sha256||previous.cost_state!=='known'||previous.status!=='stopped'||!previous.rows?.length||!previous.cleanup?.budgets?.length||previous.cleanup.budgets.some((b:any)=>b.reserved_units!=='0'))throw new Error('Resume requires confirmed cost and released reservations');
 const rows=previous.rows as any[];
 if(rows.length>=manifest.calls.length||previous.calls!==rows.length||new Set(rows.map(r=>r.request_id)).size!==rows.length)throw new Error('Invalid submitted prefix');
 for(const [i,row] of rows.entries()){
  const spec=manifest.calls[i];
  if(row.provider!==spec.provider||row.model!==spec.model||row.scenario!==spec.scenario||!['succeeded','failed'].includes(row.status)||!['settled','platform_absorbed'].includes(row.settlement)||row.status==='succeeded'&&!row.acknowledged||row.attempts?.length!==1||row.attempts[0].cost_units==null)throw new Error('Invalid submitted prefix');
 }
 const spent=rows.reduce((n,r)=>n+BigInt(r.attempts[0].cost_units),0n),calls=manifest.calls.slice(rows.length);
 if(spent!==BigInt(previous.cost_units)||spent+calls.reduce((n,c)=>n+BigInt(c.max_cost_units),0n)>BigInt(manifest.max_cost_units)||calls[0].scenario==='round_trip_result')throw new Error('Unsafe resume boundary');
 return calls;
}
export async function setupAlternativeScope(pool:pg.Pool,real=false,manifest=smokeManifest()){
 const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const scope:Scope={organization_id:id('ami_org'),application_id:id('ami_app'),account_id:id('ami_account')};
 const vaultKey=randomBytes(32);process.env.UAI_VAULT_KEY=vaultKey.toString('base64');
 const credentials:Record<string,string>={};
 if(real){for(const provider of ['cerebras','groq'])if(!process.env[`UAI_AMI_${provider.toUpperCase()}_ACCOUNT`])throw new Error(`Missing ${provider} account scope`);for(const provider of ['cerebras','groq','google_cloud']){const file=process.env[`UAI_AMI_${provider.toUpperCase()}_CREDENTIAL_FILE`];if(!file)throw new Error(`Missing ${provider} credential file`);credentials[provider]=(await readFile(file,'utf8')).trim();}}
 const connections:Record<string,string>={};
 await transaction(pool,async tx=>{
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'AMI isolated acceptance']);await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,'ami-smoke']);
  await grant(tx,scope,systemClock,{idempotency_key:'fixture-funding',source:'internal',reason:'Isolated AMI acceptance',external_reference:'ami',amount_units:manifest.max_cost_units,terms_version:'ami',expires_at:null});await configureBudget(tx,scope,'period','ami-smoke',manifest.max_cost_units);
  const service=new ConnectionService(tx,systemClock,new CredentialVault(vaultKey));
  for(const provider of ['cerebras','groq','google_cloud']){const c=await service.create(scope,{provider,name:`${provider} · AMI isolated`,account_scope:provider==='google_cloud'?{project:real?process.env.UAI_AMI_GOOGLE_PROJECT??'':'fixture-project',location:'global'}:{account:real?process.env[`UAI_AMI_${provider.toUpperCase()}_ACCOUNT`]??'':'fixture'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'ami-runner',reason:'Isolated acceptance'});connections[provider]=c.id;await service.rotateCredential(scope,c.id,c.revision,credentials[provider]??'fixture-only',{actor_id:'ami-runner',reason:'Isolated acceptance'});await configureBudget(tx,scope,'provider',c.id,manifest.calls.filter(call=>call.provider===provider).reduce((sum,call)=>sum+BigInt(call.max_cost_units),0n).toString());await configureLimiter(tx,scope,systemClock,{key:`ami-${provider}`,window_ms:1000,request_limit:1,token_limit:'2000000',concurrency_limit:1});}
  for(const m of alternativeModels.filter(m=>manifest.calls.some(call=>call.model===m.id&&call.provider===m.provider))){const b=alternativeBundle(m.provider,m.id);for(const resource of b.resources)if(resource.kind==='route'){resource.payload.primary.limiter_key=`ami-${m.provider}`;resource.payload.primary.max_cost_units=manifest.calls.find(call=>call.model===m.id)!.max_cost_units;resource.payload.platform_risk_budget_units=resource.payload.primary.max_cost_units;}
   const r=await publishConfiguration(tx,scope,b,{connections,budgets:{'alternative-models':'ami-smoke'}},{path:`configurations/ai/alternatives/${m.provider}-${m.id.replaceAll('/','-')}.json`,git_revision:revision,git_dirty:true,content_hash:hash(b),publisher:'ami-runner'},systemClock);await activateConfiguration(tx,scope,r.id,0,'ami-runner');}
 });return {scope,connections};
}
export async function runAlternativeSmoke(pool:pg.Pool,real=false,options:{fixtureFetch?:typeof fetch;deferProviders?:string[];continuationFrom?:any;resumeFrom?:any}={}){
 const manifest=options.continuationFrom?continuationSmokeManifest(options.continuationFrom):smokeManifest();
 const pending=options.resumeFrom?remainingSmokeCalls(manifest,options.resumeFrom):manifest.calls;
 if(options.resumeFrom){
  if(options.resumeFrom.mode!==(real?'live':'fixture'))throw new Error('Resume mode mismatch');
  for(const row of options.resumeFrom.rows){const actual=(await pool.query('SELECT r.execution_status,r.settlement_status,r.attempt_count,a.id,a.cost_units::text FROM execution_requests r JOIN execution_attempts a ON a.request_id=r.id WHERE r.id=$1',[row.request_id])).rows;
   if(actual.length!==1||actual[0].id!==row.attempts[0].id||actual[0].cost_units!==row.attempts[0].cost_units||actual[0].execution_status!==row.status||actual[0].settlement_status!==row.settlement)throw new Error('Resume evidence does not match database');
  }
  const open=(await pool.query("SELECT 1 FROM execution_exposures WHERE attempt_id=ANY($1) AND state='open' LIMIT 1",[options.resumeFrom.rows.flatMap((r:any)=>r.attempts.map((a:any)=>a.id))])).rowCount;if(open)throw new Error('Resume has open exposure');
 }
 if(real&&options.continuationFrom?.mode!==undefined&&options.continuationFrom.mode!=='live')throw new Error('Cannot continue fixture as live');
 const deferred=new Set(options.deferProviders??[]);
 if([...deferred].some(provider=>!manifest.calls.some(call=>call.provider===provider)))throw new Error('Unknown deferred provider');
 if(real&&(options.fixtureFetch||process.env.UAI_AMI_APPROVED_MANIFEST_SHA256!==manifest.sha256||Date.now()>=Date.parse(manifest.expires_at)))throw new Error('Exact unexpired manifest approval required; fixture transport cannot run live');
 process.env.UAI_ALLOW_REAL_PROVIDERS=real?'true':'false';
 const report:any={manifest_sha256:manifest.sha256,...(options.resumeFrom?{resumed_report_sha256:hash(options.resumeFrom),approved_call_offset:options.resumeFrom.rows.length}:{}),mode:real?'live':'fixture',status:'stopped',cost_units:'0',cost_state:'known',calls:0,rows:[]};
 const rows:any[]=report.rows,calls=new Map<string,any>();let sends=0,totalCost=0n;
 let scope:Scope|undefined,connections:Record<string,string>={},blob:ReturnType<typeof createBlobStore>|undefined;
 const blobKey=id('ami_image');
 try{
  ({scope,connections}=await setupAlternativeScope(pool,real,{...manifest,calls:pending,max_cost_units:pending.reduce((n,c)=>n+BigInt(c.max_cost_units),0n).toString()}));
  const activeScope=scope,deps=defaultRuntime(pool);deps.limits={scope:activeScope,global:1,account:1,backend:'legacy'};
  const httpObservations=new Map<string,unknown[]>();
  deps.onRateLimits=async(_scope,_request,attempt,observation)=>{const events=httpObservations.get(attempt.id)??[];events.push(observation);httpObservations.set(attempt.id,events);};
  blob=createBlobStore();
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#0000ff'}}).png().toBuffer();await blob.put(blobKey,png);
  const asset=await transaction(pool,tx=>registerAsset(tx,activeScope,systemClock,{kind:'input',blob_key:blobKey,content_hash:`sha256:${createHash('sha256').update(png).digest('hex')}`,media_type:'image/png',size_bytes:png.length,expires_at:new Date(Date.now()+3600000)}));
 if(!real)deps.adapter=async(_scope,variant,ctx)=>createRegisteredAdapter(manifest.calls.find(c=>c.model===variant.model)!.provider,{apiKey:'fixture',models:[variant.model],googleProject:'fixture-project',googleLocation:'global',googleToken:{get:async()=> 'fixture'},fetch:options.fixtureFetch?((url,init)=>{sends++;return options.fixtureFetch!(url,init)}):(async(_url,init)=>{
  sends++;const cloud=variant.model==='gemini-3.8-flash',wire=JSON.parse(String(init.body)),tool=!!ctx.input.tools,text=ctx.input.response_schema?'{{"color":"blue"}}'.slice(1,-1):'blue';const usage=cloud?{promptTokenCount:40,candidatesTokenCount:8,thoughtsTokenCount:2}:{prompt_tokens:40,completion_tokens:10};
  const data=cloud?{responseId:id('response'),candidates:[{index:0,finishReason:'STOP',content:{parts:tool?[{functionCall:{id:'call-color',name:'lookup_color',args:{color:'blue'}},thoughtSignature:'fixture-signature'}]:[{text}]}}],usageMetadata:usage}:{id:id('response'),choices:[{index:0,finish_reason:tool?'tool_calls':'stop',message:tool?{tool_calls:[{id:'call-color',function:{name:'lookup_color',arguments:'{"color":"blue"}'}}]}:{content:text}}],usage};
  if(ctx.input.stream)return new Response(cloud?`data: ${JSON.stringify(data)}\n\n`:`data: ${JSON.stringify({...data,choices:[{index:0,delta:{content:text},finish_reason:'stop'}]})}\n\n`);return new Response(JSON.stringify(data));
 })});
  for(const spec of pending){
   if(deferred.has(spec.provider))continue;
   if(real&&spec.provider==='google_cloud'&&rows.length)await new Promise(r=>setTimeout(r,10000));
   const input:any={messages:[{role:'user',content:[{type:'text',text:'Return the color blue.'},...(spec.scenario==='vision'?[{type:'image',asset_id:asset.id}]:[])]}]};
   if(spec.scenario==='schema')input.response_schema=smokeSchema;
   if(['forced_tool','round_trip_call'].includes(spec.scenario)){input.tools=smokeTools;input.tool_choice={type:'named',name:'lookup_color'};}
   if(spec.scenario==='round_trip_result'){const call=calls.get(spec.model);if(!call)throw new Error('missing_round_trip_call');input.messages=[{role:'user',content:[{type:'text',text:'Find blue.'}]},{role:'assistant',content:[{type:'tool_call',...call}]},{role:'user',content:[{type:'tool_result',call_id:call.id,result:{color:'blue'}}]}];}
   if(Buffer.byteLength(JSON.stringify(input))>spec.max_input_bytes)throw new Error('manifest_input_bound');
   const accepted=await transaction(pool,tx=>invoke(tx,activeScope,systemClock,{idempotency_key:id('ami'),profile:alternativeBundle(spec.provider,spec.model).bundle_key,input,parameters:{max_output_tokens:spec.max_output_tokens,expected_output_tokens:spec.expected_output_tokens},execution:{max_attempts:1},delivery:{stream:spec.stream}}));
   // Keep recovery IDs before dispatch, including when executeOne throws after sending.
   const row:any={provider:spec.provider,model:spec.model,scenario:spec.scenario,operation_id:accepted.operation_id,request_id:accepted.request_id,quote_id:accepted.quote_id,status:'accepted',attempts:[]};rows.push(row);
   try{
    await executeOne(pool,deps);let request=await getRequest(pool,activeScope,accepted.request_id);
    if(request.attempt_count===0){await new Promise(r=>setTimeout(r,1100));await executeOne(pool,deps);}
   }finally{
    const request=await getRequest(pool,activeScope,accepted.request_id);
    const quote=(await pool.query('SELECT components FROM quotes WHERE id=$1',[accepted.quote_id])).rows[0];
    Object.assign(row,{calculation:quote.components[0].calculation_snapshot,route_version_id:quote.components[0].route_version_id,route:request.route,status:request.execution_status,settlement:request.settlement_status});
    row.attempts=(await pool.query('SELECT id,number,status,cost_units::text,charged_units::text,remote_request_id,validation_error FROM execution_attempts WHERE request_id=$1 ORDER BY number',[accepted.request_id])).rows;
    for(const attempt of row.attempts){attempt.http_observations=httpObservations.get(attempt.id)??[];attempt.usage=await getAttemptUsage(pool,activeScope,attempt.id);if(attempt.cost_units!==null)totalCost+=BigInt(attempt.cost_units);else report.cost_state='incomplete';}
   }
   const attempts=row.attempts;
   if(attempts.some((a:any)=>a.cost_units!==null&&BigInt(a.cost_units)>BigInt(spec.max_cost_units))||totalCost>BigInt(manifest.max_cost_units))throw new Error('smoke_cost_bound_exceeded');
   if(row.status!=='succeeded'||row.settlement!=='settled'||attempts.length!==1||attempts[0].cost_units===null)throw new Error('smoke_stopped_on_unconfirmed_outcome');
   const delivery=await getDelivery(pool,activeScope,systemClock,row.request_id);
   if(!delivery)throw new Error('smoke_delivery_missing');
   if(spec.scenario==='round_trip_call'){const {type,content_type,...call}=delivery.result?.content??{};calls.set(spec.model,call);}
   await transaction(pool,tx=>acknowledge(tx,activeScope,systemClock,{request_id:row.request_id,version:delivery.version,manifest_hash:delivery.manifest_hash}));row.acknowledged=true;
  }
  report.deferred_calls=pending.filter(call=>deferred.has(call.provider));
  report.status=report.deferred_calls.length?'deferred':'passed';
 }catch(error){report.reason=error instanceof Error?error.message:'failed';if(rows.some(row=>row.status==='accepted'))report.cost_state='incomplete';}
 finally{
  process.env.UAI_ALLOW_REAL_PROVIDERS='false';
  report.calls=rows.length;report.cost_units=totalCost.toString();report.fixture_sends=real?undefined:sends;
  report.measurements=smokeMeasurements(rows,real);
  try{
   if(Object.keys(connections).length)await pool.query("UPDATE provider_connections SET status='disabled' WHERE id=ANY($1)",[Object.values(connections)]);
   if(scope){
    report.cleanup={connections:(await pool.query('SELECT provider,status FROM provider_connections WHERE id=ANY($1)',[Object.values(connections)])).rows,budgets:(await pool.query('SELECT kind,budget_key,limit_units::text,reserved_units::text,spent_units::text FROM execution_budgets WHERE organization_id=$1 ORDER BY kind,budget_key',[scope.organization_id])).rows};
    if(['passed','deferred'].includes(report.status)&&report.cleanup.budgets.some((b:any)=>b.reserved_units!=='0')){report.status='stopped';report.reason='smoke_reservations_remaining';}
   }
  }catch{report.status='stopped';report.cleanup_error='connection_or_budget_audit_failed';}
  try{await blob?.delete(blobKey);}catch{report.status='stopped';report.blob_cleanup_error=true;}
 }
 return report;
}
