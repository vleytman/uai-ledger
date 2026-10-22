/** Offline browser installation. All provider traffic is replaced by an in-process fixture. */
import {writeFile,mkdir,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import bundle from '../configurations/api/typesafe/jev.json' with {type:'json'};
import {createPool,transaction} from '../packages/db/src/index.js';
import {id,systemClock} from '../packages/contracts/src/index.js';
import {ConnectionService,CredentialVault} from '../packages/reconciliation/src/connections.js';
import {publishConfiguration,activateConfiguration} from '../packages/configuration/src/index.js';
import {issueToken} from '../packages/auth/src/index.js';
import {grant,ensureWallet} from '../packages/accounting/src/index.js';
import {configureBudget} from '../packages/execution/src/index.js';
import {createApi} from '../apps/api/src/server.js';
import {defaultRuntime} from '../packages/execution/src/default-runtime.js';
import {executeOne} from '../packages/execution/src/runtime.js';
import {TypeSafeAdapter} from '../packages/providers/src/typesafe.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/uai_jev_'))throw new Error('Dedicated local Jev database required');
process.env.UAI_ALLOW_REAL_PROVIDERS='false';process.env.UAI_ENV='test';
const pool=createPool(),scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},dir='/tmp/uai-jev-ui';await mkdir(dir,{recursive:true});
const data=await transaction(pool,async tx=>{
 await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Jev offline fixture']);await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
 const c=await new ConnectionService(tx,systemClock,new CredentialVault(Buffer.alloc(32,1))).create(scope,{provider:'typesafe',name:'Jev offline fixture',account_scope:{account:scope.account_id},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'Offline browser verification'});
 await new ConnectionService(tx,systemClock,new CredentialVault(Buffer.alloc(32,1))).rotateCredential(scope,c.id,c.revision,'offline-only',{actor_id:'fixture',reason:'Offline transport fixture'});
 const document=structuredClone(bundle) as any;document.resources[1].payload.models[0].status='active';document.resources[1].display_name='Jev 1.13 · offline fixture';document.resources[3].payload.execution={max_attempts:1};
 const release=await publishConfiguration(tx,scope,document,{connections:{primary:c.id},budgets:{period:'jev-fixture'}},{path:'configurations/api/typesafe/jev.json',git_revision:'a'.repeat(40),git_dirty:true,content_hash:'b'.repeat(64),publisher:'offline-fixture'});await activateConfiguration(tx,scope,release.id,0,'offline-fixture');
 await configureBudget(tx,scope,'provider',c.id,'10000000000');await configureBudget(tx,scope,'period','jev-fixture','10000000000');await grant(tx,scope,systemClock,{idempotency_key:'fixture-funds',amount_units:'10000000000',source:'internal',reason:'Offline fixture',external_reference:'fixture',terms_version:'fixture',expires_at:null});
 return {wallet:await ensureWallet(tx,scope),token:(await issueToken(tx,{...scope,account_ids:null,scopes:['operations:admin','config:write','ai:read','ai:quote','ai:execute','wallets:read','credits:grant','content:write'],max_grant_units:'10000000000',expires_at:null})).token};
});
const api=createApi(pool),api_url=await api.listen({host:'127.0.0.1',port:4345});
const file=`${dir}/config.json`;await writeFile(file,JSON.stringify({api_url,admin_token:data.token,app_token:data.token,grant_token:data.token,account_id:scope.account_id,wallet_id:data.wallet,session_secret:randomBytes(32).toString('hex'),login_password:'jev-local-fixture',max_grant_units:'10000000000',jev:{profile:bundle.bundle_key,fixture:true}}),{mode:0o600});
const deps=defaultRuntime(pool);deps.limits={scope};deps.adapter=async()=>new TypeSafeAdapter({apiKey:'offline',models:['typesafe.systemone'],fetch:async(_url,init)=>{
 const input=JSON.parse(init.body as string);const answers=Object.fromEntries(Object.entries(input.questions).map(([key,q]:[string,any])=>[key,q.type==='noul'?{type:'noul',noul:0.5}:q.type==='choice'?{type:'choice',choice:Object.keys(q.criteria)[0],probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,1/Object.keys(q.criteria).length])),confidence:0}:{type:'score',score:(q.criteria.length-1)/2,probabilities:Object.fromEntries(q.criteria.map((_:unknown,i:number)=>[String(i),1/q.criteria.length])),legend:Object.fromEntries(q.criteria.map((v:unknown,i:number)=>[String(i),typeof v==='string'?v:JSON.stringify(v)])),confidence:0}]));
 return new Response(JSON.stringify({model:'jev-1.13.0',answers,usage:{input_tokens:1000,output_tokens:50}}));
}});
let running=false;const timer=setInterval(()=>{if(running)return;running=true;void executeOne(pool,deps).catch(()=>console.error('fixture_worker_failed')).finally(()=>running=false);},100);
const children=[['@uai/admin','4346'],['@uai/demo','4347']].map(([name,port])=>spawn('pnpm',['--filter',name,'exec','vite','--host','127.0.0.1','--port',port,'--strictPort'],{stdio:'inherit',env:{...process.env,UAI_ADMIN_CONFIG:file,UAI_DEMO_CONFIG:file,UAI_DEMO_ROOT:`${dir}/demo`}}));
console.log('Offline Jev fixture: admin http://127.0.0.1:4346 · demo http://127.0.0.1:4347 · password jev-local-fixture');
let closing=false;async function close(){if(closing)return;closing=true;clearInterval(timer);for(const child of children)child.kill('SIGTERM');await api.close();await pool.end();await rm(file,{force:true});}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());for(const child of children)child.on('exit',()=>void close());
