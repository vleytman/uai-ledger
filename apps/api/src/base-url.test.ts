import {afterAll,describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {ManualClock,id,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';
import {grant} from '../../../packages/accounting/src/index.js';
import {publishRecipe,invoke} from '../../../packages/quoting/src/index.js';
import {textCalculationExample} from '../../../packages/model-pricing/src/examples.js';
import {calculateQuantities} from '../../../packages/model-pricing/src/index.js';
import {configureBudget,getRequest} from '../../../packages/execution/src/index.js';
import {executeOne} from '../../../packages/execution/src/runtime.js';
import {defaultRuntime} from '../../../packages/execution/src/default-runtime.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end()});
const capabilities={usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null};
const settings=(provider:string,name:string,base_url?:string)=>({provider,name,account_scope:{fixture:name},capabilities,limits:{},risk_policy:{},...(base_url!==undefined?{base_url}:{})});
function textModel(id:string,provider:string,rateCardId:string,base_url?:string){
 const method=textCalculationExample();method.parameters.expected_output_tokens={type:'number',minimum:1,maximum:512,default:128};if(provider==='openai')delete method.parameters.max_output_tokens;
 const output=method.components.find(c=>c.type==='tokens'&&c.direction==='output')!;if(output.type==='tokens'){output.policy='estimated_parameter';output.limit_parameter='expected_output_tokens';delete output.expected;}
 method.samples=method.samples.map(sample=>{const input={...sample.input,parameters:{expected_output_tokens:128}};return {...sample,input,expected:Object.fromEntries(calculateQuantities(method,input).map(c=>[c.key,c.value]))}});
 return {id,provider,...(base_url?{base_url}:{}),text_features:{tools:false,schema:false,image_media_types:[],image_detail:[],cache:provider==='openai'?'automatic' as const:'explicit' as const},status:'active' as const,capabilities:['text.generate' as const],allowed_parameters:Object.keys(method.parameters),calculation:method,rate_card_version_id:rateCardId};
}
describe.skipIf(!pool)('provider base URL from connection and model',()=>{
 it('routes each call to model, then connection, then default address with only that connection key, and guards the setting like the key',async()=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')},clock=new ManualClock(new Date('2026-10-31T00:00:00Z'));
  vi.stubEnv('UAI_VAULT_KEY',randomBytes(32).toString('base64'));vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','true');vi.stubEnv('UAI_ENV','production');
  const sent:{url:string;key:string;model:string}[]=[];
  vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
   const headers=init.headers as Record<string,string>,body=JSON.parse(String(init.body));sent.push({url,key:headers['x-api-key']??headers.authorization.replace('Bearer ',''),model:body.model});
   return url.endsWith('/v1/messages')?Response.json({stop_reason:'end_turn',content:[{type:'text',text:'ok'}],usage:{input_tokens:3,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}}):Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}],usage:{input_tokens:3,output_tokens:2,input_tokens_details:{cached_tokens:0}}});
  });
  const app=createApi(pool!,clock);
  try{
   const tokens=await transaction(pool!,async tx=>{
    await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Base URL fixture']);
    await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
    const issue=(scopes:string[])=>issueToken(tx,{organization_id:scope.organization_id,application_id:scope.application_id,account_ids:null,scopes,max_grant_units:null,expires_at:null});
    return {writer:(await issue(['operations:admin','config:write'])).token,operator:(await issue(['operations:admin'])).token};
   });
   const command=async(token:string,method:'POST'|'PATCH',url:string,payload:unknown)=>app.inject({method,url,headers:{authorization:`Bearer ${token}`,'idempotency-key':id('cmd')},payload:payload as any});
   // Invalid addresses fail when configured, not at call time.
   for(const bad of ['http://gw-a.example.test/v1','http://localhost:8080/v1','https://user:pw@gw-a.example.test/v1','https://gw-a.example.test/v1?key=1','https://gw-a.example.test/v1#x']){
    const r=await command(tokens.writer,'POST','/v1/admin/connections',{settings:settings('openai','bad',bad),reason:'Invalid address'});expect(r.statusCode,bad).toBe(422);expect(r.json().error.code).toBe('invalid_base_url');
   }
   expect((await command(tokens.writer,'POST','/v1/admin/connections',{settings:settings('cartesia','tts','https://gw.example.test'),reason:'Unsupported provider'})).json().error.code).toBe('invalid_base_url');
   const create=async(provider:string,name:string,base_url:string|undefined,key:string)=>{
    const created=await command(tokens.writer,'POST','/v1/admin/connections',{settings:settings(provider,name,base_url),reason:'Gateway fixture'});expect(created.statusCode,created.body).toBe(200);
    const rotated=await command(tokens.writer,'POST',`/v1/admin/connections/${created.json().id}/credential`,{revision:created.json().revision,secret:key,reason:'Fixture key'});expect(rotated.statusCode,rotated.body).toBe(200);
    return rotated.json();
   };
   // Free and paid users of the same model: two OpenAI connections with their own keys and addresses.
   const free=await create('openai','free','https://gw-free.example.test/v1/','key-free');
   const paid=await create('openai','paid','https://gw-paid.example.test/v1','key-paid');
   const direct=await create('openai','direct',undefined,'key-direct');
   const claude=await create('anthropic','claude','https://gw-claude.example.test','key-claude');
   expect(free.base_url).toBe('https://gw-free.example.test/v1');expect(direct.base_url).toBeNull();
   // Changing the address takes the same right as changing the key and is audited like it.
   const changed=settings('openai','paid','https://gw-paid-2.example.test/v1');
   for(const path of [`/v1/admin/connections/${paid.id}`,`/v1/admin/connections/${paid.id}/credential`]){
    const denied=await command(tokens.operator,path.endsWith('credential')?'POST':'PATCH',path,path.endsWith('credential')?{revision:paid.revision,secret:'stolen',reason:'No right'}:{revision:paid.revision,settings:changed,reason:'No right'});
    expect(denied.statusCode,path).toBe(403);
   }
   const updated=await command(tokens.writer,'PATCH',`/v1/admin/connections/${paid.id}`,{revision:paid.revision,settings:changed,reason:'Move paid users to the second gateway'});expect(updated.statusCode,updated.body).toBe(200);
   const audit=(await pool!.query("SELECT action,reason,metadata FROM audit_events WHERE resource_id=$1 ORDER BY created_at,action",[paid.id])).rows;
   expect(audit.filter(a=>a.action==='connection.base_url_changed')).toEqual([{action:'connection.base_url_changed',reason:'Move paid users to the second gateway',metadata:{previous_base_url:'https://gw-paid.example.test/v1',base_url:'https://gw-paid-2.example.test/v1'}}]);
   // An unchanged address on a later update leaves no base URL event.
   await command(tokens.writer,'PATCH',`/v1/admin/connections/${paid.id}`,{revision:updated.json().revision,settings:{...changed,limits:{requests:'5'}},reason:'Limits only'});
   expect((await pool!.query("SELECT count(*)::int n FROM audit_events WHERE resource_id=$1 AND action='connection.base_url_changed'",[paid.id])).rows[0].n).toBe(1);

   const profiles=await transaction(pool!,async tx=>{
    const catalog=new CatalogService(tx,clock);
    await expect(catalog.publish(scope,(await catalog.createDraft(scope,{kind:'catalog',key:'bad',version:1,author:'fixture',comment:'Bad address',payload:{models:[{...textModel('m','openai','rc'),base_url:'http://gw.example.test/v1'}]}})).id,1)).rejects.toMatchObject({code:'invalid_base_url'});
    const cards:Record<string,string>={};
    for(const provider of ['openai','anthropic']){
     const card=await catalog.createDraft(scope,{kind:'rate_card',key:provider,version:1,author:'fixture',comment:'Synthetic prices',payload:{id:provider,currency:'USD',source:'Synthetic fixture only',checked_at:clock.now().toISOString(),rates:[{id:'input',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01'},{id:'output',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000002',effective_from:'2026-01-01'},{id:'cached',dimension:'input.cache_read',unit:'tokens',unit_size:'1',amount:'0.0000000001',effective_from:'2026-01-01'},{id:'write',dimension:'input.cache_write',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01'}]}});
     await catalog.publish(scope,card.id,1,[{usage:{state:'known',items:[{dimension:'output.text',unit:'tokens',quantity:'1'}]},context:{at:clock.now().toISOString()}}]);cards[provider]=card.id;
    }
    const openai=await catalog.createDraft(scope,{kind:'catalog',key:'openai',version:1,author:'fixture',comment:'Same connection, one model through its own gateway',payload:{models:[textModel('fixture-luna','openai',cards.openai),textModel('fixture-luna-gw','openai',cards.openai,'https://model-gw.example.test/v1/')]}});await catalog.publish(scope,openai.id,1);
    const anthropic=await catalog.createDraft(scope,{kind:'catalog',key:'anthropic',version:1,author:'fixture',comment:'Anthropic gateway',payload:{models:[textModel('fixture-claude','anthropic',cards.anthropic)]}});await catalog.publish(scope,anthropic.id,1);
    await configureBudget(tx,scope,'period','period','1000000');
    const keys:{key:string;connection:string}[]=[];
    for(const [key,connection,catalogId,model] of [['free',free.id,openai.id,'fixture-luna'],['free-gw',free.id,openai.id,'fixture-luna-gw'],['paid',paid.id,openai.id,'fixture-luna'],['direct',direct.id,openai.id,'fixture-luna'],['claude',claude.id,anthropic.id,'fixture-claude']] as const){
     if(!keys.some(k=>k.connection===connection))await configureBudget(tx,scope,'provider',connection,'1000000');
     const route=await catalog.createDraft(scope,{kind:'route',key,version:1,author:'fixture',comment:'Fixture route',payload:{capability:'text.generate',primary:{catalog_version_id:catalogId,connection_id:connection,model,max_cost_units:'100000'},platform_risk_budget_units:'400000'}});await catalog.publish(scope,route.id,1);
     await publishRecipe(tx,scope,clock,{key,version:1,period_budget_key:'period',components:[{key:'text',capability:'text.generate',count:{constant:1},route_version_id:route.id,rate_card_version_id:'',limits:{},pricing_mode:'estimated_actual'}]});
     keys.push({key,connection});
    }
    await grant(tx,scope,clock,{amount_units:'100000',source:'internal',reason:'fixture',terms_version:'v1',expires_at:null,external_reference:'fixture',idempotency_key:'fund'});
    return keys;
   });
   const requests:Record<string,string>={};
   for(const {key} of profiles)requests[key]=(await transaction(pool!,tx=>invoke(tx,scope,clock,{idempotency_key:key,profile:key,input:{messages:[{role:'user',content:[{type:'text',text:`Hello from ${key}`}]}]}}))).request_id;
   const deps=defaultRuntime(pool!,clock);deps.limits={scope};deps.onDelta=undefined;
   for(let i=0;i<profiles.length;i++)expect((await executeOne(pool!,deps,clock)).state).toBe('succeeded');
   for(const key of Object.keys(requests))expect((await getRequest(pool!,scope,requests[key])).execution_status,key).toBe('succeeded');
   expect(sent.sort((a,b)=>a.url.localeCompare(b.url)||a.model.localeCompare(b.model))).toEqual([
    {url:'https://api.openai.com/v1/responses',key:'key-direct',model:'fixture-luna'},
    {url:'https://gw-claude.example.test/v1/messages',key:'key-claude',model:'fixture-claude'},
    {url:'https://gw-free.example.test/v1/responses',key:'key-free',model:'fixture-luna'},
    {url:'https://gw-paid-2.example.test/v1/responses',key:'key-paid',model:'fixture-luna'},
    {url:'https://model-gw.example.test/v1/responses',key:'key-free',model:'fixture-luna-gw'},
   ]);
   // Provider spend stays with the connection that made the call.
   const costs=(await pool!.query('SELECT connection_id,count(*)::int n FROM provider_cost_entries WHERE organization_id=$1 GROUP BY connection_id',[scope.organization_id])).rows;
   expect(Object.fromEntries(costs.map(r=>[r.connection_id,r.n]))).toEqual({[free.id]:2,[paid.id]:1,[direct.id]:1,[claude.id]:1});
  }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();await app.close();}
 });
});
