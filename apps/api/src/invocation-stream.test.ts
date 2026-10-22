import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {id,systemClock,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';
import {ConnectionService} from '../../../packages/reconciliation/src/connections.js';
import {grant,getWallet} from '../../../packages/accounting/src/index.js';
import {publishRecipe} from '../../../packages/quoting/src/index.js';
import {configureBudget} from '../../../packages/execution/src/index.js';
import {defaultRuntime} from '../../../packages/execution/src/default-runtime.js';
import {executeOne} from '../../../packages/execution/src/runtime.js';
import {FakeAdapter} from '../../../packages/providers/src/index.js';
import {UaiClient} from '../../../packages/sdk/src/index.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>pool?.end());
describe.skipIf(!pool)('UI-I04 invocation stream',()=>{
 it('accepts before immediate deltas, resets after a confirmed defect, and replays only the final result',async()=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const schema={type:'object',properties:{reply:{type:'string'},count:{type:'integer',minimum:1}},required:['reply','count'],additionalProperties:false};
  const auth=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Streaming fixture']);
   await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
   const connection=await new ConnectionService(tx).create(scope,{provider:'fake',name:'Synthetic',account_scope:{fixture:'stream'},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'Local stream test'});
   await configureBudget(tx,scope,'provider',connection.id,'1000000');await configureBudget(tx,scope,'period','period','1000000');
   const catalog=new CatalogService(tx),models=await catalog.createDraft(scope,{kind:'catalog',key:'text',version:1,author:'fixture',comment:'Synthetic',payload:{models:[{id:'fixture',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'}]}});await catalog.publish(scope,models.id,1);
   const card=await catalog.createDraft(scope,{kind:'rate_card',key:'rates',version:1,author:'fixture',comment:'Synthetic',payload:{id:'rates',currency:'USD',source:'Synthetic fixture',checked_at:new Date().toISOString(),rates:[{id:'out',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2020-01-01'},{id:'in',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2020-01-01'}]}});await catalog.publish(scope,card.id,1,[{usage:{state:'known',items:[{dimension:'output.text',unit:'tokens',quantity:'1'}]},context:{at:new Date().toISOString()}}]);
   const route=await catalog.createDraft(scope,{kind:'route',key:'text',version:1,author:'fixture',comment:'Synthetic',payload:{capability:'text.generate',primary:{catalog_version_id:models.id,connection_id:connection.id,model:'fixture',max_cost_units:'10000'},platform_risk_budget_units:'40000'}});await catalog.publish(scope,route.id,1);
   await publishRecipe(tx,scope,systemClock,{key:'text',version:1,period_budget_key:'period',components:[{key:'result',capability:'text.generate',count:{constant:1},route_version_id:route.id,rate_card_version_id:card.id,limits:{input_tokens:9000,output_tokens:100}}]});
   await grant(tx,scope,systemClock,{amount_units:'100000',source:'internal',reason:'Fixture',terms_version:'v1',expires_at:null,external_reference:'fixture',idempotency_key:'fund'});
   return issueToken(tx,{...scope,account_ids:[scope.account_id],scopes:['ai:read','ai:quote','ai:execute','content:write'],max_grant_units:null,expires_at:null});
  });
  const deps=defaultRuntime(pool!),adapter=new FakeAdapter();deps.limits={scope};let attempts=0;
  adapter.execute=async(_input,context)=>{attempts++;const text=JSON.stringify({reply:attempts===1?'discard':'fresh',count:attempts===1?0:1});for(const part of text)await context.onDelta?.(part);const usage={state:'known' as const,items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]};await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage,raw_usage:usage});return {outcome:'success',output:{content_type:'application/json',text},usage};};deps.adapter=async()=>adapter;
  const app=createApi(pool!),baseUrl=await app.listen({host:'127.0.0.1',port:0}),client=new UaiClient({baseUrl,token:auth.token});
  let working=false,error:unknown;const timer=setInterval(()=>{if(working)return;working=true;void executeOne(pool!,deps).catch(e=>{error=e}).finally(()=>{working=false})},5);
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000),events:any[]=[];
  try{
   const body={account_id:scope.account_id,profile:'text',input:{text:'hello',response_schema:schema},parameters:{max_output_tokens:100},budget:{max_units:'10000'},execution:{backoff:{base_ms:0,cap_ms:0,jitter_ratio:0}},delivery:{field_paths:['/reply']}};
   for await(const event of client.ai.stream(body,{key:'same',signal:controller.signal}))events.push(event);
   expect(error).toBeUndefined();expect(events[0].type).toBe('accepted');expect(attempts).toBe(2);
   expect(events.filter(e=>e.type==='attempt').map(e=>e.attempt_number)).toEqual([1,2]);
   expect(events.filter(e=>e.type==='delta'&&e.attempt_number===1).map(e=>e.text).join('')).toBe('discard');
   expect(events.filter(e=>e.type==='delta'&&e.attempt_number===2).map(e=>e.text).join('')).toBe('fresh');
   expect(events.at(-1)).toMatchObject({type:'result',result:{result:{content:{type:'structured',value:{reply:'fresh',count:1}}}}});
   const replay=[];for await(const event of client.ai.resumeStream(events[0].request_id,{signal:controller.signal}))replay.push(event);
   expect(replay.map(e=>e.type)).toEqual(['result']);expect(attempts).toBe(2);
   expect(await transaction(pool!,tx=>getWallet(tx,scope,systemClock))).toMatchObject({balance_units:'99990',reserved_units:'0'});
   expect((await pool!.query("SELECT count(*)::int n FROM outbox_events WHERE organization_id=$1 AND data::text LIKE '%discard%'",[scope.organization_id])).rows[0].n).toBe(0);
   // The last committed notification may arrive after the success transaction.
   const originalDelta=deps.onDelta;
   for(const deliverTail of [true,false]){
    let tailTimer:ReturnType<typeof setTimeout>|undefined;
    deps.onDelta=async(scope,requestId,text,event)=>{
     if(text!=='.')return originalDelta!(scope,requestId,text,event);
     await pool!.query('UPDATE execution_attempts SET delta_sequence=$2 WHERE id=$1',[event.attempt_id,event.sequence]);
     if(deliverTail)tailTimer=setTimeout(()=>{void pool!.query("SELECT pg_notify('uai_transient',$1)",[JSON.stringify({...scope,...event})])},400);
    };
    adapter.execute=async(_input,context)=>{
     await context.onDelta?.('tail');await context.onDelta?.('.');
     const usage={state:'known' as const,items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]};
     await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage,raw_usage:usage});
     return {outcome:'success',output:{content_type:'text/plain',text:'tail.'},usage};
    };
    const tailEvents:any[]=[];
    try{for await(const event of client.ai.stream({...body,input:{text:'hello'},delivery:{field_paths:[]}},{key:`tail-${deliverTail}`,signal:controller.signal}))tailEvents.push(event)}finally{if(tailTimer)clearTimeout(tailTimer)}
    expect(tailEvents.filter(e=>e.type==='delta').map(e=>e.text).join('')).toBe(deliverTail?'tail.':'tail');
    expect(tailEvents.at(-1)).toMatchObject({type:'result',live_incomplete:!deliverTail,result:{result:{content:{type:'text',text:'tail.'}}}});
   }
   deps.onDelta=originalDelta;
   let unblock!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>unblock=resolve),providerStarted=new Promise<void>(resolve=>started=resolve);
   adapter.execute=async(_input,context)=>{started();await gate;await context.onDelta?.('{"reply":"private after revoke","count":1}');const usage={state:'known' as const,items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]};await context.onUsage({event_id:`${context.attempt_id}:final`,kind:'final',revision:1,usage,raw_usage:usage});return {outcome:'success',output:{content_type:'application/json',text:'{"reply":"private after revoke","count":1}'},usage};};
   const protectedStream=client.ai.stream(body,{key:'revoked',signal:controller.signal});const accepted=(await protectedStream.next()).value!;expect(accepted.type).toBe('accepted');await providerStarted;
   await pool!.query("UPDATE service_tokens SET scopes=ARRAY['ai:quote','ai:execute'] WHERE id=$1",[auth.principal.id]);unblock();
   const afterRevoke:any[]=[];await expect((async()=>{for await(const event of protectedStream)afterRevoke.push(event)})()).rejects.toMatchObject({status:403});
   expect(afterRevoke.filter(event=>event.type==='delta'||event.type==='result')).toEqual([]);

  }finally{clearInterval(timer);clearTimeout(timeout);controller.abort();while(working)await new Promise(resolve=>setTimeout(resolve,5));await app.close();}
 });
});
