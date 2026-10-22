import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {strict as assert} from 'node:assert';
import {createPool,transaction,emit} from '../packages/db/src/index.js';
import {id,systemClock as clock,type Scope} from '../packages/contracts/src/index.js';
import * as accounting from '../packages/accounting/src/index.js';
import {issueToken,authenticate} from '../packages/auth/src/index.js';
import {ConnectionService,ReconciliationService,CredentialVault} from '../packages/reconciliation/src/index.js';
import {NotificationService,consumeExecutionEvents} from '../packages/notifications/src/index.js';
import {configureBudget} from '../packages/execution/src/index.js';
if(process.env.UAI_ENV!=='test')throw new Error('UAI_ENV=test required');
const base=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(base.hostname))throw new Error('Only local PostgreSQL is supported by this verification');
const names=['source','restored','independent'].map(name=>`uai_check_${Date.now()}_${name}`),adminUrl=new URL(base);adminUrl.pathname='/postgres';const admin=createPool(adminUrl.toString()),created:string[]=[];
const url=(name:string)=>{const v=new URL(base);v.pathname=`/${name}`;return v.toString()};
function exec(command:string,args:string[],input?:Buffer,env?:NodeJS.ProcessEnv){const r=spawnSync(command,args,{input,env:env??process.env,maxBuffer:64*1024*1024});if(r.status!==0)throw new Error(`Verification command failed: ${command} ${args[0]}`);return r.stdout;}
async function install(name:string,allocation:string){
 const pool=createPool(url(name)),vault=new CredentialVault(randomBytes(32)),providerKey=randomBytes(24).toString('base64url');const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
 const grant={amount_units:'1000000000',source:'internal' as const,external_reference:'restore-credit',terms_version:'fixture-v1',expires_at:null,reason:'Synthetic restore acceptance',idempotency_key:'restore-grant'};
 const result=await transaction(pool,async tx=>{
  await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,name]);
  await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,'test']);
  const issued=await issueToken(tx,{...scope,account_ids:[scope.account_id],scopes:['wallets:read'],max_grant_units:null,expires_at:null});
  await accounting.grant(tx,scope,clock,grant);
  const connection=await new ConnectionService(tx,clock).create(scope,{provider:'fake',name:'shared synthetic provider account',account_scope:{provider_account:'shared-test'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{quota_share:allocation},risk_policy:{period_budget_units:allocation}},{actor_id:'test',reason:'Independent allocated share'});
  await new ConnectionService(tx,clock,vault).rotateCredential(scope,connection.id,connection.revision,providerKey,{actor_id:'test',reason:'Distinct synthetic provider key for this installation'});
  await configureBudget(tx,scope,'provider',connection.id,allocation);
  await new ReconciliationService(tx,clock).addSnapshot(scope,{connection_id:connection.id,account_scope:{provider_account:'shared-test'},metric:'spending_cap',source:'manual',native_unit:'USD',remaining:'100',fetched_at:clock.now().toISOString(),precision:'exact',stale_after_seconds:3600},{actor_id:'test',reason:'Synthetic shared account scope, not wallet balance'});
  await new NotificationService(tx,clock).saveRule(scope,{signal:'provider.recovery_started',severity:'warning',minimum_samples:1,recipients:[],cooldown_seconds:300,enabled:true},{actor_id:'test',reason:'Restore replay verification'});
  await emit(tx,scope,'provider.recovery_started',{type:'incident',id:'fixture-incident'},{reason:'synthetic'});
  return {token:issued.token,connection};
 });
 await consumeExecutionEvents(pool,clock);return {pool,scope,grant,vault,providerKey,...result};
}
let source:Awaited<ReturnType<typeof install>>|undefined,other:Awaited<ReturnType<typeof install>>|undefined,restored:ReturnType<typeof createPool>|undefined;
try{
 for(const name of names){await admin.query(`CREATE DATABASE "${name}"`);created.push(name)}
 for(const name of [names[0],names[2]])exec('pnpm',['db:migrate'],undefined,{...process.env,DATABASE_URL:url(name)});
 source=await install(names[0],'40000000000');other=await install(names[2],'50000000000');
 const before=await transaction(source.pool,tx=>accounting.getWallet(tx,source!.scope,clock));
 const dump=exec('docker',['compose','exec','-T','postgres','pg_dump','-U','uai','--no-owner','--no-privileges',names[0]]);
 exec('docker',['compose','exec','-T','postgres','psql','-U','uai','-v','ON_ERROR_STOP=1','-d',names[1]],dump);
 restored=createPool(url(names[1]));
 const after=await transaction(restored,tx=>accounting.getWallet(tx,source!.scope,clock));assert.deepEqual(after,before);
 const counts=async(pool:typeof restored)=>{const r=await pool!.query('SELECT (SELECT count(*) FROM credit_lots)::int lots,(SELECT count(*) FROM journal_transactions)::int journal,(SELECT count(*) FROM notification_incidents)::int incidents,(SELECT count(*) FROM notification_deliveries)::int deliveries');return r.rows[0]};
 const initial=await counts(restored);
 await transaction(restored,tx=>accounting.grant(tx,source!.scope,clock,source!.grant));await consumeExecutionEvents(restored,clock);await consumeExecutionEvents(restored,clock);
 assert.deepEqual(await counts(restored),initial);assert.deepEqual(await transaction(restored,tx=>accounting.getWallet(tx,source!.scope,clock)),before);
 assert.notEqual(source.token,other.token);assert.notEqual(source.providerKey,other.providerKey);
 assert.equal(await new ConnectionService(source.pool,clock,source.vault).resolveCredential(source.scope,source.connection.id),source.providerKey);
 assert.equal(await new ConnectionService(other.pool,clock,other.vault).resolveCredential(other.scope,other.connection.id),other.providerKey);await assert.rejects(()=>authenticate(other!.pool,`Bearer ${source!.token}`));
 const oneBudget=(await source.pool.query('SELECT limit_units FROM execution_budgets')).rows[0].limit_units,twoBudget=(await other.pool.query('SELECT limit_units FROM execution_budgets')).rows[0].limit_units;
 assert.equal(BigInt(oneBudget)+BigInt(twoBudget),90000000000n);assert(BigInt(oneBudget)+BigInt(twoBudget)<100000000000n);
 for(const installation of [source,other]){const snapshot=(await new ReconciliationService(installation.pool,clock).listSnapshots(installation.scope))[0];assert.equal(snapshot.account_scope.provider_account,'shared-test');assert.equal(snapshot.remaining,'100');const wallet=await transaction(installation.pool,tx=>accounting.getWallet(tx,installation.scope,clock));assert.equal(wallet.balance_units,'1000000000');}
 console.log(JSON.stringify({A44:'passed',A78:'passed',backup_bytes:dump.length,financial_and_delivery_counts:initial,independent_databases:2,local_allocated_budget_units:'90000000000',synthetic_shared_cap_units:'100000000000',real_provider_called:false}));
}finally{
 await Promise.all([source?.pool.end(),other?.pool.end(),restored?.end()]);
 for(const name of created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
 await admin.end();
}
