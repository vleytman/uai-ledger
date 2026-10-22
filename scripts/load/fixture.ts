import {createPool,transaction} from '../../packages/db/src/index.js';
import {systemClock as clock,id,type Scope} from '../../packages/contracts/src/index.js';
import {ensureWallet,grant} from '../../packages/accounting/src/index.js';
import {issueToken} from '../../packages/auth/src/index.js';
import {CatalogService} from '../../packages/catalog/src/index.js';
import {ConnectionService} from '../../packages/reconciliation/src/connections.js';
import {configureBudget} from '../../packages/execution/src/index.js';
import {publishRecipe,type RecipeComponent} from '../../packages/quoting/src/index.js';
export async function seedLoadFixture(pool:ReturnType<typeof createPool>,users:number,providerConcurrency=8){return transaction(pool,async tx=>{
 const scope:Scope={organization_id:id('load-org'),application_id:id('load-app'),account_id:id('load-account')};
 await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Distributed mock load']);
 const accounts:Scope[]=[];
 for(let i=0;i<users;i++){
  const account={...scope,account_id:i?id('load-account'):scope.account_id};accounts.push(account);
  await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$1)',[account.account_id,scope.organization_id,scope.application_id]);
  await grant(tx,account,clock,{idempotency_key:'fund',source:'purchase',external_reference:`load-fixture-${i}`,amount_units:'100000000000',terms_version:'mock',expires_at:null});
 }
  const wallet=await ensureWallet(tx,scope),catalog=new CatalogService(tx,clock);
  const connection=await new ConnectionService(tx,clock).create(scope,{provider:'fake',name:'Локальные fixtures',account_scope:{installation:'local'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{max_input_tokens:'20000'},risk_policy:{period_budget_units:'100000000000'}},{actor_id:'seed',reason:'Синтетическое локальное окружение без платных вызовов'});
  await configureBudget(tx,scope,'provider',connection.id,'100000000000');await configureBudget(tx,scope,'period','local-test','100000000000');
  const models=await catalog.createDraft(scope,{kind:'catalog',key:'fixture-models',version:1,author:'seed',comment:'Синтетические модели',payload:{models:[{id:'fake-text',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'},{id:'fake-image',provider:'fake',capabilities:['image.generate'],allowed_parameters:['count','size','quality'],status:'active'}]}});
  await catalog.publish(scope,models.id,models.revision);
  const rates=[{id:'input',dimension:'input.uncached',unit:'tokens',unit_size:'1000',amount:'0.001',effective_from:'2026-01-01T00:00:00Z'},{id:'output',dimension:'output.text',unit:'tokens',unit_size:'1000',amount:'0.002',effective_from:'2026-01-01T00:00:00Z'},{id:'image',dimension:'output.image',unit:'images',unit_size:'1',amount:'0.01',effective_from:'2026-01-01T00:00:00Z'}];
  const card=await catalog.createDraft(scope,{kind:'rate_card',key:'fixture-pricing',version:1,author:'seed',comment:'Синтетические ставки, не цены реальных провайдеров',payload:{id:'fixture-card-v1',currency:'USD',source:'synthetic fixture only',checked_at:clock.now().toISOString(),rates}});
  await catalog.publish(scope,card.id,card.revision,[{usage:{state:'known',items:rates.map(r=>({dimension:r.dimension,unit:r.unit,quantity:'1'}))},context:{at:clock.now().toISOString()}}]);
  const components:RecipeComponent[]=[];
  for(const [key,capability,model] of [['text.standard','text.generate','fake-text'],['image.standard','image.generate','fake-image']] as const){
   const route=await catalog.createDraft(scope,{kind:'route',key,version:1,author:'seed',comment:'Детерминированный локальный маршрут',payload:{capability,primary:{catalog_version_id:models.id,model,connection_id:connection.id,max_cost_units:capability==='text.generate'?'24000000':'10000000'},deadline_seconds:3600,platform_risk_budget_units:'500000000'}});
   await catalog.publish(scope,route.id,route.revision);
   const component:RecipeComponent={key:capability==='text.generate'?'description':'image',capability,route_version_id:route.id,rate_card_version_id:card.id,count:{constant:1},limits:capability==='text.generate'?{input_tokens:20000,output_tokens:2000}:{image_count:1,image_sizes:['1024x1024'],image_qualities:['standard']}};
   components.push(component);await publishRecipe(tx,scope,clock,{key,version:1,components:[component],period_budget_key:'local-test',deadline_seconds:3600,actor_id:'seed'});
  }
  await publishRecipe(tx,scope,clock,{key:'demo.description-image',version:1,components,period_budget_key:'local-test',deadline_seconds:3600,actor_id:'seed'});

 for(const model of ['fake-text','fake-image']){
  const group=id('load-quota');
  await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,concurrency_limit) VALUES($1,$2,$1,'fake','{}','load','synthetic',$3)",[group,scope.organization_id,providerConcurrency]);
  await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',100000,60000)",[group]);
  await tx.query('INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,$2,$3)',[connection.id,model,group]);
 }
 const token=await issueToken(tx,{organization_id:scope.organization_id,application_id:scope.application_id,account_ids:null,scopes:['ai:quote','ai:execute','ai:read'],max_grant_units:null,expires_at:null});
 return {scope,accounts,token:token.token};
})}
