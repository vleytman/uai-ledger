/** Follow-up within the original $0.10 allowance. No repeat after an unknown outcome. */
import assert from 'node:assert/strict';
import {readFile,writeFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {getEncoding} from 'js-tiktoken';
import {transaction} from '../packages/db/src/index.js';
import {systemClock} from '../packages/contracts/src/index.js';
import {CatalogService,type CatalogDefinition,type RouteDefinition} from '../packages/catalog/src/index.js';
import {ConnectionService,CredentialVault} from '../packages/reconciliation/src/connections.js';
import {loadRuntimeSecrets} from '../packages/runtime-config/src/index.js';
import {publishRecipe,invoke} from '../packages/quoting/src/index.js';
import {defaultRuntime} from '../packages/execution/src/default-runtime.js';
import {executeOne} from '../packages/execution/src/runtime.js';
import {getDelivery,acknowledge} from '../packages/storage/src/index.js';
import {OpenAIAdapter,type ProviderInput} from '../packages/providers/src/index.js';

const live=process.argv.includes('--execute-approved');
assert(process.argv.slice(2).every(a=>['--execute-approved','--plan'].includes(a)));
const root=resolve('.data/universal-live-approved');
const prior=JSON.parse(await readFile(resolve(root,'evidence.json'),'utf8'));
assert.equal(prior.approved_usd,'0.10');assert.equal(prior.network.length,8);assert(prior.completed_at);
const scope=prior.scope,connection=prior.connection_id,model='gpt-4.1-mini-2025-04-14',nonce=randomUUID();
const key=`uai-cache-${nonce}`;
const prefix=`Cache diagnostic ${nonce}. Answer only OK after reading the reference.\n`+Array.from({length:500},(_,i)=>`Reference ${i}: a blue garden has seven trees, a stone path, a fountain and a wooden bench.\n`).join('');
const encoder=getEncoding('o200k_base');
const cases=['cold','identical-1','identical-2','suffix','changed-prefix','restored-prefix'];
const inputs:ProviderInput[]=cases.map((name,i)=>({capability:'text.generate',model,input:'',max_output_tokens:128,parameters:{prompt_cache_key:key,prompt_cache_retention:'in_memory',service_tier:'default'},messages:[{role:'user',content:[{type:'text',text:i===4?`Different beginning ${nonce}.\n${prefix}`:prefix,cache:{boundary:'stable_prefix'}}]},{role:'user',content:i===3?'Reply with OK. This suffix changed.':'Reply with OK.'}]}));
const adapter=new OpenAIAdapter({apiKey:'not-used-in-plan',models:[model]});
const bodies=inputs.map(input=>{adapter.validate(input);return adapter.request(input,true).body});
assert.deepEqual(bodies[0],bodies[1]);assert.deepEqual(bodies[1],bodies[2]);assert.deepEqual(bodies[0],bodies[5]);
assert(bodies.every(b=>encoder.encode(JSON.stringify(b)).length<13000));
assert(encoder.encode(prefix).length>8000);
// 6 * (14,000 input including framing allowance * $0.40/M + 128 output * $1.60/M) < $0.035.
console.log(JSON.stringify({mode:live?'live':'plan',calls:6,model,prefix_tokens:encoder.encode(prefix).length,modeled_maximum_usd:'0.035',total_allowance_usd:'0.10'}));
if(!live)process.exit(0);
assert.equal(process.env.UAI_ENV,'test');
const target=new URL(process.env.UAI_TEST_DATABASE_URL??'');assert(['localhost','127.0.0.1'].includes(target.hostname)&&/^\/uai_.*test/.test(target.pathname));assert.notEqual(target.href,process.env.DATABASE_URL);
const marker=await open(resolve(root,'cache-recheck-started.json'),'wx',0o600);await marker.writeFile(JSON.stringify({at:new Date().toISOString(),prior_cost_units:prior.budgets.find((b:any)=>b.kind==='provider').spent_units}));await marker.sync();await marker.close();
process.env.UAI_BLOB_BACKEND='local';process.env.UAI_BLOB_ROOT=resolve(root,'blobs');process.env.UAI_EXECUTION_BACKEND='legacy';process.env.UAI_WORKER_BACKEND='legacy';process.env.UAI_ALLOW_REAL_PROVIDERS='true';process.env.UAI_ALLOW_REPORTING_API='false';
const pool=new pg.Pool({connectionString:target.href});
const evidence:any={started_at:new Date().toISOString(),scope,connection_id:connection,model,prompt_cache_key:key,prefix_tokens:encoder.encode(prefix).length,results:[]};
const save=()=>writeFile(resolve(root,'cache-recheck.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
try{
 const budget=(await pool.query("SELECT limit_units,spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1 AND kind='provider' AND budget_key=$2",[scope.organization_id,connection])).rows[0];assert.equal(budget.limit_units,'100000000');assert.equal(budget.reserved_units,'0');assert.equal(budget.spent_units,prior.budgets.find((b:any)=>b.kind==='provider').spent_units);assert(BigInt(budget.spent_units)+35000000n<=100000000n);evidence.prior_cost_units=budget.spent_units;
 const old=(await pool.query('SELECT execution_status,settlement_status FROM execution_requests WHERE organization_id=$1',[scope.organization_id])).rows;assert.equal(old.length,8);assert(old.every(r=>r.execution_status==='succeeded'&&r.settlement_status==='settled'));
 await loadRuntimeSecrets();assert(process.env.UAI_VAULT_KEY);
 const source=new pg.Pool({connectionString:process.env.DATABASE_URL});let apiKey:string;
 try{const row=(await source.query("SELECT id,organization_id,application_id FROM provider_connections WHERE id=$1 AND provider='openai' AND status='enabled'",[prior.source_connection_id])).rows[0];assert(row);apiKey=await new ConnectionService(source,systemClock,new CredentialVault(Buffer.from(process.env.UAI_VAULT_KEY,'base64'))).resolveCredential(row,row.id);}finally{await source.end()}
 const profile=`cache-recheck-${nonce}`;
 await transaction(pool,async tx=>{
  const catalog=new CatalogService(tx);
  const oldRecipe=(await tx.query("SELECT definition FROM recipe_versions WHERE application_id=$1 AND key='text' ORDER BY version DESC LIMIT 1",[scope.application_id])).rows[0].definition;
  const oldRoute=(await catalog.get(scope,oldRecipe.components[0].route_version_id)).payload as RouteDefinition;
  const oldCatalog=(await catalog.get(scope,oldRoute.primary.catalog_version_id)).payload as CatalogDefinition;
  const definition=structuredClone(oldCatalog.models[0]);assert.equal(definition.id,model);
  const calc=definition.calculation!;calc.components[0].maximum='14000';
  calc.parameters.prompt_cache_key={type:'string',values:[key],default:key};calc.parameters.prompt_cache_retention={type:'string',values:['in_memory'],default:'in_memory'};calc.parameters.service_tier={type:'string',values:['default'],default:'default'};definition.allowed_parameters=Object.keys(calc.parameters);
  const models=await catalog.createDraft(scope,{kind:'catalog',key:profile,version:1,author:'cache-check',comment:'Stable cache key; fixed tier and in-memory retention',payload:{models:[definition]}});await catalog.publish(scope,models.id,1);
  const route=await catalog.createDraft(scope,{kind:'route',key:profile,version:1,author:'cache-check',comment:'Same connection and original total budget',payload:{...oldRoute,primary:{...oldRoute.primary,catalog_version_id:models.id}}});await catalog.publish(scope,route.id,1);
  await publishRecipe(tx,scope,systemClock,{...oldRecipe,key:profile,version:1,components:[{...oldRecipe.components[0],route_version_id:route.id}]});
 });
 const deps=defaultRuntime(pool);deps.limits={scope};let active=0,sends=0;
 deps.adapter=async(_scope,variant)=>{assert.equal(variant.connection_id,connection);assert.equal(variant.model,model);const row=evidence.results[active];
  const actual=new OpenAIAdapter({apiKey,models:[model],fetch:async(url,init)=>{
   assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(String(init.body)),JSON.parse(JSON.stringify(bodies[active])));assert(!row.sent_at);assert(++sends<=6);
   row.sent_at=new Date().toISOString();row.body_sha256=createHash('sha256').update(String(init.body)).digest('hex');row.body=bodies[active];await save();
   const response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(60000)])});row.http_status=response.status;row.http_request_id=response.headers.get('x-request-id');await save();return response;
  }});
  const execute=actual.execute.bind(actual);actual.execute=(input,context)=>execute(input,{...context,onUsage:async observation=>{row.raw_usage=observation.raw_usage;await save();await context.onUsage(observation)}});return actual;
 };
 for(const [index,name] of cases.entries()){
  active=index;if(index)await delay(10000);
  const row:any={name};evidence.results.push(row);await save();
  const input=inputs[index];const {max_output_tokens,...params}=input.parameters??{};
  const accepted=await transaction(pool,tx=>invoke(tx,scope,systemClock,{profile,input:{messages:input.messages},parameters:{...params,max_output_tokens:128},budget:{max_units:'10000000'},execution:{max_attempts:1},idempotency_key:`${profile}:${name}`}));row.request_id=accepted.request_id;
  const outcome=await executeOne(pool,deps);row.worker=outcome;await save();assert.equal(outcome.request_id,accepted.request_id);assert.equal(outcome.state,'succeeded');
  const attempt=(await pool.query('SELECT id,number,cost_units,charged_units FROM execution_attempts WHERE request_id=$1',[row.request_id])).rows;assert.equal(attempt.length,1);row.attempt=attempt[0];
  row.usage=(await pool.query('SELECT usage FROM provider_usage_observations WHERE attempt_id=$1',[row.attempt.id])).rows;assert.equal(row.usage.length,1);assert.equal(row.usage[0].usage.state,'known');
  const quantities=Object.fromEntries(row.usage[0].usage.items.map((i:any)=>[i.dimension,Number(i.quantity)]));row.cached_tokens=row.raw_usage.input_tokens_details.cached_tokens;
  assert.equal(quantities['input.cache_read'],row.cached_tokens);assert.equal(quantities['input.uncached']+row.cached_tokens,row.raw_usage.input_tokens);assert.equal(quantities['output.text'],row.raw_usage.output_tokens);
  const expected=BigInt(row.raw_usage.input_tokens-row.cached_tokens)*400n+BigInt(row.cached_tokens)*100n+BigInt(row.raw_usage.output_tokens)*1600n;assert.equal(BigInt(row.attempt.cost_units),expected);
  const delivery=await getDelivery(pool,scope,systemClock,row.request_id);assert(delivery?.result);const file=await open(resolve(root,`${row.request_id}.json`),'wx',0o600);await file.writeFile(JSON.stringify(delivery));await file.sync();await file.close();
  await transaction(pool,tx=>acknowledge(tx,scope,systemClock,{request_id:row.request_id,version:delivery.version,manifest_hash:delivery.manifest_hash}));row.saved_and_acknowledged=true;await save();console.log(JSON.stringify({name,cached_tokens:row.cached_tokens,input_tokens:row.raw_usage.input_tokens,cost_units:row.attempt.cost_units}));
 }
 const final=(await pool.query("SELECT spent_units,reserved_units FROM execution_budgets WHERE organization_id=$1 AND kind='provider' AND budget_key=$2",[scope.organization_id,connection])).rows[0];assert.equal(final.reserved_units,'0');assert(BigInt(final.spent_units)<=100000000n);evidence.total_cost_units=final.spent_units;evidence.probe_cost_units=(BigInt(final.spent_units)-BigInt(evidence.prior_cost_units)).toString();assert.equal(BigInt(evidence.probe_cost_units),evidence.results.reduce((n:bigint,r:any)=>n+BigInt(r.attempt.cost_units),0n));
 evidence.hit_confirmed=evidence.results.some((r:any)=>r.cached_tokens>0);evidence.completed_at=new Date().toISOString();await save();if(!evidence.hit_confirmed)process.exitCode=2;
}catch(e){evidence.failure=e instanceof Error?e.message:'Failed';await save();throw e}finally{await pool.end();process.env.UAI_ALLOW_REAL_PROVIDERS='false'}
