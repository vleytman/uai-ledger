import {replayQuotaFeedback} from '../src/quota-feedback.js';
import {providerAdmission} from '../../queue/src/provider-admission.js';
import {afterAll,describe,it,expect,vi} from 'vitest';
import {ExecutionTransport} from '../../queue/src/transport.js';
import {createPool,transaction} from '../../db/src/index.js';
import {ManualClock,id,type Scope} from '../../contracts/src/index.js';
import {CatalogService} from '../../catalog/src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {grant,getWallet,refund} from '../../accounting/src/index.js';
import {createQuote,publishRecipe,invoke,getOperation} from '../../quoting/src/index.js';
import {demoModels} from '../../model-pricing/src/demo-models.js';
import {OpenAIAdapter} from '../../providers/src/index.js';
import {configureBudget} from '../src/index.js';
import {executeOne,executeRequest} from '../src/runtime.js';
import {defaultRuntime} from '../src/default-runtime.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool)('estimated actual usage end to end',()=>{
 it.each(process.env.REDIS_URL?[[100,false,false,false],[10000,false,false,false],[100,true,false,false],[10000,true,false,false],[10001,true,false,false],[100,true,true,false],[100,true,false,true]] as const:[[100,false,false,false],[10000,false,false,false]] as const)('settles %i actual output tokens, Redis admission %s, multi-group %s, coordinated single %s',async(outputTokens,distributed,multi,coordinatedSingle)=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};const clock=new ManualClock(new Date());
  await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'usage fixture']);await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('ext')]);
   const connection=await new ConnectionService(tx,clock).create(scope,{provider:'openai',name:'Mock transport only',account_scope:{fixture:'test'},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'test',reason:'Mock only'});
   await tx.query("UPDATE provider_connections SET credential_status='configured' WHERE id=$1",[connection.id]);
   await configureBudget(tx,scope,'provider',connection.id,'1000000000');await configureBudget(tx,scope,'period','period','1000000000');
   if(distributed){await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'openai','{}','epoch','mock')",[scope.organization_id,scope.organization_id]);await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',1,60000)",[scope.organization_id]);await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) SELECT $1,metric,metric,100000,60000 FROM unnest(ARRAY['input_tokens','output_tokens','tokens']) metric",[scope.organization_id]);await tx.query('INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,$2,$3)',[connection.id,'gpt-4.1-nano-2025-04-14',scope.organization_id]);}
   if(coordinatedSingle)await tx.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[scope.organization_id,scope.organization_id]);
   if(multi){
    await tx.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[scope.organization_id,scope.organization_id]);
    await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,'openai','{}','epoch','mock',$2)",[scope.organization_id+'-global',scope.organization_id]);
    await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',10,60000)",[scope.organization_id+'-global']);
    await tx.query('INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,$2,$3)',[connection.id,'gpt-4.1-nano-2025-04-14',scope.organization_id+'-global']);
   }
   const spec=demoModels().find(m=>m.key==='nano')!,catalog=new CatalogService(tx,clock);
   const card=await catalog.createDraft(scope,{kind:'rate_card',key:'rates',version:1,payload:spec.card,author:'test',comment:'test'});await catalog.publish(scope,card.id,1,[{usage:{state:'known',items:[{dimension:'output.text',unit:'tokens',quantity:'1'}]},context:{at:clock.now().toISOString()}}]);
   const models=await catalog.createDraft(scope,{kind:'catalog',key:'models',version:1,author:'test',comment:'test',payload:{models:[{id:spec.id,provider:'openai',status:'active',capabilities:['text.generate'],allowed_parameters:Object.keys(spec.method.parameters),calculation:spec.method,rate_card_version_id:card.id}]}});await catalog.publish(scope,models.id,1);
   await tx.query('INSERT INTO execution_limiters(organization_id,limiter_key,window_started_at,window_ms,request_limit,token_limit,concurrency_limit) VALUES($1,$2,$3,60000,6,100000,2)',[scope.organization_id,'text-limit',clock.now()]);
   const route=await catalog.createDraft(scope,{kind:'route',key:'route',version:1,author:'test',comment:'test',payload:{capability:'text.generate',primary:{catalog_version_id:models.id,model:spec.id,connection_id:connection.id,limiter_key:'text-limit',max_cost_units:'100000000'},deadline_seconds:3600,platform_risk_budget_units:'400000000'}});await catalog.publish(scope,route.id,1);
   await publishRecipe(tx,scope,clock,{key:'text',version:1,period_budget_key:'period',components:[{key:'text',capability:'text.generate',count:{constant:1},route_version_id:route.id,rate_card_version_id:'',limits:{},pricing_mode:'estimated_actual'}]});
   await grant(tx,scope,clock,{amount_units:'4000000',source:'internal',reason:'test',terms_version:'v1',expires_at:null,external_reference:'test',idempotency_key:'g'});
  });
  const quote=await transaction(pool!,tx=>createQuote(tx,scope,clock,{idempotency_key:'q',profile:'text',input:{text:'Hello'},parameters:{expected_output_tokens:4096}}));
  expect(quote).toMatchObject({estimate_only:true,overdraft_allowed:true,settlement:'actual_usage'});expect(quote.price_units).toBeUndefined();expect(BigInt(quote.estimated_units)).toBeLessThan(4000000n);
  await expect(transaction(pool!,tx=>invoke(tx,scope,clock,{idempotency_key:'capped',quote_id:quote.id,budget:{max_units:'999999999'}}))).rejects.toMatchObject({code:'budget_conflict'});
  const call=await transaction(pool!,tx=>invoke(tx,scope,clock,{idempotency_key:'invoke',quote_id:quote.id}));
  const queued=(await pool!.query('SELECT route FROM execution_requests WHERE id=$1',[call.request_id])).rows[0];
  expect(BigInt(queued.route.primary.limit_tokens)).toBeGreaterThanOrEqual(4096n);expect(BigInt(queued.route.primary.limit_tokens)).toBeLessThan(4200n);
  const deps=defaultRuntime(pool!,clock);deps.limits={scope};let sent:any;
  const quota=distributed?providerAdmission(pool!,process.env.REDIS_URL!,'test'):null;
  if(quota){await pool!.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=$1",[call.request_id]);deps.limits={scope,backend:'bullmq'};deps.admit=quota.admit;deps.onRateLimits=quota.onRateLimits;deps.onProviderResult=quota.onProviderResult;deps.renewAdmission=quota.renewAdmission;}
  deps.adapter=async()=>new OpenAIAdapter({apiKey:'mock',models:['gpt-4.1-nano-2025-04-14'],maxInputTokens:1000,fetch:async(_url,init)=>{sent=JSON.parse(String(init.body));return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'A complete long answer.'}]}],usage:{input_tokens:10,output_tokens:outputTokens,total_tokens:outputTokens+10,input_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}})}});
  if(multi)deps.onProviderResult=async()=>{throw new Error('quota callback unavailable')};
  deps.onDelta=undefined;
  if(distributed){
   const transport=new ExecutionTransport(id('actual_usage'),process.env.REDIS_URL!),results:Awaited<ReturnType<typeof executeRequest>>[]=[],errors:string[]=[];
   try{
    const worker=transport.consume('text',1,async delivery=>{const result=await executeRequest(pool!,{...deps,limits:{...deps.limits,generation:delivery.generation}},delivery.request_id,clock);results.push(result);return result},error=>errors.push(error.message));
    worker.on('failed',(_job,error)=>errors.push(error.message));
    const delivery={request_id:call.request_id,generation:0,purpose:'execute' as const};
    await transport.publish('text',delivery);
    await vi.waitFor(()=>expect(results).toHaveLength(1),{timeout:10000});
    expect(results[0].state).toBe('succeeded');
    // Bypass Redis job-ID deduplication to exercise the durable financial guard.
    await transport.queue('text').add('duplicate',delivery,{jobId:id('duplicate')});
    await vi.waitFor(()=>expect(results).toHaveLength(2),{timeout:10000});
    expect(results[1].worked).toBe(false);expect(errors).toEqual([]);
   }finally{await transport.close();const cleanup=new ExecutionTransport(transport.installation,process.env.REDIS_URL!);try{await cleanup.queue('text').obliterate({force:true})}finally{await cleanup.close()}}
  }else{
   expect((await executeRequest(pool!,deps,call.request_id,clock)).state).toBe('succeeded');
   expect((await executeRequest(pool!,deps,call.request_id,clock)).worked).toBe(false);
  }
  expect(sent).not.toHaveProperty('max_output_tokens');expect(sent).not.toHaveProperty('expected_output_tokens');
  const operation=await transaction(pool!,tx=>getOperation(tx,scope,clock,call.operation_id));expect(operation).toMatchObject({settlement_status:'settled',captured_units:String((outputTokens*400+1000)*2),reserved_units:'0'});
  expect((await transaction(pool!,tx=>getWallet(tx,scope,clock))).available_units).toBe(String(4000000-(outputTokens*400+1000)*2));
  if(distributed&&outputTokens===10001){
   const capture=(await pool!.query('SELECT capture_id FROM request_budget_claims WHERE request_id=$1',[call.request_id])).rows[0];
   const input={capture_id:capture.capture_id,amount_units:operation.captured_units,external_reference:id('refund'),reason:'Synthetic confirmed overcharge refund',idempotency_key:id('refund')};
   const returned=await transaction(pool!,tx=>refund(tx,scope,clock,input));
   expect(await transaction(pool!,tx=>refund(tx,scope,clock,input))).toEqual(returned);
   const refundedWallet=await transaction(pool!,tx=>getWallet(tx,scope,clock));
   expect(refundedWallet.available_units).toBe('4000000');
   expect((await pool!.query('SELECT unpaid_units::text FROM capture_debts WHERE capture_id=$1',[capture.capture_id])).rows).toEqual([{unpaid_units:'0'}]);
   const transport=new ExecutionTransport(id('after_refund'),process.env.REDIS_URL!),results:Awaited<ReturnType<typeof executeRequest>>[]=[],errors:string[]=[];
   try{
    const worker=transport.consume('text',1,async delivery=>{const result=await executeRequest(pool!,{...deps,limits:{...deps.limits,generation:delivery.generation}},delivery.request_id,clock);results.push(result);return result},error=>errors.push(error.message));
    worker.on('failed',(_job,error)=>errors.push(error.message));
    await transport.publish('text',{request_id:call.request_id,generation:0,purpose:'execute'});
    await vi.waitFor(()=>expect(results).toHaveLength(1),{timeout:10000});
    expect(results[0].worked).toBe(false);expect(errors).toEqual([]);
    expect(await transaction(pool!,tx=>getWallet(tx,scope,clock))).toEqual(refundedWallet);
    expect((await pool!.query('SELECT attempt_count FROM execution_requests WHERE id=$1',[call.request_id])).rows[0].attempt_count).toBe(1);
   }finally{await transport.close();const cleanup=new ExecutionTransport(transport.installation,process.env.REDIS_URL!);try{await cleanup.queue('text').obliterate({force:true})}finally{await cleanup.close()}}
  }
  expect((await executeOne(pool!,deps,clock)).worked).toBe(false);
  if(quota){try{
   if(multi){
    const feedback=(await pool!.query('SELECT result,applied_at FROM quota_result_feedback WHERE request_id=$1',[call.request_id])).rows;
    expect(feedback).toHaveLength(1);expect(feedback[0].applied_at).toBeNull();
    expect(feedback[0].result.limit_usage).toEqual({requests:1,input_tokens:10,output_tokens:outputTokens,tokens:outputTokens+10});
    expect(JSON.stringify(feedback[0].result)).not.toContain('A complete long answer.');
    const recovery=providerAdmission(pool!,process.env.REDIS_URL!,'test');
    let recoveredCounters:unknown;
    try{await replayQuotaFeedback(pool!,async(scope,request,attempt,result)=>{if(request.id===call.request_id)recoveredCounters=result.limit_usage;await recovery.onProviderResult(scope,request,attempt,result)})}finally{await recovery.close()}
    expect(recoveredCounters).toEqual(feedback[0].result.limit_usage);
    expect((await pool!.query('SELECT applied_at IS NOT NULL AS applied FROM quota_result_feedback WHERE request_id=$1',[call.request_id])).rows).toEqual([{applied:true}]);
   }
   const admission=(await pool!.query('SELECT demands FROM dispatch_admissions WHERE request_id=$1 AND group_id=$2',[call.request_id,scope.organization_id])).rows[0];
   expect(Object.fromEntries(admission.demands.map((d:any)=>[d.key,d.amount]))).toEqual({requests:1,input_tokens:1000,output_tokens:4096,tokens:5096});
   const permits=(await pool!.query('SELECT state,slot_released_at IS NOT NULL AS released FROM dispatch_admissions WHERE request_id=$1',[call.request_id])).rows;
   expect(permits).toHaveLength(multi?2:1);expect(permits.every(p=>p.state==='admitted'&&p.released)).toBe(true);
   if(outputTokens>4096){
    expect((await pool!.query('SELECT rule_key,delta_units::text,applied_at IS NOT NULL AS applied FROM quota_usage_adjustments WHERE group_id=$1 ORDER BY rule_key',[scope.organization_id])).rows).toEqual([{rule_key:'output_tokens',delta_units:String(outputTokens-4096),applied:true},{rule_key:'tokens',delta_units:String(outputTokens+10-5096),applied:true}]);
    // Ensure credit remains available before testing the next quota admission.
    await transaction(pool!,tx=>grant(tx,scope,clock,{idempotency_key:'fund-next',source:'purchase',external_reference:id('fund-next'),amount_units:'10000000',expires_at:null,terms_version:'test'}));
   }
   const nextQuote=await transaction(pool!,tx=>createQuote(tx,scope,clock,{idempotency_key:'q2',profile:'text',input:{text:'Hello'},parameters:{expected_output_tokens:4096}}));
   const next=await transaction(pool!,tx=>invoke(tx,scope,clock,{idempotency_key:'invoke2',quote_id:nextQuote.id}));
   await pool!.query("UPDATE execution_requests SET execution_backend='bullmq' WHERE id=$1",[next.request_id]);
   expect((await executeRequest(pool!,deps,next.request_id,clock)).state).toBe('waiting');
   expect((await pool!.query('SELECT attempt_count,reason FROM execution_requests WHERE id=$1',[next.request_id])).rows[0]).toMatchObject({attempt_count:0,reason:'waiting_rate_limit'});
  }finally{await quota.close()}}

 });
});
