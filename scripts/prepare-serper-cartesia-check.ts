import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createPool,transaction} from '../packages/db/src/index.js';
import {hash,systemClock as clock,type Scope} from '../packages/contracts/src/index.js';
import {CatalogService,type ConfigurationKind,type ConfigurationPayload,type PublishSample} from '../packages/catalog/src/index.js';
import {ConnectionService,audit} from '../packages/reconciliation/src/connections.js';
import {configureBudget,configureLimiter} from '../packages/execution/src/index.js';
import {createQuote,publishRecipe,type RecipeComponent,type RecipeDefinition} from '../packages/quoting/src/index.js';
import type {RateCard} from '../packages/pricing/src/index.js';

// Configuration/quotes only. No credential resolution or provider requests.
if(process.env.UAI_ENV!=='test')throw new Error('UAI_ENV=test is required');
const database=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(database.hostname)||database.pathname!=='/uai_local')throw new Error('Only local uai_local is permitted');
const conf=JSON.parse(await readFile('.data/demo-config.json','utf8'));
const actor={actor_id:'serper-cartesia-check',reason:'Owner approved USD 0.50 total for one Serper search and one Cartesia speech request, without retries'};
const period='check.serper-cartesia.run';
const voice='db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
const format={container:'wav',encoding:'pcm_s16le',sample_rate:44100};
const plans:Array<{provider:'serper'|'cartesia';model:string;capability:RecipeComponent['capability'];input:Record<string,string>;parameters:Record<string,unknown>;limits:RecipeComponent['limits'];dimension:string;unit:string;quantity:string;unit_size:string;amount:string;cap:string;source:string}>=[
 {provider:'serper',model:'serper-google-search',capability:'search',input:{query:'OpenAI official website'},parameters:{gl:'us',hl:'en',num:10,page:1},limits:{max_assets:0,parameter_values:{gl:['us'],hl:['en'],num:[10],page:[1]}},dimension:'tool.search',unit:'credits',quantity:'10',unit_size:'1000',amount:'1',cap:'10000000',source:'https://serper.dev/'},
 {provider:'cartesia',model:'sonic-3.6-2026-08-27',capability:'speech.synthesize',input:{text:'Hello from UAI.',voice},parameters:{language:'en',output_format:format},limits:{input_characters:32,max_assets:0,parameter_values:{voice:[voice],language:['en'],output_format:[format]}},dimension:'audio.characters',unit:'characters',quantity:'32',unit_size:'1000000',amount:'65',cap:'2080000',source:'https://www.cartesia.ai/pricing'},
];
const pool=createPool();
try{
 const prepared=await transaction(pool,async tx=>{
  const account=(await tx.query('SELECT id,organization_id,application_id FROM accounts WHERE id=$1',[conf.account_id])).rows[0];assert(account);
  const scope:Scope={organization_id:account.organization_id,application_id:account.application_id,account_id:account.id};
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${scope.organization_id}:${scope.application_id}:${period}`]);
  const service=new ConnectionService(tx,clock),catalog=new CatalogService(tx,clock);
  async function publish(kind:ConfigurationKind,key:string,payload:ConfigurationPayload,samples:PublishSample[]=[]){
   const prior=(await catalog.list(scope,kind)).find(row=>row.key===key&&row.version===1);
   if(prior){assert.equal(hash(prior.payload),hash(payload),'Published check profile changed');if(prior.status==='published')return prior;return catalog.publish(scope,prior.id,prior.revision,samples);}
   const draft=await catalog.createDraft(scope,{kind,key,version:1,payload,author:actor.actor_id,comment:actor.reason});return catalog.publish(scope,draft.id,draft.revision,samples);
  }
  await configureBudget(tx,scope,'period',period,'500000000');
  const checks=[];
  for(const plan of plans){
   const connections=(await service.list(scope)).filter(c=>c.provider===plan.provider&&c.status==='enabled'&&['configured','verified'].includes(c.credential_status));assert.equal(connections.length,1);
   const connection=connections[0],key=`check.${plan.provider}.single`;
   const attempted=(await tx.query("SELECT count(*)::int n FROM execution_attempts WHERE variant->>'connection_id'=$1",[connection.id])).rows[0];assert.equal(attempted.n,0,'This run requires an unused connection');
   await configureBudget(tx,scope,'provider',connection.id,'250000000');
   await audit(tx,scope,clock,actor,'execution_budget.updated',connection.id,{kind:'provider',limit_units:'250000000'});
   await configureLimiter(tx,scope,clock,{key,window_ms:86400000,request_limit:1,token_limit:'0',concurrency_limit:1});
   const model=await publish('catalog',`${key}.catalog`,{models:[{id:plan.model,provider:plan.provider,capabilities:[plan.capability],allowed_parameters:plan.provider==='cartesia'?['voice','language','output_format']:['gl','hl','num','page'],status:'active'}]});
   const card:RateCard={id:`${key}.v1`,currency:'USD',source:plan.source,checked_at:'2026-09-18T22:48:00Z',rates:[{id:plan.provider,dimension:plan.dimension,unit:plan.unit,unit_size:plan.unit_size,amount:plan.amount,effective_from:'2026-09-18T00:00:00Z',conditions:{model:plan.model}}]};
   const items=[{dimension:plan.dimension,unit:plan.unit,quantity:plan.quantity}];
   const rate=await publish('rate_card',`${key}.rates`,card,[{usage:{state:'known',items},context:{at:clock.now().toISOString(),connection_id:connection.id,conditions:{model:plan.model}}}]);
   const route=await publish('route',key,{capability:plan.capability,primary:{catalog_version_id:model.id,connection_id:connection.id,model:plan.model,max_cost_units:plan.cap,limiter_key:key},deadline_seconds:180,platform_risk_budget_units:plan.cap});
   const component:RecipeComponent={key:plan.provider,capability:plan.capability,route_version_id:route.id,rate_card_version_id:rate.id,count:{constant:1},limits:plan.limits,maximum_items:items,conditions:{model:plan.model}};
   const definition:RecipeDefinition={key,version:1,period_budget_key:period,components:[component],deadline_seconds:180,content_ttl_seconds:3600,partial_policy:'successful_parts',settlement:'actual_usage',actor_id:actor.actor_id};
   const prior=(await tx.query('SELECT * FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3 AND version=1',[scope.organization_id,scope.application_id,key])).rows[0];if(prior)assert.equal(hash(prior.definition),hash(definition));else await publishRecipe(tx,scope,clock,definition);
   const body={account_id:scope.account_id,wallet_id:conf.wallet_id,kind:'single_call' as const,profile:key,input:plan.input,parameters:plan.parameters,budget:{max_units:plan.cap}};
   const quote=await createQuote(tx,scope,clock,{...body,idempotency_key:`prepare:${key}:v1`});assert.equal(quote.max_units,plan.cap);
   checks.push({provider:plan.provider,model:plan.model,connection_id:connection.id,credential_revision:connection.credential_revision,body,quote_id:quote.id,max_units:quote.max_units,route_version_id:route.id,rate_card_version_id:rate.id});
  }
  await audit(tx,scope,clock,actor,'serper_cartesia_check.prepared',period,{budget_units:'500000000',provider_calls:0});
  return {prepared_at:clock.now().toISOString(),scope,wallet_id:conf.wallet_id,approved_usd:'0.50',budget_units:'500000000',period_budget_key:period,cartesia_api_version:'2026-08-14',checks};
 });
 await writeFile('.data/serper-cartesia-check.json',JSON.stringify(prepared,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({prepared:true,provider_calls:0,budget_usd:prepared.approved_usd,checks:prepared.checks.map(c=>({provider:c.provider,max_units:c.max_units}))}));
}finally{await pool.end();}
