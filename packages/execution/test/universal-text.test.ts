import {observePrefix} from '../../quoting/src/cache.js';
import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {ManualClock,id,type Scope} from '../../contracts/src/index.js';
import {CatalogService} from '../../catalog/src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {grant,getWallet} from '../../accounting/src/index.js';
import {publishRecipe,invoke,createQuote} from '../../quoting/src/index.js';
import {textCalculationExample} from '../../model-pricing/src/examples.js';
import {calculateQuantities} from '../../model-pricing/src/index.js';
import {OpenAIAdapter,AnthropicAdapter} from '../../providers/src/index.js';
import {getDelivery} from '../../storage/src/index.js';
import {configureBudget,getRequest} from '../src/index.js';
import {executeOne} from '../src/runtime.js';
import {defaultRuntime} from '../src/default-runtime.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool)('UI-I03 text across providers',()=>{
 it('fallback uses its own accepted rate card, output limit and markup; tools remain application-owned',async()=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')},clock=new ManualClock(new Date('2026-09-25T00:00:00Z'));
  await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Text fixture']);
   await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
   const catalog=new CatalogService(tx,clock),targets=[];
   for(const provider of ['openai','anthropic']){
    const connection=await new ConnectionService(tx,clock).create(scope,{provider,name:'Mock only',account_scope:{fixture:provider},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'Mock transport'});
    await tx.query("UPDATE provider_connections SET credential_status='configured' WHERE id=$1",[connection.id]);
    await configureBudget(tx,scope,'provider',connection.id,'1000000');
    const card=await catalog.createDraft(scope,{kind:'rate_card',key:provider,version:1,author:'fixture',comment:'Synthetic prices',payload:{id:provider,currency:'USD',source:'Synthetic fixture only',checked_at:clock.now().toISOString(),rates:[{id:'input',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:provider==='openai'?'0.000000001':'0.000000003',effective_from:'2026-01-01'},{id:'output',dimension:'output.text',unit:'tokens',unit_size:'1',amount:provider==='openai'?'0.000000002':'0.000000005',effective_from:'2026-01-01'},{id:'cached',dimension:'input.cache_read',unit:'tokens',unit_size:'1',amount:'0.0000000001',effective_from:'2026-01-01'}]}});
    await catalog.publish(scope,card.id,1,[{usage:{state:'known',items:[{dimension:'output.text',unit:'tokens',quantity:'1'}]},context:{at:clock.now().toISOString()}}]);
    const method=textCalculationExample();
    method.parameters.expected_output_tokens={type:'number',minimum:1,maximum:512,default:128};
    if(provider==='openai')delete method.parameters.max_output_tokens;
    const output=method.components.find(c=>c.type==='tokens'&&c.direction==='output')!;
    if(output.type==='tokens'){output.policy='estimated_parameter';output.limit_parameter='expected_output_tokens';delete output.expected;}
    method.pricing.markup_percent=provider==='openai'?'100':'50';
    method.samples=method.samples.map(sample=>{const input={...sample.input,parameters:{expected_output_tokens:128}};return {...sample,input,expected:Object.fromEntries(calculateQuantities(method,input).map(c=>[c.key,c.value]))}});
    const model=await catalog.createDraft(scope,{kind:'catalog',key:provider,version:1,author:'fixture',comment:'Mock model',payload:{models:[{id:`fixture-${provider}`,provider,text_features:{tools:true,schema:true,image_media_types:[],image_detail:[],cache:provider==='openai'?'automatic':'explicit'},status:'active',capabilities:['text.generate'],allowed_parameters:Object.keys(method.parameters),calculation:method,rate_card_version_id:card.id}]}});
    await catalog.publish(scope,model.id,1);targets.push({catalog_version_id:model.id,connection_id:connection.id,model:`fixture-${provider}`,max_cost_units:'100000'});
   }
   await configureBudget(tx,scope,'period','period','1000000');
   const route=await catalog.createDraft(scope,{kind:'route',key:'text',version:1,author:'fixture',comment:'Cross provider',payload:{capability:'text.generate',primary:targets[0],fallback:targets[1],platform_risk_budget_units:'400000'}});await catalog.publish(scope,route.id,1);
   await publishRecipe(tx,scope,clock,{key:'text',version:1,period_budget_key:'period',components:[{key:'text',capability:'text.generate',count:{constant:1},route_version_id:route.id,rate_card_version_id:'',limits:{},pricing_mode:'estimated_actual'}]});
   await grant(tx,scope,clock,{amount_units:'100000',source:'internal',reason:'fixture',terms_version:'v1',expires_at:null,external_reference:'fixture',idempotency_key:'fund'});
  });
  const call=await transaction(pool!,tx=>invoke(tx,scope,clock,{idempotency_key:'call',profile:'text',input:{messages:[{role:'user',content:[{type:'text',text:'Choose count'}]}],tools:[{name:'select',parameters:{type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false}}],tool_choice:{type:'named',name:'select'}}}));
  const deps=defaultRuntime(pool!,clock);deps.limits={scope};deps.onDelta=undefined;
  let primaryCalls=0,fallbackCalls=0;
  deps.adapter=async(_scope,variant)=>variant.model==='fixture-openai'?new OpenAIAdapter({apiKey:'fixture',models:[variant.model],fetch:async()=>{primaryCalls++;return Response.json({error:{code:'rate_limit_exceeded'},usage:{input_tokens:0,output_tokens:0,input_tokens_details:{cached_tokens:0}}},{status:429})}}):new AnthropicAdapter({apiKey:'fixture',models:[variant.model],fetch:async(_url,init)=>{fallbackCalls++;const body=JSON.parse(String(init.body));expect(body.max_tokens).toBe(128);expect(body.tool_choice).toEqual({type:'tool',name:'select',disable_parallel_tool_use:true});return Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:'provider-call',name:'select',input:{count:2}}],usage:{input_tokens:10,output_tokens:4,cache_read_input_tokens:0,cache_creation_input_tokens:0}})}});
  for(let i=0;i<2;i++){expect((await executeOne(pool!,deps,clock)).state).toBe('waiting_retry');const request=await getRequest(pool!,scope,call.request_id);clock.advance(new Date(request.not_before).getTime()-clock.now().getTime());}
  expect((await executeOne(pool!,deps,clock)).state).toBe('succeeded');expect(primaryCalls).toBe(2);expect(fallbackCalls).toBe(1);
  expect(await transaction(pool!,tx=>getWallet(tx,scope,clock))).toMatchObject({balance_units:'99925',reserved_units:'0'});
  const delivery=await getDelivery(pool!,scope,clock,call.request_id);expect(delivery?.result).toMatchObject({content:{type:'tool_call',name:'select',arguments:{count:2},provider_id:'provider-call'}});
  expect((delivery?.result as any).content.id).toBe('provider-call');expect(await getDelivery(pool!,scope,clock,call.request_id)).toEqual(delivery);
  expect((await pool!.query('SELECT rounded_units FROM provider_cost_entries WHERE organization_id=$1 ORDER BY rounded_units',[scope.organization_id])).rows.map(row=>row.rounded_units)).toEqual(['0','0','50']);
  // A separate owner has enough for an observed warm forecast, but not the cold quote.
  const warmScope={...scope,account_id:id('warm')};
  await transaction(pool!,async tx=>{await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$1)',[warmScope.account_id,scope.organization_id,scope.application_id]);await grant(tx,warmScope,clock,{amount_units:'1',source:'internal',reason:'Fixture',terms_version:'v1',expires_at:null,external_reference:'initial',idempotency_key:'initial'});});
  const warmInput={messages:[{role:'user',content:[{type:'text',text:'Stable private prefix '.repeat(100),cache:{boundary:'stable_prefix'}}]}]};
  const cold=await transaction(pool!,tx=>createQuote(tx,warmScope,clock,{profile:'text',input:warmInput,idempotency_key:'cold'}));
  const stored=(await pool!.query('SELECT components FROM quotes WHERE id=$1',[cold.id])).rows[0],variant=stored.components[0].route.primary;
  await transaction(pool!,tx=>observePrefix(tx,warmScope,clock,variant.connection_id,variant.model,variant.cache_identity,{state:'known',items:[{dimension:'input.cache_read',quantity:'100000',unit:'tokens'}]}));
  const warm=await transaction(pool!,tx=>createQuote(tx,warmScope,clock,{profile:'text',input:warmInput,idempotency_key:'warm'}));
  expect(BigInt(warm.estimated_units)).toBeLessThan(BigInt(cold.estimated_units));
  await transaction(pool!,tx=>grant(tx,warmScope,clock,{amount_units:(BigInt(warm.estimated_units)-1n).toString(),source:'internal',reason:'Warm forecast funds',terms_version:'v1',expires_at:null,external_reference:'warm',idempotency_key:'warm-funds'}));
  await expect(transaction(pool!,tx=>invoke(tx,warmScope,clock,{quote_id:cold.id,idempotency_key:'cold-admission'}))).rejects.toMatchObject({code:'insufficient_credits'});
  const accepted=await transaction(pool!,tx=>invoke(tx,warmScope,clock,{quote_id:warm.id,idempotency_key:'warm-admission'}));
  const warmDeps=defaultRuntime(pool!,clock);warmDeps.limits={scope:warmScope};warmDeps.onDelta=undefined;
  warmDeps.adapter=async(_scope,variant)=>new OpenAIAdapter({apiKey:'fixture',models:[variant.model],fetch:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Cache miss result'}]}],usage:{input_tokens:2000,output_tokens:512,input_tokens_details:{cached_tokens:0}}})});
  expect((await executeOne(pool!,warmDeps,clock)).state).toBe('succeeded');
  const wallet=await transaction(pool!,tx=>getWallet(tx,warmScope,clock));expect(BigInt(wallet.available_units)).toBeLessThan(0n);expect(wallet.reserved_units).toBe('0');
  expect((await getRequest(pool!,warmScope,accepted.request_id)).attempt_count).toBe(1);
  const metadata=await pool!.query('SELECT * FROM prefix_cache_observations WHERE account_id=$1',[warmScope.account_id]);expect(JSON.stringify(metadata.rows)).not.toContain('Stable private prefix');expect(metadata.rows[0].read_tokens).toBe('0');

 });
});
