import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createPool,transaction} from '../packages/db/src/index.js';
import {hash,systemClock as clock,type Scope} from '../packages/contracts/src/index.js';
import {CatalogService,type ConfigurationKind,type ConfigurationPayload,type PublishSample} from '../packages/catalog/src/index.js';
import {ConnectionService,audit} from '../packages/reconciliation/src/connections.js';
import {configureBudget,configureLimiter} from '../packages/execution/src/index.js';
import {createQuote,publishRecipe,type RecipeComponent,type RecipeDefinition} from '../packages/quoting/src/index.js';
import {rateMaximum,type RateCard} from '../packages/pricing/src/index.js';

// Configuration only. This script does not resolve credentials or call any provider.
if(process.env.UAI_ENV!=='test')throw new Error('UAI_ENV=test is required');
const database=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(database.hostname)||database.pathname!=='/uai_local')throw new Error('Only the local uai_local test database is permitted');
const admin=JSON.parse(await readFile(resolve('.data/admin-config.json'),'utf8'));
const actor={actor_id:'openai-check-preparation',reason:'Owner approved up to USD 1 for this OpenAI test run; prepare isolated profiles without provider calls'};
const textModel='gpt-4.1-mini-2025-04-14',imageModel='gpt-image-1-mini',periodKey='check.openai.run',limiterKey='check.openai.run';
const pool=createPool();
try{
 const prepared=await transaction(pool,async tx=>{
  const account=(await tx.query('SELECT id,organization_id,application_id FROM accounts WHERE id=$1',[admin.account_id])).rows[0];if(!account)throw new Error('Configured account not found');
  const scope:Scope={organization_id:account.organization_id,application_id:account.application_id,account_id:account.id};
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${scope.organization_id}:${scope.application_id}:check.openai.setup`]);
  const service=new ConnectionService(tx,clock);const candidates=(await service.list(scope)).filter(c=>c.provider==='openai'&&c.status==='enabled'&&['configured','verified'].includes(c.credential_status));
  if(candidates.length!==1)throw new Error('Exactly one enabled OpenAI connection with a configured credential is required');
  let connection=candidates[0];
  if(connection.limits.max_input_tokens!=='1000')connection=await service.update(scope,connection.id,connection.revision,{provider:connection.provider,name:connection.name,account_scope:connection.account_scope,capabilities:connection.capabilities,limits:{...connection.limits,max_input_tokens:'1000'},risk_policy:connection.risk_policy},actor);
  for(const [kind,key] of [['provider',connection.id],['period',periodKey]] as const){const existing=(await tx.query('SELECT * FROM execution_budgets WHERE organization_id=$1 AND kind=$2 AND budget_key=$3',[scope.organization_id,kind,key])).rows[0];if(existing&&(BigInt(existing.reserved_units)+BigInt(existing.spent_units)>1000000000n))throw new Error('Existing usage exceeds the authorized run budget');if(existing?.limit_units!=='1000000000'){await configureBudget(tx,scope,kind,key,'1000000000');await audit(tx,scope,clock,actor,'execution_budget.updated',key,{kind,limit_units:'1000000000'});}}
  const limiter={key:limiterKey,window_ms:60000,request_limit:6,token_limit:'100000',concurrency_limit:1};
  const existingLimiter=(await tx.query('SELECT * FROM execution_limiters WHERE organization_id=$1 AND limiter_key=$2',[scope.organization_id,limiterKey])).rows[0];
  if(!existingLimiter||existingLimiter.window_ms!==limiter.window_ms||existingLimiter.request_limit!==limiter.request_limit||existingLimiter.token_limit!==limiter.token_limit||existingLimiter.concurrency_limit!==1){await configureLimiter(tx,scope,clock,limiter);await audit(tx,scope,clock,actor,'execution_limiter.updated',limiterKey,limiter);}
  const catalog=new CatalogService(tx,clock);
  async function publish(kind:ConfigurationKind,key:string,payload:ConfigurationPayload,samples:PublishSample[]=[],version=1){const existing=(await catalog.list(scope,kind)).find(v=>v.key===key&&v.version===version);if(existing){if(hash(existing.payload)!==hash(payload))throw new Error(`Existing ${key} v${version} differs; refusing to replace it`);if(existing.status==='published')return existing;return catalog.publish(scope,existing.id,existing.revision,samples);}const draft=await catalog.createDraft(scope,{kind,key,version,payload,author:actor.actor_id,comment:actor.reason});return catalog.publish(scope,draft.id,draft.revision,samples);}
  const models=await publish('catalog','check.openai.models',{models:[{id:textModel,provider:'openai',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'},{id:imageModel,provider:'openai',capabilities:['image.generate'],allowed_parameters:['count','size','quality','output_format'],status:'active'}]});
  const common={unit:'tokens',unit_size:'1000000',effective_from:'2026-09-18T00:00:00Z'};
  // Recheck official pricing sources before an authorized live run; see docs/LOCAL_RUN.md.
  const textCard:RateCard={id:'check.openai.text.v1',currency:'USD',source:'https://developers.openai.com/api/docs/pricing',checked_at:'2026-09-19T00:00:00Z',rates:[{...common,id:'text-input',dimension:'input.uncached',amount:'0.40',conditions:{model:textModel}},{...common,id:'text-cache',dimension:'input.cache_read',amount:'0.10',conditions:{model:textModel}},{...common,id:'text-output',dimension:'output.text',amount:'1.60',conditions:{model:textModel}}]};
  const imageCard:RateCard={id:'check.openai.image.v1',currency:'USD',source:'https://developers.openai.com/api/docs/guides/image-generation#earlier-gpt-image-models',checked_at:'2026-09-19T00:00:00Z',rates:[{...common,id:'image-text-input',dimension:'input.uncached',amount:'2.00',conditions:{model:imageModel,modality:'text'}},{...common,id:'image-text-cache',dimension:'input.cache_read',amount:'0.20',conditions:{model:imageModel,modality:'text'}},{...common,id:'image-image-input',dimension:'input.uncached',amount:'2.50',conditions:{model:imageModel,modality:'image'}},{...common,id:'image-image-cache',dimension:'input.cache_read',amount:'0.25',conditions:{model:imageModel,modality:'image'}},{...common,id:'image-output',dimension:'output.image',amount:'8.00',conditions:{model:imageModel,modality:'image'}}]};
  const cardSample=(card:RateCard):PublishSample[]=>[{usage:{state:'known',items:card.rates.map(r=>({dimension:r.dimension,unit:r.unit,quantity:'1',conditions:r.conditions}))},context:{at:clock.now().toISOString(),connection_id:connection.id}}];
  const textRates=await publish('rate_card','check.openai.text.pricing',textCard,cardSample(textCard));const imageRates=await publish('rate_card','check.openai.image.pricing',imageCard,cardSample(imageCard));
  const components:RecipeComponent[]=[];const routeIds:Record<string,string>={};
  for(const [key,capability,model,rateCard,maxCost] of [['check.openai.text','text.generate',textModel,textRates,'1000000'],['check.openai.image','image.generate',imageModel,imageRates,'110000000']] as const){
   const route=await publish('route',key,{capability,primary:{catalog_version_id:models.id,model,connection_id:connection.id,max_cost_units:maxCost,limiter_key:limiterKey},deadline_seconds:1800,platform_risk_budget_units:(BigInt(maxCost)*4n).toString()},[],capability==='image.generate'?2:1);routeIds[key]=route.id;
   components.push(capability==='text.generate'?{key:'description',capability,route_version_id:route.id,rate_card_version_id:rateCard.id,count:{constant:1},limits:{input_tokens:1000,output_tokens:128,max_assets:0},conditions:{model}}:{key:'image',capability,route_version_id:route.id,rate_card_version_id:rateCard.id,count:{constant:1},limits:{image_count:1,image_sizes:['1024x1024'],image_qualities:['low'],max_assets:0,parameter_values:{output_format:['png']}},conditions:{model},maximum_items:[{dimension:'input.uncached',unit:'tokens',quantity:'12000',conditions:{modality:'text'}},{dimension:'input.uncached',unit:'tokens',quantity:'0',conditions:{modality:'image'}},{dimension:'output.image',unit:'tokens',quantity:'10000',conditions:{modality:'image'}}]});
  }
  const recipes=[];
  for(const [key,parts] of [['check.openai.text',[components[0]]],['check.openai.image',[components[1]]],['check.openai.description-image',components]] as const){
   const version=key==='check.openai.text'?1:2;
   const definition:RecipeDefinition={key,version,components:[...parts],period_budget_key:periodKey,deadline_seconds:1800,content_ttl_seconds:3600,partial_policy:'successful_parts',settlement:'actual_usage',actor_id:actor.actor_id};
   const existing=(await tx.query('SELECT * FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3 AND version=$4',[scope.organization_id,scope.application_id,key,version])).rows[0];if(existing&&hash(existing.definition)!==hash(definition))throw new Error(`Existing recipe ${key} v${version} differs`);const row=existing??await publishRecipe(tx,scope,clock,definition);recipes.push({id:row.id,...definition});
  }
  const textMaximum=rateMaximum({state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'1000'},{dimension:'output.text',unit:'tokens',quantity:'128'}]},textCard,{at:clock.now().toISOString(),conditions:components[0].conditions,connection_id:connection.id});
  const imageMaximum=rateMaximum({state:'known',items:components[1].maximum_items!},imageCard,{at:clock.now().toISOString(),conditions:components[1].conditions,connection_id:connection.id});
  if(textMaximum.state!=='calculated'||textMaximum.rounded_units!==604800n||imageMaximum.state!=='calculated'||imageMaximum.rounded_units!==104000000n)throw new Error('Pricing does not match approved plan');
  const baselineBudget=(await tx.query("SELECT spent_units,reserved_units,limit_units FROM execution_budgets WHERE organization_id=$1 AND kind='provider' AND budget_key=$2",[scope.organization_id,connection.id])).rows[0];
  const walletBefore=(await tx.query('SELECT revision FROM wallets WHERE id=$1',[admin.wallet_id])).rows[0];const quotes=[];
  for(const key of ['check.openai.text','check.openai.image','check.openai.description-image']){const composite=key.endsWith('description-image');const isText=key.endsWith('.text');const recipeVersion=key==='check.openai.text'?1:2;const quote=await createQuote(tx,scope,clock,{idempotency_key:`prepare:${key}:v${recipeVersion}`,wallet_id:admin.wallet_id,kind:composite?'recipe':'single_call',...(composite?{recipe:{key,version:recipeVersion},inputs:{}}:{profile:key,input:isText?{text:'Reply with the word ready.'}:{prompt:'A blue circle centered on a white background.'},parameters:isText?{max_output_tokens:128}:{count:1,size:'1024x1024',quality:'low',output_format:'png'}})});const expected=composite?'111000000':isText?'1000000':'110000000';if(quote.max_units!==expected)throw new Error(`Unexpected quote maximum for ${key}`);quotes.push({profile:key,...quote});}
  const walletAfter=(await tx.query('SELECT revision FROM wallets WHERE id=$1',[admin.wallet_id])).rows[0];if(walletBefore.revision!==walletAfter.revision)throw new Error('Quote preparation changed wallet revision');
  await audit(tx,scope,clock,actor,'openai_check.prepared',connection.id,{profiles:recipes.map(r=>r.key),budget_units:'1000000000'});
  return {prepared_at:clock.now().toISOString(),scope,wallet_id:admin.wallet_id,connection_id:connection.id,connection_revision:connection.revision,budget_units:'1000000000',period_budget_key:periodKey,limiter_key:limiterKey,catalog_version_id:models.id,rate_card_versions:{text:textRates.id,image:imageRates.id},route_versions:routeIds,recipes,quotes,estimated_cost_units:{text:'604800',image:'104000000'},provider_budget_baseline:baselineBudget,provider_calls_made:0,notes:['Image output bound10000 is a conservative test allowance, not a provider-guaranteed model-specific token count; supersedes v1 bound272.','Quotes are preparation evidence only and expire; create fresh quotes for execution.','No credentials copied. Real-provider flags unchanged.']};
 });
 await mkdir(resolve('.data'),{recursive:true});const output=resolve('.data/openai-check.json');await writeFile(output,JSON.stringify(prepared,null,2),{mode:0o600});await chmod(output,0o600);
 console.log(JSON.stringify({prepared:true,profiles:prepared.recipes.map(r=>r.key),quotes:prepared.quotes.map(q=>({profile:q.profile,max_units:q.max_units})),provider_calls_made:0,output:'.data/openai-check.json'}));
}finally{await pool.end()}
