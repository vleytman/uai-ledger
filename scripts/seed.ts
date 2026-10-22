import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPool,transaction } from '../packages/db/src/index.js';
import { systemClock as clock,id,type Scope } from '../packages/contracts/src/index.js';
import { ensureWallet } from '../packages/accounting/src/index.js';
import { issueToken } from '../packages/auth/src/index.js';
import { CatalogService } from '../packages/catalog/src/index.js';
import { ConnectionService } from '../packages/reconciliation/src/connections.js';
import { configureBudget } from '../packages/execution/src/index.js';
import { publishRecipe,type RecipeComponent } from '../packages/quoting/src/index.js';
if(process.env.UAI_ENV!=='test')throw new Error('Seed only allowed with UAI_ENV=test');
const pool=createPool();
try{
 const dir=resolve('.data');await mkdir(dir,{recursive:true});
 try{await writeFile(resolve(dir,'vault-key'),randomBytes(32).toString('base64'),{mode:0o600,flag:'wx'})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 let old:any;try{old=JSON.parse(await readFile(resolve(dir,'demo-config.json'),'utf8'))}catch{}
 if(old&&(await pool.query('SELECT 1 FROM accounts WHERE id=$1',[old.account_id])).rowCount){console.log('Existing local seed retained.');process.exitCode=0;}
 else{
 const result=await transaction(pool,async tx=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'UAI local acceptance']);
  await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,'demo-user']);
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
  const token=(scopes:string[],accounts:string[]|null,max:string|null)=>issueToken(tx,{organization_id:scope.organization_id,application_id:scope.application_id,account_ids:accounts,scopes,max_grant_units:max,expires_at:null});
  const appToken=await token(['ai:quote','ai:execute','ai:read','content:write','wallets:read'],[scope.account_id],null);
  const grantToken=await token(['credits:grant','credits:test-balance','wallets:read'],[scope.account_id],'10000000000');
  const adminToken=await token(['accounts:write','accounts:spending','ai:quote','ai:execute','ai:read','content:write','wallets:read','credits:grant','credits:refund','credits:revoke','config:write','operations:admin'],null,'1000000000000');
  return {scope,wallet,app_token:appToken.token,grant_token:grantToken.token,admin_token:adminToken.token};
 });
 const shared={api_url:'http://127.0.0.1:4310',account_id:result.scope.account_id,wallet_id:result.wallet,session_secret:randomBytes(32).toString('base64url'),login_password:randomBytes(18).toString('base64url')};
 await writeFile(resolve(dir,'demo-config.json'),JSON.stringify({...shared,app_token:result.app_token,grant_token:result.grant_token,max_grant_units:'10000000000'},null,2),{mode:0o600});
 await writeFile(resolve(dir,'admin-config.json'),JSON.stringify({...shared,session_secret:randomBytes(32).toString('base64url'),admin_token:result.admin_token},null,2),{mode:0o600});
 console.log('Local fake providers and profiles seeded. Configuration written to ignored .data files with mode 0600. No credentials printed. Wallet starts at zero; use demo grant.');
 }
}finally{await pool.end()}
