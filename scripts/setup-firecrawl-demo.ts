/** Configure the existing local test demo. Does not execute paid calls. */
import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createPool,transaction} from '../packages/db/src/index.js';
import {systemClock} from '../packages/contracts/src/index.js';
import {ConnectionService,CredentialVault} from '../packages/reconciliation/src/connections.js';
import {publishConfiguration,activateConfiguration} from '../packages/configuration/src/index.js';
import {AllowanceService} from '../packages/allowance/src/index.js';
import {configureBudget} from '../packages/execution/src/index.js';
import {createQuotaGroup} from '../packages/queue/src/quota-create.js';
import {quotaBindingSnapshot,updateQuotaBindings} from '../packages/queue/src/quota-bindings.js';
import {issueToken} from '../packages/auth/src/index.js';
if(process.env.UAI_ENV!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)||new URL(process.env.DATABASE_URL!).pathname!=='/uai_local')throw new Error('Only the local uai_local test installation is supported');
if(!process.argv.includes('--execute'))throw new Error('Use --execute after approving the demo configuration');
const apiKey=process.env.FIRECRAWL_API_KEY;if(!apiKey)throw new Error('Provide FIRECRAWL_API_KEY securely');
const configPath=resolve(process.env.UAI_DEMO_CONFIG??'.data/demo-config.json'),config=JSON.parse(await readFile(configPath,'utf8'));
const vaultKey=process.env.UAI_VAULT_KEY??(await readFile(process.env.UAI_VAULT_KEY_FILE??'.data/vault-key','utf8')).trim();
const pool=createPool(),actor={actor_id:'firecrawl-demo-setup',reason:'User approved live Firecrawl demo; isolated allowance 37 credits after direct acceptance used 13 of 50'};
try{
 const result=await transaction(pool,async tx=>{
  const scope=(await tx.query('SELECT organization_id,application_id,id AS account_id FROM accounts WHERE id=$1',[config.account_id])).rows[0];if(!scope)throw new Error('Demo account missing');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`firecrawl-demo:${scope.application_id}`]);
  const service=new ConnectionService(tx,systemClock,new CredentialVault(Buffer.from(vaultKey,'base64')));
  let connection=(await service.list(scope)).find(c=>c.provider==='firecrawl'&&c.account_scope.demo==='paid-api');
  if(!connection){connection=await service.create(scope,{provider:'firecrawl',name:'Firecrawl demo',account_scope:{demo:'paid-api'},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:true,request_cost_lookup:false,reporting_granularity:['request'],reporting_lag_seconds:0},limits:{},risk_policy:{}},actor);connection=await service.rotateCredential(scope,connection.id,connection.revision,apiKey,actor);}
  const file='configurations/demo/firecrawl.json',bytes=await readFile(file);
  const release=await publishConfiguration(tx,scope,JSON.parse(bytes.toString()),{connections:{primary:connection.id},budgets:{period:'demo-firecrawl'}},{path:file,git_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),git_dirty:true,content_hash:createHash('sha256').update(bytes).digest('hex'),publisher:actor.actor_id});
  const active=(await tx.query('SELECT revision FROM configuration_activations WHERE organization_id=$1 AND application_id=$2 AND bundle_key=$3',[scope.organization_id,scope.application_id,'demo.firecrawl'])).rows[0];
  await activateConfiguration(tx,scope,release.id,active?.revision??0,actor.actor_id);
  const allowance=new AllowanceService(tx);let binding=await allowance.binding(scope,connection.id);
  if(!binding){
   const account=await allowance.createAccount(scope,{provider:'firecrawl',name:'Firecrawl demo allowance',external_reference:'local-demo-firecrawl',reason:actor.reason},actor);
   const sub=await allowance.createSubscription(scope,{provider_account_id:account.id,tariff_version_id:release.resources.find((r:{kind:string;id:string})=>r.kind==='tariff')!.id,starts_at:systemClock.now().toISOString(),installation_share:{credits:'37'},reason:actor.reason},actor);
   await allowance.bindConnection(scope,connection.id,{provider_account_id:account.id,subscription_id:sub.id,reason:actor.reason},0,actor);binding=await allowance.binding(scope,connection.id);
   await configureBudget(tx,scope,'provider',connection.id,'1000000000');await configureBudget(tx,scope,'period','demo-firecrawl','1000000000');
  }
  let quota=(await tx.query('SELECT id FROM provider_quota_groups WHERE organization_id=$1 AND name=$2',[scope.organization_id,'Firecrawl demo local limits'])).rows[0]?.id;
  if(!quota)quota=await createQuotaGroup(tx,scope,systemClock,{provider:'firecrawl',name:'Firecrawl demo local limits',scope:{capability:'api.call'},coordination_domain:null,source:'Conservative local demo limits; not a published provider entitlement',checked_at:systemClock.now().toISOString(),concurrency_limit:1,rules:[{key:'requests',metric:'requests',capacity:'6',provider_capacity:null,window_ms:60000},{key:'credits',metric:'credits',capacity:'30',provider_capacity:null,window_ms:60000}]},actor);
  for(const operation of ['scrape','search','patent_search','patent_document']){
   const model=`firecrawl.${operation}`,before=await quotaBindingSnapshot(tx,scope,connection.id,model);
   await updateQuotaBindings(tx,scope,systemClock,connection.id,model,before.bindings_revision,[quota],actor);
  }
  const readToken=config.paid_api?.read_token??(await issueToken(tx,{...scope,account_ids:null,scopes:['operations:admin'],max_grant_units:null,expires_at:null})).token;
  return {subscription_id:binding!.subscription_id,read_token:readToken,profiles:['scrape','search','patent_search','patent_document'].map(operation=>({operation,profile:`demo.firecrawl.${operation}`}))};
 });
 const temp=`${configPath}.paid-api.tmp`;await writeFile(temp,JSON.stringify({...config,paid_api:result}),{mode:0o600});await rename(temp,configPath);
 console.log(JSON.stringify({configured:true,profiles:result.profiles,allowance_credits:37,paid_calls:0,credentials:'server vault only'}));
}finally{await pool.end()}
