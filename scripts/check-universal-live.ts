/** Bounded real OpenAI acceptance. Default is a zero-network preflight with mock transport. */
import assert from 'node:assert/strict';
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {getEncoding} from 'js-tiktoken';
import {transaction} from '../packages/db/src/index.js';
import {systemClock,id,type Scope} from '../packages/contracts/src/index.js';
import {CatalogService} from '../packages/catalog/src/index.js';
import {ConnectionService,CredentialVault} from '../packages/reconciliation/src/connections.js';
import {issueToken} from '../packages/auth/src/index.js';
import {grant,getWallet} from '../packages/accounting/src/index.js';
import {publishRecipe} from '../packages/quoting/src/index.js';
import {textCalculationExample} from '../packages/model-pricing/src/examples.js';
import {calculateQuantities} from '../packages/model-pricing/src/index.js';
import {OpenAIAdapter,type Fetcher} from '../packages/providers/src/index.js';
import {configureBudget} from '../packages/execution/src/index.js';
import {defaultRuntime} from '../packages/execution/src/default-runtime.js';
import {executeOne} from '../packages/execution/src/runtime.js';
import {createApi} from '../apps/api/src/server.js';
import {UaiClient} from '../packages/sdk/src/index.js';
import {loadRuntimeSecrets} from '../packages/runtime-config/src/index.js';

const resume=process.argv.includes('--resume-approved-010');
const live=resume||process.argv.includes('--execute-approved-010');
assert(process.argv.slice(2).every(a=>['--execute-approved-010','--resume-approved-010','--preflight'].includes(a)),'Unknown argument');
assert.equal(process.env.UAI_ENV,'test');
const target=new URL(process.env.UAI_TEST_DATABASE_URL??'');
assert(['127.0.0.1','localhost'].includes(target.hostname)&&/^\/uai_.*test/.test(target.pathname),'Dedicated local test database required');
assert(target.href!==process.env.DATABASE_URL,'Source and test database must differ');
const root=resolve(process.env.UAI_LIVE_CHECK_ROOT??'.data/universal-live');
await mkdir(root,{recursive:true,mode:0o700});
const previous=resume?JSON.parse(await readFile(resolve(root,'evidence.json'),'utf8')):undefined;
if(resume){assert.equal(previous.approved_usd,'0.10');assert.deepEqual(previous.network.map((n:any)=>n.name),['embeddings-default','embeddings-256','stream-text','stream-json']);assert(previous.results.every((r:any)=>r.execution_status==='succeeded'));await writeFile(resolve(root,'before-resume.json'),JSON.stringify(previous,null,2),{flag:'wx',mode:0o600});}
if(live){const marker=await open(resolve(root,resume?'resume-started.json':'live-started.json'),'wx',0o600);await marker.writeFile(JSON.stringify({approved_usd:'0.10',at:new Date().toISOString()}));await marker.sync();await marker.close();}
process.env.UAI_BLOB_BACKEND='local';process.env.UAI_BLOB_ROOT=resolve(root,'blobs');
process.env.UAI_ALLOW_REAL_PROVIDERS=live?'true':'false';
process.env.UAI_EXECUTION_BACKEND='legacy';process.env.UAI_WORKER_BACKEND='legacy';
process.env.UAI_ALLOW_REPORTING_API='false';process.env.UAI_ENABLE_WEBHOOK_DELIVERY='false';
const pool=new pg.Pool({connectionString:target.href});
const scope:Scope=previous?.scope??{organization_id:id('org'),application_id:id('app'),account_id:id('acct')};
const model='gpt-4.1-mini-2025-04-14',embeddingModel='text-embedding-3-small';
const nonce=randomUUID();
const prefix=`UAI acceptance ${nonce}. Reference only; answer the final question in one short sentence.\n`+Array.from({length:380},(_,i)=>`Record ${i}: the blue garden contains a quiet stone path and seven green trees.\n`).join('');
const schema={type:'object',properties:{reply:{type:'string'}},required:['reply'],additionalProperties:false};
const checks=[
 {name:'embeddings-default',profile:'embedding',input:{texts:['A blue garden.','Синий сад.','Un jardin bleu.']},parameters:{}},
 {name:'embeddings-256',profile:'embedding',input:{texts:['A blue garden.','Синий сад.','Un jardin bleu.']},parameters:{dimensions:256}},
 {name:'stream-text',profile:'text',input:{text:'Write one short sentence about a blue garden.'},parameters:{max_output_tokens:128}},
 {name:'stream-json',profile:'text',input:{text:'Return reply containing one short sentence about a blue garden.',response_schema:schema},parameters:{max_output_tokens:128}},
 ...['cold','warm','warm-repeat','changed-prefix'].map((name,i)=>({name:`cache-${name}`,profile:'text',input:{response_schema:schema,messages:[{role:'user' as const,content:[{type:'text' as const,text:i===3?`Changed ${nonce}.\n${prefix}`:prefix,cache:{boundary:'stable_prefix' as const}}]},{role:'user' as const,content:`In one sentence, what is in the garden? Check ${i}.`}]},parameters:{max_output_tokens:128}})),
];
const encoder=getEncoding('o200k_base');
assert(encoder.encode(prefix).length>4096);
assert(checks.every(c=>encoder.encode(JSON.stringify(c.input)).length<12000));
// Six text requests <= 12k visible tokens + 1k framing allowance, 128 output each.
// At $0.40/$1.60 per million, worst modeled text cost is $0.032429; cache savings ignored.
const evidence:any=previous??{mode:live?'live':'mock-preflight',scope,models:[model,embeddingModel],approved_usd:live?'0.10':null,modeled_ceiling_usd:'0.033',prefix_tokens:encoder.encode(prefix).length,network:[],results:[],started_at:new Date().toISOString()};
const save=()=>writeFile(resolve(root,live?'evidence.json':`preflight-${nonce}.json`),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
let api:ReturnType<typeof createApi>|undefined,timer:ReturnType<typeof setInterval>|undefined,working=false,workerError:unknown;
try{
 let apiKey='mock-only';
 if(live){
  assert(process.env.DATABASE_URL,'Source database required');await loadRuntimeSecrets();assert(process.env.UAI_VAULT_KEY,'Vault required');
  const source=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try{
   const rows=(await source.query("SELECT id,organization_id,application_id FROM provider_connections WHERE provider='openai' AND status='enabled' AND credential_status='configured'")).rows;
   const selected=process.env.UAI_SOURCE_CONNECTION_ID?rows.find(r=>r.id===process.env.UAI_SOURCE_CONNECTION_ID):rows.length===1?rows[0]:undefined;
   assert(selected,'Select exactly one configured OpenAI connection');
   apiKey=await new ConnectionService(source,systemClock,new CredentialVault(Buffer.from(process.env.UAI_VAULT_KEY,'base64'))).resolveCredential(selected,selected.id);
   evidence.source_connection_id=selected.id;
  }finally{await source.end();}
 }
 const prepared=resume?await transaction(pool,async tx=>{
  const requests=(await tx.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE organization_id=$1',[scope.organization_id])).rows;assert.equal(requests.length,4);assert(requests.every(r=>r.execution_status==='succeeded'&&r.settlement_status==='settled'&&r.attempt_count===1));
  const budget=(await tx.query("SELECT limit_units,reserved_units FROM execution_budgets WHERE organization_id=$1 AND kind='provider' AND budget_key=$2",[scope.organization_id,previous.connection_id])).rows[0];assert.equal(budget.limit_units,'100000000');assert.equal(budget.reserved_units,'0');
  const auth=await issueToken(tx,{...scope,account_ids:[scope.account_id],scopes:['ai:read','ai:quote','ai:execute','content:write'],max_grant_units:null,expires_at:null});return {connection_id:previous.connection_id,token:auth.token};
 }):await transaction(pool,async tx=>{
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Universal acceptance']);
  await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$1)',[scope.account_id,scope.organization_id,scope.application_id]);
  const connection=await new ConnectionService(tx).create(scope,{provider:'openai',name:live?'Bounded real acceptance':'Mock preflight',account_scope:{test:nonce},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'acceptance',reason:'Separate test scope'});
  await tx.query("UPDATE provider_connections SET credential_status='configured' WHERE id=$1",[connection.id]);
  await configureBudget(tx,scope,'provider',connection.id,'100000000');await configureBudget(tx,scope,'period','period','100000000');
  const catalog=new CatalogService(tx);
  for(const kind of ['text','embedding'] as const){
   const embedding=kind==='embedding',capability=embedding?'embeddings.generate':'text.generate';
   const rates=embedding?[{id:'in',dimension:'input.uncached',amount:'0.02'}]:[{id:'in',dimension:'input.uncached',amount:'0.40'},{id:'cache',dimension:'input.cache_read',amount:'0.10'},{id:'out',dimension:'output.text',amount:'1.60'}];
   const card=await catalog.createDraft(scope,{kind:'rate_card',key:kind,version:1,author:'acceptance',comment:'Official standard rates checked 2026-09-25',payload:{id:kind,currency:'USD',source:`https://developers.openai.com/api/docs/models/${embedding?embeddingModel:'gpt-4.1-mini'}`,checked_at:'2026-09-25T00:00:00Z',rates:rates.map(r=>({...r,unit:'tokens',unit_size:'1000000',effective_from:'2026-09-25'}))}});
   await catalog.publish(scope,card.id,1,[{usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'100'}]},context:{at:systemClock.now().toISOString()}}]);
   const method=textCalculationExample();method.components[0].maximum='13000';
   if(embedding){method.parameters={dimensions:{type:'number',minimum:1,maximum:1536,default:1536}};method.components=[{key:'input',label:'Batch',covers:['text_input'],maximum:'300000',type:'tokens',direction:'input',tokenizer:'cl100k_base',input_mode:'embedding_batch',overhead:0,per_message:0,per_asset:0,result:{kind:'quantity',dimension:'input.uncached',unit:'tokens'}}];method.samples=[{name:'batch',input:{input:{texts:['Hello']},parameters:{dimensions:1536},assets:[]},expected:{}}];}
   method.samples.forEach(s=>s.expected=Object.fromEntries(calculateQuantities(method,s.input).map(c=>[c.key,c.value])));
   const models=await catalog.createDraft(scope,{kind:'catalog',key:kind,version:1,author:'acceptance',comment:'Bounded live model',payload:{models:[{id:embedding?embeddingModel:model,provider:'openai',status:'active',capabilities:[capability],allowed_parameters:Object.keys(method.parameters),calculation:method,rate_card_version_id:card.id,...(!embedding?{text_features:{tools:false,schema:true,image_media_types:[],image_detail:[],cache:'automatic'}}:{})}]}});await catalog.publish(scope,models.id,1);
   const route=await catalog.createDraft(scope,{kind:'route',key:kind,version:1,author:'acceptance',comment:'No fallback',payload:{capability,primary:{catalog_version_id:models.id,connection_id:connection.id,model:embedding?embeddingModel:model,max_cost_units:'10000000'},platform_risk_budget_units:'10000000'}});await catalog.publish(scope,route.id,1);
   await publishRecipe(tx,scope,systemClock,{key:kind,version:1,period_budget_key:'period',components:[{key:kind,capability,count:{constant:1},route_version_id:route.id,rate_card_version_id:'',limits:{},pricing_mode:embedding?'estimated_actual':'quoted_final'}]});
  }
  await grant(tx,scope,systemClock,{amount_units:'100000000',source:'internal',reason:'Acceptance fixture funds',terms_version:'test',expires_at:null,external_reference:nonce,idempotency_key:'fund'});
  const auth=await issueToken(tx,{...scope,account_ids:[scope.account_id],scopes:['ai:read','ai:quote','ai:execute','content:write'],max_grant_units:null,expires_at:null});
  return {connection_id:connection.id,token:auth.token};
 });
 evidence.connection_id=prepared.connection_id;
 let active=-1,sends=evidence.network.length;
 const transport:Fetcher=async(url,init)=>{
  assert(active>=0&&active<checks.length);const check=checks[active];
  assert.equal(init.method,'POST');const body=JSON.parse(String(init.body));
  const isEmbedding=check.profile==='embedding';
  assert.equal(url,`https://api.openai.com/v1/${isEmbedding?'embeddings':'responses'}`);
  assert.equal(body.model,isEmbedding?embeddingModel:model);
  if(!isEmbedding){assert.equal(body.max_output_tokens,128);assert.equal(body.stream,true);assert.equal(body.store,false);assert(encoder.encode(JSON.stringify(body)).length<12000);}
  else {assert.deepEqual(body.input,['A blue garden.','Синий сад.','Un jardin bleu.']);assert([256,1536].includes(body.dimensions));}
  assert(!evidence.network.some((n:any)=>n.name===check.name),'No repeats allowed');assert(++sends<=8);
  const item={name:check.name,endpoint:url,body_sha256:createHash('sha256').update(String(init.body)).digest('hex'),sent_at:new Date().toISOString(),http_status:0};evidence.network.push(item);await save();
  if(live){const response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(60000)])});item.http_status=response.status;await save();return response;}
  if(isEmbedding)return Response.json({model:embeddingModel,data:body.input.map((_s:string,index:number)=>({index,embedding:Array.from({length:body.dimensions},(_,j)=>j===index?1:0)})),usage:{prompt_tokens:20,total_tokens:20}});
  const text=('response_schema' in check.input)?'{"reply":"A blue garden has trees."}':'A blue garden has trees.';
  const frames=[...text.match(/.{1,5}/g)!.map(delta=>({type:'response.output_text.delta',delta})),{type:'response.completed',response:{id:`mock-${active}`,status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:active>=4?8000:80,input_tokens_details:{cached_tokens:active===5||active===6?7000:0},output_tokens:12}}}];
  return new Response(frames.map(f=>`data: ${JSON.stringify(f)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const deps=defaultRuntime(pool);deps.limits={scope,global:1,application:1,account:1};
 deps.adapter=async(_scope,variant)=>{assert.equal(variant.connection_id,prepared.connection_id);return new OpenAIAdapter({apiKey,models:[model,embeddingModel],fetch:transport})};
 api=createApi(pool);const baseUrl=await api.listen({host:'127.0.0.1',port:0}),client=new UaiClient({baseUrl,token:prepared.token});
 async function capture(result:any,row:any){
  const file=await open(resolve(root,`${row.request_id}.json`),'wx',0o600);await file.writeFile(JSON.stringify(result));await file.sync();await file.close();row.persisted_at=new Date().toISOString();
  assert(result.delivery);await client.requests.acknowledge(row.request_id,{result_version:result.delivery.result_version,manifest_hash:result.delivery.manifest_hash},`ack:${row.request_id}`);
  const manifest=(await pool.query('SELECT acknowledged_at FROM storage_manifests WHERE request_id=$1',[row.request_id])).rows[0];assert(manifest?.acknowledged_at);assert(new Date(row.persisted_at)<=new Date(manifest.acknowledged_at));row.acknowledged_at=manifest.acknowledged_at;
  row.attempts=(await pool.query('SELECT id,number,status,cost_units,charged_units FROM execution_attempts WHERE request_id=$1',[row.request_id])).rows;assert.equal(row.attempts.length,1);
  row.usage=(await pool.query('SELECT usage,provider_request_id FROM provider_usage_observations WHERE attempt_id=$1',[row.attempts[0].id])).rows;assert(row.usage.length>0&&row.usage.every((u:any)=>u.usage.state==='known'));
  row.costs=(await pool.query('SELECT state,rounded_units,exact_amount FROM provider_cost_entries WHERE attempt_id=$1',[row.attempts[0].id])).rows;
  row.cached_tokens=row.usage.at(-1).usage.items.filter((i:any)=>i.dimension==='input.cache_read').reduce((n:number,i:any)=>n+Number(i.quantity),0);
 }
 if(resume){
  const row=evidence.results.at(-1),result=await client.requests.get(row.request_id);assert.equal(result.execution_status,'succeeded');assert(result.result);
  await capture(result,row);row.original_stream_check='failed_missing_tail';row.recovered_without_provider_call=true;
  evidence.findings=[{code:'stream_terminal_race',original_error:evidence.error,resolution:'Drain committed deltas before final result; deterministic delayed and missing tail tests passed'}];delete evidence.failed;delete evidence.error;
  evidence.resumed_at=new Date().toISOString();evidence.cache_prefix_tokens=encoder.encode(prefix).length;await save();
 }
 timer=setInterval(()=>{if(working||workerError)return;working=true;void executeOne(pool,deps).catch(e=>{workerError=e}).finally(()=>{working=false})},20);
 for(const [index,check] of checks.entries()){
  if(resume&&index<4)continue;
  active=index;const started=performance.now(),events:any[]=[];
  const row:any={name:check.name};evidence.results.push(row);
  for await(const event of client.ai.stream({account_id:scope.account_id,profile:check.profile,input:check.input,parameters:check.parameters,...(check.profile==='text'?{budget:{max_units:'10000000'}}:{}),execution:{max_attempts:1},delivery:{field_paths:('response_schema' in check.input)?['/reply']:[]}},{key:check.name,signal:AbortSignal.timeout(90000)})){
   events.push(event);if(event.type==='delta'&&row.first_delta_ms===undefined)row.first_delta_ms=Math.round(performance.now()-started);
  }
  assert.equal(workerError,undefined);assert.equal(events[0]?.type,'accepted');const result=events.at(-1)?.result;assert(result,'Terminal result required');row.request_id=events[0].request_id;row.execution_status=result.execution_status;row.duration_ms=Math.round(performance.now()-started);await save();
  assert.equal(result.execution_status,'succeeded',`Stopped: ${check.name}`);assert.equal(result.settlement_status,'settled');
  const content=result.result.content;
  if(check.profile==='embedding'){assert.equal(content.type,'embeddings');assert.equal(content.dimensions,index===0?1536:256);assert.equal(content.data.length,3);content.data.forEach((d:any,i:number)=>{assert.equal(d.index,i);assert.equal(d.embedding.length,content.dimensions);assert(d.embedding.every(Number.isFinite));assert(d.embedding.some((v:number)=>v!==0));});row.dimensions=content.dimensions;row.vectors=content.data.length;}
  else {const deltas=events.filter(e=>e.type==='delta');assert(deltas.length>0);row.delta_count=deltas.length;row.live_incomplete=events.at(-1)?.live_incomplete;row.streamed_text=deltas.map(e=>e.text).join('');await save();assert.equal(deltas.map(e=>e.text).join(''),('response_schema' in check.input)?content.value.reply:content.text);}
  const replay=[];for await(const event of client.ai.resumeStream(row.request_id,{signal:AbortSignal.timeout(10000)}))replay.push(event);assert.deepEqual(replay.map(e=>e.type),['result']);assert(replay[0].type==='result');assert.deepEqual(replay[0].result.result,result.result);
  await capture(result,row);
  assert.equal(sends,index+1);await save();console.log(JSON.stringify({name:row.name,status:'passed',cached_tokens:row.cached_tokens,mode:evidence.mode}));
 }
 evidence.cache_hit_confirmed=evidence.results.filter((r:any)=>['cache-warm','cache-warm-repeat'].includes(r.name)).some((r:any)=>r.cached_tokens>0);
 evidence.cache_cold_confirmed=evidence.results.find((r:any)=>r.name==='cache-cold').cached_tokens===0;
 evidence.cache_prefix_change_confirmed=evidence.cache_hit_confirmed&&evidence.results.find((r:any)=>r.name==='cache-changed-prefix').cached_tokens<Math.max(...evidence.results.filter((r:any)=>['cache-warm','cache-warm-repeat'].includes(r.name)).map((r:any)=>r.cached_tokens));
 evidence.budgets=(await pool.query('SELECT kind,limit_units,spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1',[scope.organization_id])).rows;
 const provider=evidence.budgets.find((b:any)=>b.kind==='provider');assert(BigInt(provider.spent_units)+BigInt(provider.reserved_units)<=100000000n);assert.equal(provider.reserved_units,'0');
 const attemptsCost=evidence.results.reduce((n:bigint,r:any)=>n+BigInt(r.attempts[0].cost_units),0n);assert.equal(BigInt(provider.spent_units),attemptsCost);
 const recordedCost=evidence.results.reduce((n:bigint,r:any)=>n+r.costs.reduce((sum:bigint,c:any)=>sum+BigInt(c.rounded_units),0n),0n);assert.equal(recordedCost,attemptsCost);
 evidence.wallet=await transaction(pool,tx=>getWallet(tx,scope,systemClock));assert.equal(evidence.wallet.reserved_units,'0');
 evidence.completed_at=new Date().toISOString();assert.equal(sends,8);await save();
 console.log(JSON.stringify({mode:evidence.mode,calls:sends,cache_hit_confirmed:evidence.cache_hit_confirmed,cost_units:provider.spent_units,evidence:root}));
 if(!evidence.cache_hit_confirmed||!evidence.cache_cold_confirmed||!evidence.cache_prefix_change_confirmed)process.exitCode=2;
}catch(error){evidence.failed=true;evidence.error=error instanceof Error?error.message:'Acceptance failed';await save();throw error;}
finally{if(timer)clearInterval(timer);while(working)await new Promise(r=>setTimeout(r,20));await api?.close();await pool.end();process.env.UAI_ALLOW_REAL_PROVIDERS='false';}
