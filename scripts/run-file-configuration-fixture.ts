import {AllowanceService} from '../packages/allowance/src/index.js';
/** Isolated, local browser acceptance; no real-provider credentials or calls. */
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {createPool,transaction} from '../packages/db/src/index.js';
import {id,systemClock} from '../packages/contracts/src/index.js';
import {issueToken} from '../packages/auth/src/index.js';
import {ensureWallet} from '../packages/accounting/src/index.js';
import {ConnectionService} from '../packages/reconciliation/src/connections.js';
import {publishConfiguration,activateConfiguration} from '../packages/configuration/src/index.js';
import {createApi} from '../apps/api/src/server.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/uai_file_config_test')throw new Error('Use the isolated local uai_file_config_test database');
process.env.UAI_ALLOW_REAL_PROVIDERS='false';
const pool=createPool(),scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
const file='configurations/ai/openai-nano.json',bytes=await readFile(file);
const data=await transaction(pool,async tx=>{
 await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'File publication UI fixture']);
 await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,'file-publication-ui']);
 const wallet=await ensureWallet(tx,scope);
 const connection=await new ConnectionService(tx).create(scope,{provider:'openai',name:'Nano fixture · no real API key',account_scope:{fixture:'file-publication-ui'},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:['request'],reporting_lag_seconds:0},limits:{max_input_tokens:'16000'},risk_policy:{}},{actor_id:'fixture',reason:'Local browser acceptance'});
 const bindings={connections:{primary:connection.id},budgets:{period:'file-fixture-period'}};
 const release=await publishConfiguration(tx,scope,JSON.parse(bytes.toString()),bindings,{path:file,git_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),git_dirty:true,content_hash:createHash('sha256').update(bytes).digest('hex'),publisher:'file-browser-fixture'},systemClock);
 await activateConfiguration(tx,scope,release.id,0,'file-browser-fixture');
 const fc=await new ConnectionService(tx).create(scope,{provider:'firecrawl',name:'Firecrawl · synthetic tariff',account_scope:{fixture:'paid-api-ui'},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:true,request_cost_lookup:false,reporting_granularity:['request'],reporting_lag_seconds:0},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'Local browser acceptance'});
 const paidBindings={connections:{primary:fc.id},budgets:{period:'paid-api-fixture'}};
 let tariffId='';
 for(const file of ['configurations/tariffs/firecrawl-example.json',...['scrape','search','patent_search','patent_document'].map(key=>`configurations/api/firecrawl/${key}.json`)]){
  const bytes=await readFile(file),published=await publishConfiguration(tx,scope,JSON.parse(bytes.toString()),paidBindings,{path:file,git_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),git_dirty:true,content_hash:createHash('sha256').update(bytes).digest('hex'),publisher:'paid-api-browser-fixture'},systemClock);
  await activateConfiguration(tx,scope,published.id,0,'paid-api-browser-fixture');tariffId=published.resources.find((r:any)=>r.kind==='tariff')?.id??tariffId;
 }
 const allowance=new AllowanceService(tx),actor={actor_id:'fixture',reason:'Synthetic allowance UI acceptance'};
 const account=await allowance.createAccount(scope,{provider:'firecrawl',name:'Firecrawl example account',external_reference:id('fixture'),reason:actor.reason},actor);
 const sub=await allowance.createSubscription(scope,{provider_account_id:account.id,tariff_version_id:tariffId,starts_at:'2026-09-01T00:00:00Z',installation_share:{credits:'1000'},reason:actor.reason},actor);
 await allowance.bindConnection(scope,fc.id,{provider_account_id:account.id,subscription_id:sub.id,reason:actor.reason},0,actor);
 const hold=await allowance.reserve(scope,sub.id,'fixture-usage',[{metric:'credits',quantity:'150'}]);await allowance.markSent(scope,hold.id);await allowance.observe(scope,hold.id,{identity:'fixture-observation',revision:1,attempt_id:'fixture-attempt',state:'known',items:[{metric:'credits',quantity:'150'}],source:'manual',reason:actor.reason});
 await allowance.reserve(scope,sub.id,'fixture-pending',[{metric:'credits',quantity:'25'}]);
 const token=(await issueToken(tx,{...scope,account_ids:null,scopes:['operations:admin','config:write','ai:read','ai:quote','wallets:read'],max_grant_units:'1',expires_at:null})).token;
 return {wallet,token,release,bindings};
});
const api=createApi(pool),api_url=await api.listen({host:'127.0.0.1',port:0});
await mkdir('.data',{recursive:true});
const configPath=resolve('.data/file-configuration-fixture.json');
await writeFile(configPath,JSON.stringify({api_url,admin_token:data.token,account_id:scope.account_id,wallet_id:data.wallet,session_secret:randomBytes(32).toString('hex'),login_password:'uai-file-fixture'}),{mode:0o600});
await writeFile(resolve('.data/file-configuration-bindings.json'),JSON.stringify(data.bindings),{mode:0o600});
await writeFile(resolve('.data/file-configuration-scope.json'),JSON.stringify(scope),{mode:0o600});
const admin=spawn('pnpm',['--filter','@uai/admin','exec','vite','--host','127.0.0.1','--port','4331','--strictPort'],{stdio:'inherit',env:{...process.env,UAI_ADMIN_CONFIG:configPath}});
console.log('File configuration fixture: http://127.0.0.1:4331 · synthetic login: uai-file-fixture');
let closing=false;async function close(){if(closing)return;closing=true;admin.kill('SIGTERM');await api.close();await pool.end();await rm(configPath,{force:true});}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());admin.on('exit',()=>void close());
