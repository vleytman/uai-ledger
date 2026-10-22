import Fastify from 'fastify';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createPool,transaction} from '../packages/db/src/index.js';
import {systemClock,id} from '../packages/contracts/src/index.js';
import {createApi} from '../apps/api/src/server.js';
import {defaultRuntime} from '../packages/execution/src/default-runtime.js';
import {executeOne} from '../packages/execution/src/runtime.js';
import {publishRecipe} from '../packages/quoting/src/index.js';
import {grant} from '../packages/accounting/src/index.js';
import {UaiClient} from '../packages/sdk/src/index.js';
if(process.env.UAI_ENV!=='test'||process.env.UAI_ALLOW_REAL_PROVIDERS==='true')throw new Error('Fixture requires test mode with real providers disabled');
const root=process.env.UAI_FIXTURE_ROOT;if(!root)throw new Error('UAI_FIXTURE_ROOT required');
const config=JSON.parse(await readFile(resolve(root,'.data/demo-config.json'),'utf8')),pool=createPool();
if(!/test|fixture/.test((await pool.query('SELECT current_database() name')).rows[0].name))throw new Error('Use a separate test database');
const account=(await pool.query('SELECT * FROM accounts WHERE id=$1',[config.account_id])).rows[0],scope={organization_id:account.organization_id,application_id:account.application_id,account_id:account.id};
await transaction(pool,async tx=>{
 const existing=(await tx.query("SELECT definition FROM recipe_versions WHERE application_id=$1 AND key='text.standard' ORDER BY version DESC LIMIT 1",[scope.application_id])).rows[0].definition;
 if(!(await tx.query("SELECT 1 FROM recipe_versions WHERE application_id=$1 AND key='universal.fixture'",[scope.application_id])).rowCount)await publishRecipe(tx,scope,systemClock,{...existing,key:'universal.fixture',version:1,deadline_seconds:300,components:existing.components.map((c:any)=>({...c,limits:{...c.limits,input_tokens:20000,max_assets:8,image_input_tokens_per_asset:1024}}))});
 await grant(tx,scope,systemClock,{idempotency_key:'universal-fixture-funds',amount_units:'10000000000',source:'internal',reason:'Synthetic fixture',terms_version:'fixture',expires_at:null,external_reference:'universal-fixture-funds'});
});
const api=createApi(pool),apiUrl=await api.listen({host:'127.0.0.1',port:0}),client=new UaiClient({baseUrl:apiUrl,token:config.app_token});
const adminPath=resolve(root,'.data/admin-config.json');const adminConfig=JSON.parse(await readFile(adminPath,'utf8'));await writeFile(adminPath,JSON.stringify({...adminConfig,api_url:apiUrl}),{mode:0o600});
const deps=defaultRuntime(pool);deps.limits={scope,account:16,application:32,global:64};const factory=deps.adapter;
deps.adapter=async(...args)=>{
 const adapter=await factory(...args),execute=adapter.execute.bind(adapter);
 adapter.execute=async(input,context)=>{
  await new Promise(resolve=>setTimeout(resolve,40));
  const attempt=(await pool.query('SELECT number FROM execution_attempts WHERE id=$1',[context.attempt_id])).rows[0];
  if(input.instructions==='fixture:refused'||input.instructions==='fixture:retry'&&attempt.number===1)await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage:{state:'known',items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]},raw_usage:{synthetic:true}});
  if(input.instructions==='fixture:refused')return {outcome:'refused',refusal:'Синтетический отказ модели.',failure:{kind:'refused',code:'model_refused',sent:true},usage:{state:'known',items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]}};
  if(input.instructions==='fixture:retry'&&attempt.number===1){const text='{"reply":"Этот предварительный ответ будет сброшен","count":0}';await context.onDelta?.(text);return {outcome:'success',output:{text,content_type:'application/json'},usage:{state:'known',items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]}};}
  const delta=context.onDelta;return execute(input,{...context,onDelta:delta?async text=>{if(input.instructions==='fixture:slow')await new Promise(resolve=>setTimeout(resolve,500));await delta(text)}:undefined});
 };return adapter;
};
let stopping=false,inFlight=0;const timer=setInterval(()=>{if(stopping||inFlight>=16)return;inFlight++;void executeOne(pool,deps).catch(()=>console.error('fixture_worker_failed')).finally(()=>inFlight--)},10);
const app=Fastify({bodyLimit:20*1024*1024});const outputs=resolve(root,'results');await mkdir(outputs,{recursive:true});
app.addHook('onRequest',async(request,reply)=>{const origin=request.headers.origin;if(origin&&origin!==`http://${request.headers.host}`)return reply.code(403).send({error:'Invalid origin'});});
app.get('/',async(_request,reply)=>reply.type('text/html').send(await readFile(new URL('./fixtures/universal-invocation.html',import.meta.url),'utf8')));
app.get('/wallet',()=>client.wallets.get(config.wallet_id));
app.get('/wallet/events',async(request,reply)=>{
 const controller=new AbortController();reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});reply.raw.on('close',()=>controller.abort());
 try{for await(const wallet of client.wallets.subscribe(config.wallet_id,{signal:controller.signal}))if(!reply.raw.write(`data: ${JSON.stringify(wallet)}\n\n`))break;}finally{controller.abort();reply.raw.end();}
});
app.post('/upload',async request=>{const body=request.body as any,bytes=Buffer.from(body.base64,'base64');if(bytes.length>10000000)throw new Error('Image too large');return client.assets.upload({account_id:scope.account_id,media_type:body.media_type,size_bytes:bytes.length,content_hash:`sha256:${createHash('sha256').update(bytes).digest('hex')}`},bytes,body.key);});
app.post('/cancel',request=>client.requests.cancel((request.body as any).request_id,id('cancel')));
async function relay(request:any,reply:any,resume=false){
 const controller=new AbortController();reply.raw.on('close',()=>controller.abort());const body=request.body??{};
 const stream=resume?client.ai.resumeStream(request.query.id,{signal:controller.signal}):client.ai.stream({account_id:scope.account_id,profile:'universal.fixture',input:body.input,parameters:{max_output_tokens:512},budget:{max_units:'24000000'},execution:{max_attempts:body.max_attempts??4},delivery:{field_paths:body.field_paths??[]}},{key:body.key,signal:controller.signal});
 const iterator=stream[Symbol.asyncIterator]();let first;
 try{first=await iterator.next()}catch(error){return reply.code(422).send({error:error instanceof Error?error.message:'Invocation failed'})}
 reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
 try{for(let next=first;!next.done;next=await iterator.next()){
  const event=next.value;
  if(event.type==='result'&&!event.result.result&&/^req_[a-zA-Z0-9-]+$/.test(event.request_id)){try{const saved=JSON.parse(await readFile(resolve(outputs,`${event.request_id}.json`),'utf8'));event.result={...event.result,result:saved.result};}catch{}}
  if(event.type==='result'&&event.result.result){await writeFile(resolve(outputs,`${event.request_id}.json`),JSON.stringify(event.result),{mode:0o600});if(event.result.delivery)await client.requests.acknowledge(event.request_id,{result_version:event.result.delivery.result_version,manifest_hash:event.result.delivery.manifest_hash},`fixture-ack:${event.request_id}`);}
  if(!reply.raw.write(`data: ${JSON.stringify(event)}\n\n`))break;
 }}catch{if(!controller.signal.aborted)reply.raw.write('data: {"type":"disconnected"}\n\n');}finally{controller.abort();await iterator.return(undefined).catch(()=>{});reply.raw.end();}
}
app.post('/run',(request,reply)=>relay(request,reply));app.get('/resume',(request,reply)=>relay(request,reply,true));
const address=await app.listen({host:'127.0.0.1',port:Number(process.env.UAI_FIXTURE_PORT??4348)});console.log(`Universal fixture: ${address}; fake provider only; results: ${outputs}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{stopping=true;clearInterval(timer);await app.close();await api.close();while(inFlight)await new Promise(resolve=>setTimeout(resolve,10));await pool.end();process.exit(0)});
