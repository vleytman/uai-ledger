import {readFile,readdir} from 'node:fs/promises';
import {it,expect,afterAll} from 'vitest';
import sharp from 'sharp';
import {createPool,transaction} from '../../db/src/index.js';
import {id,ManualClock,type Scope} from '../../contracts/src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {parseConfiguration,publishConfiguration,activateConfiguration} from '../../configuration/src/index.js';
import {grant,getWallet} from '../../accounting/src/index.js';
import {invoke} from '../../quoting/src/index.js';
import {configureBudget,getRequest} from '../src/index.js';
import {defaultRuntime} from '../src/default-runtime.js';
import {executeOne,observeNativeOne} from '../src/runtime.js';
import {createRegisteredAdapter} from '../../providers/src/registry.js';
import {registerAsset,contentHash,getDelivery,acknowledge,getAsset} from '../../storage/src/index.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end()});
const files=await readdir(new URL('../../../configurations/ai/logopanel/',import.meta.url));
it.skipIf(!pool).each([...files,'arrow-2-no-cache-split','arrow-2-lost','arrow-2-overcap'])('LF-A03 LF-A12..17 publishes and executes %s through accounting, stored result and ACK',async file=>{
 const scenario=file.startsWith('arrow-2-')&&!file.endsWith('.json')?file.slice('arrow-2-'.length):'success';if(scenario!=='success')file='arrow-2.json';
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},clock=new ManualClock(new Date('2026-09-25T12:00:00Z'));
 const document=parseConfiguration(JSON.parse(await readFile(new URL('../../../configurations/ai/logopanel/'+file,import.meta.url),'utf8')));
 const model=(document.resources.find(r=>r.kind==='catalog') as any).payload.models[0],embedding=model.capabilities[0]==='embeddings.generate',vector=model.capabilities[0]==='image.vectorize',native=model.provider==='replicate';
 const deps=defaultRuntime(pool!,clock);deps.limits={scope};let sends=0,polls=0;
 await transaction(pool!,async tx=>{
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'LF local mock']);await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
  const connection=await new ConnectionService(tx,clock).create(scope,{provider:model.provider,name:'Local transport fixture',account_scope:{fixture:scope.account_id},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'No provider calls'});
  await tx.query("UPDATE provider_connections SET credential_status='configured' WHERE id=$1",[connection.id]);
  await configureBudget(tx,scope,'provider',connection.id,'100000000000');await configureBudget(tx,scope,'period','period','100000000000');
  const release=await publishConfiguration(tx,scope,document,{connections:{primary:connection.id},budgets:{period:'period'}},{path:'configurations/ai/logopanel/'+file,git_dirty:true,git_revision:'a'.repeat(40),content_hash:'b'.repeat(64),publisher:'fixture'},clock);await activateConfiguration(tx,scope,release.id,0,'fixture');
  await grant(tx,scope,clock,{amount_units:'10000000000',source:'internal',reason:'Local fixture',external_reference:'fixture',idempotency_key:'fund',expires_at:null,terms_version:'fixture'});
 });
 let assetId:string|undefined;
 if(vector||native){const bytes=await sharp({create:{width:256,height:256,channels:3,background:'blue'}}).png().toBuffer(),blob=id('reference');await deps.blobStore.put(blob,bytes);assetId=(await transaction(pool!,tx=>registerAsset(tx,scope,clock,{kind:'input',blob_key:blob,content_hash:contentHash(bytes),media_type:'image/png',size_bytes:bytes.length,expires_at:new Date(clock.now().getTime()+3600000)}))).id;}
 const input=embedding?{texts:['Синий круг','Blue circle']}:vector?{asset_ids:[assetId!]}:{prompt:'Blue circle',...(assetId?{asset_ids:[assetId]}:{})};
 const body={idempotency_key:'invoke',profile:document.bundle_key,input,...(!embedding?{budget:{max_units:'5000000000'}}:{})};
 const call=await transaction(pool!,tx=>invoke(tx,scope,clock,body));
 deps.adapter=async()=>createRegisteredAdapter(model.provider,{apiKey:'local-fixture',models:[model.id],fetch:async(url,init)=>{
  if(init.method==='POST')sends++;
  if(embedding){const dimension=model.calculation.parameters.dimensions.default;return Response.json({model:model.id,data:[{index:1,embedding:Array(dimension).fill(.2)},{index:0,embedding:Array(dimension).fill(.1)}],usage:model.provider==='voyage'?{total_tokens:10}:{prompt_tokens:10,total_tokens:10}});}
  const size=model.calculation.parameters.size?.default??'256x256', [width,height]=size.split('x');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="128" cy="128" r="32" fill="blue"/></svg>`;
  if(native){if(init.method==='POST')return Response.json({id:'local-job'});if(url.includes('api.replicate.com')){polls++;return Response.json({id:'local-job',model:model.id,status:'succeeded',output:vector?'https://replicate.delivery/a.svg':{image:'https://replicate.delivery/a.svg',style_id:'never-save'}})}return new Response(svg);}
  if(scenario==='lost')throw Error('transport lost');
  return Response.json({id:'local-quiver',usage:scenario==='no-cache-split'?{input_tokens:100,output_tokens:80,total_tokens:180}:scenario==='overcap'?{input_tokens:100,output_tokens:300000,total_tokens:300100,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}:{input_tokens:100,output_tokens:80,total_tokens:180,input_tokens_details:{cached_tokens:20,cache_write_tokens:10},output_tokens_details:{reasoning_tokens:30}},data:[{mime_type:'image/svg+xml',svg}]});
 }});
 const execution=await executeOne(pool!,deps,clock);
 if(scenario==='lost'){
  expect(execution.state).toBe('outcome_unknown');expect((await getRequest(pool!,scope,call.request_id)).settlement_status).not.toBe('settled');
  expect((await pool!.query('SELECT cost_units FROM execution_attempts WHERE request_id=$1',[call.request_id])).rows[0].cost_units).toBeNull();
  expect((await transaction(pool!,tx=>getWallet(tx,scope,clock))).balance_units).toBe('10000000000');expect((await executeOne(pool!,deps,clock)).worked).toBe(false);expect((await transaction(pool!,tx=>invoke(tx,scope,clock,body))).request_id).toBe(call.request_id);expect(sends).toBe(1);return;
 }
 if(native){expect(execution.state).toBe('running');clock.advance(10000);expect((await observeNativeOne(pool!,deps,clock)).state).toBe('succeeded');}else expect(execution.state).toBe('succeeded');
 const delivery=(await getDelivery(pool!,scope,clock,call.request_id))!;expect(delivery.result).toBeTruthy();
 if(embedding)expect(delivery.result).toMatchObject({content:{type:'embeddings',model:model.id,revision:null,dimensions:model.calculation.parameters.dimensions.default}});else {const asset=await getAsset(pool!,scope,clock,delivery.result!.assets[0].id);expect(asset.media_type).toBe('image/svg+xml');expect((await deps.blobStore.get(asset.blob_key)).length).toBeGreaterThan(0);}
 const attempts=(await pool!.query('SELECT cost_units,charged_units FROM execution_attempts WHERE request_id=$1',[call.request_id])).rows;expect(attempts).toHaveLength(1);expect(BigInt(attempts[0].cost_units)).toBeGreaterThan(0n);if(!embedding)expect(BigInt(attempts[0].charged_units)).toBeLessThanOrEqual(BigInt(call.accepted_max_units));
 // Quiver sent no cache split: all 100 input tokens at the cache-write rate ($5/M), 80 output at $20/M.
 if(scenario==='no-cache-split')expect(attempts[0]).toEqual({cost_units:'2100000',charged_units:'2100000'});
 if(scenario==='overcap'){expect(BigInt(attempts[0].cost_units)).toBeGreaterThan(BigInt(call.accepted_max_units));expect(attempts[0].charged_units).toBe(call.accepted_max_units);}
 const wallet=await transaction(pool!,tx=>getWallet(tx,scope,clock));expect(wallet.reserved_units).toBe('0');expect(BigInt(wallet.balance_units)).toBe(10000000000n-BigInt(attempts[0].charged_units));
 expect((await transaction(pool!,tx=>invoke(tx,scope,clock,body))).request_id).toBe(call.request_id);expect(await transaction(pool!,tx=>getWallet(tx,scope,clock))).toEqual(wallet);
 // Real time advances inside ACK too: its first receipt must match the persisted replay.
 const ackClock={now:()=>{clock.advance(1);return clock.now();}};
 const ack={request_id:call.request_id,version:delivery.version,manifest_hash:delivery.manifest_hash};const receipt=await transaction(pool!,tx=>acknowledge(tx,scope,ackClock,ack));expect(await transaction(pool!,tx=>acknowledge(tx,scope,ackClock,ack))).toEqual(receipt);expect((await getDelivery(pool!,scope,clock,call.request_id))?.result).toBeNull();expect((await getRequest(pool!,scope,call.request_id)).attempt_count).toBe(1);expect((await executeOne(pool!,deps,clock)).worked).toBe(false);expect(sends).toBe(1);expect(polls).toBe(native?1:0);
});
