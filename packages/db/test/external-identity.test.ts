import {afterAll,beforeAll,describe,expect,test} from 'vitest';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createPool,transaction,type Tx} from '../src/index.js';
import * as accounting from '../../accounting/src/index.js';
import {ManualClock} from '../../contracts/src/index.js';
import {setAuditAccount,setAuditIdentity} from '../src/identity.js';
import {isolatedTestDatabase} from './isolated-database.js';
const integration=process.env.DATABASE_URL?describe:describe.skip;
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
integration('external identity snapshots',()=>{
 const db=isolatedTestDatabase(process.env.DATABASE_URL);
 beforeAll(async()=>{await db.initialize();await db.pool!.query(`INSERT INTO applications VALUES ('app','org','test'),('other','org','other'); INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES ('a','org','app','team-a'),('b','org','app','team-b'),('foreign','org','other','team-a'); INSERT INTO wallets(id,organization_id,application_id,account_id) VALUES ('wa','org','app','a'),('wb','org','app','b')`);},60000);
 afterAll(()=>db.close());
 const identity=(user:string)=>({organization_id:'org',application_id:'app',service_principal_id:'shared-service',user_id:user});
 async function audit(tx:any,id:string,target='a'){
  return (await tx.query("INSERT INTO audit_events(id,organization_id,application_id,actor_id,action,resource_id,reason) VALUES($1,'org','app','shared-service','test',$2,'reason') RETURNING *",[id,target])).rows[0];
 }
 test('distinguishes people sharing a service, resolves real teams, and clears pooled context',async()=>{
  const first=await transaction(db.pool!,async tx=>{await setAuditIdentity(tx,identity('alice'));return audit(tx,'alice')});
  const second=await transaction(db.pool!,async tx=>{await setAuditIdentity(tx,identity('bob'));return audit(tx,'bob','wb')});
  expect(first.actor_id).toBe('shared-service');expect(first.audit_identity).toMatchObject({user_id:'alice',service_principal_id:'shared-service',account_id:'a',external_team_id:'team-a'});
  expect(second.audit_identity).toMatchObject({user_id:'bob',account_id:'b',external_team_id:'team-b'});
  const system=await transaction(db.pool!,tx=>audit(tx,'system'));
  expect(system.audit_identity.user_id).toBeNull();
 });
 test('target resolution overrides staff fallback and rejects foreign accounts',async()=>{
  const row=await transaction(db.pool!,async tx=>{await setAuditIdentity(tx,identity('staff'));await setAuditAccount(tx,'b');return audit(tx,'target','a')});
  expect(row.audit_identity.account_id).toBe('a');
  await expect(transaction(db.pool!,async tx=>{await setAuditIdentity(tx,identity('staff'));await setAuditAccount(tx,'foreign')})).rejects.toThrow('scope mismatch');
  await expect(transaction(db.pool!,async tx=>{await setAuditIdentity(tx,identity('staff'));return audit(tx,'wrong','foreign')})).rejects.toThrow('scope mismatch');
 });
 test('cannot overwrite snapshot and rollback removes both action and identity',async()=>{
  await expect(db.pool!.query("UPDATE audit_events SET audit_identity='{}' WHERE id='alice'")).rejects.toThrow('immutable');
  await expect(transaction(db.pool!,async tx=>{await setAuditIdentity(tx,identity('rollback'));await audit(tx,'rollback');throw Error('rollback')})).rejects.toThrow('rollback');
  expect((await db.pool!.query("SELECT * FROM audit_events WHERE id='rollback'")).rows).toHaveLength(0);
  expect((await transaction(db.pool!,tx=>audit(tx,'after-rollback'))).audit_identity.user_id).toBeNull();
 });
 test('accepted operation keeps initiator while worker capture and staff refund preserve payer and lineage',async()=>{
  const scope={organization_id:'org',application_id:'app',account_id:'a'},clock=new ManualClock(new Date());
  await transaction(db.pool!,async tx=>{
   await setAuditIdentity(tx,{...identity('initiator'),account_id:'a'});
   await accounting.grant(tx,scope,clock,{idempotency_key:'grant',external_reference:'grant',source:'purchase',amount_units:'100',terms_version:'test',expires_at:null,actor_id:'shared-service'});
   await tx.query(`INSERT INTO recipe_versions(id,organization_id,application_id,key,version,definition,created_at,actor_id) VALUES('recipe','org','app','test',1,'{}',now(),'shared-service');
    INSERT INTO storage_inputs(id,organization_id,application_id,account_id,content_hash,expires_at) VALUES('input','org','app','a','hash',now()+interval '1 hour');
    INSERT INTO quotes(id,organization_id,application_id,account_id,wallet_id,recipe_id,kind,input_hash,input_ref,components,max_units,estimated_units,terms,created_at,expires_at) VALUES('quote','org','app','a','wa','recipe','single_call','hash','input','[]',10,10,'{}',now(),now()+interval '1 hour');
    INSERT INTO operations(id,organization_id,application_id,account_id,quote_id,client_operation_key,components,accepted_max_units,deadline_at,content_ttl_seconds,created_at) VALUES('operation','org','app','a','quote','operation','[]',10,now()+interval '1 hour',3600,now());
    INSERT INTO execution_requests(id,organization_id,application_id,account_id,operation_id,component,client_request_key,input_hash,input_ref,route,max_units,enqueued_at,not_before,deadline_at,created_at) VALUES('request','org','app','a','operation','test','request','hash','input','{}',10,now(),now(),now()+interval '1 hour',now());`);
   await accounting.reserve(tx,scope,clock,{idempotency_key:'reserve',operation_id:'operation',max_units:'10'});
   await accounting.claim(tx,scope,clock,{idempotency_key:'claim',operation_id:'operation',request_id:'request',max_units:'10'});
  });
  const capture=await transaction(db.pool!,async tx=>{
   await tx.query("UPDATE execution_requests SET attempt_count=1 WHERE id='request'");
   return accounting.settleClaim(tx,scope,clock,{idempotency_key:'capture',request_id:'request',charged_units:'5'});
  });
  const captured=(await db.pool!.query('SELECT audit_identity,actor_id FROM journal_transactions WHERE id=$1',[capture.capture_id])).rows[0];
  expect(captured).toMatchObject({actor_id:'system',audit_identity:{user_id:null,account_id:'a',external_team_id:'team-a',operation_id:'operation'}});
  await transaction(db.pool!,async tx=>{
   await setAuditIdentity(tx,{...identity('refund-staff'),account_id:'b'});
   await accounting.refund(tx,scope,clock,{idempotency_key:'refund',external_reference:'refund',capture_id:capture.capture_id!,amount_units:'2',reason:'staff refund',actor_id:'shared-service'});
   const event=await audit(tx,'capture-audit',capture.capture_id!);
   expect(event.audit_identity).toMatchObject({user_id:'refund-staff',account_id:'a',external_team_id:'team-a',operation_id:'operation'});
   await tx.query("UPDATE operations SET admission_status='closed' WHERE id='operation'");
  });
  const refund=(await db.pool!.query("SELECT audit_identity FROM journal_transactions WHERE type='refund'")).rows[0];
  expect(refund.audit_identity).toMatchObject({user_id:'refund-staff',account_id:'a',external_team_id:'team-a',operation_id:'operation'});
  for(const table of ['operations','execution_requests','quotes']){
   const original=(await db.pool!.query(`SELECT audit_identity FROM ${table}`)).rows[0];
   expect(original.audit_identity).toMatchObject({user_id:'initiator',account_id:'a',external_team_id:'team-a'});
  }
 });
 test('legacy internal execution without provisioned accounts stays compatible while asserted scopes fail closed',async()=>{
  const insert=(tx:Tx,key:string)=>tx.query("INSERT INTO execution_requests(id,organization_id,application_id,account_id,operation_id,component,client_request_key,input_hash,input_ref,route,max_units,enqueued_at,not_before,deadline_at,created_at) VALUES($1,'internal-org','internal-app','unprovisioned','internal-operation','test',$1,'hash','input','{}',0,now(),now(),now()+interval '1 hour',now()) RETURNING audit_identity",[key]);
  const row=await transaction(db.pool!,tx=>insert(tx,'internal-request'));
  expect(row.rows[0].audit_identity).toMatchObject({account_id:'unprovisioned',external_team_id:null,user_id:null});
  await expect(transaction(db.pool!,async tx=>{await setAuditIdentity(tx,{organization_id:'internal-org',application_id:'internal-app',service_principal_id:'service',user_id:'human'});return insert(tx,'asserted-internal-request')})).rejects.toThrow('Audit account scope mismatch');
 });
 test('upgrade preserves historic attribution without fabricating a human',async()=>{
  const name=`uai_identity_upgrade_${randomUUID().replaceAll('-','')}`,admin=createPool(process.env.DATABASE_URL);
  let upgraded:ReturnType<typeof createPool>|undefined;
  try{
   await admin.query(`CREATE DATABASE ${name}`);const url=new URL(process.env.DATABASE_URL!);url.pathname=`/${name}`;upgraded=createPool(url.href);
   const dir=new URL('../../../migrations/',import.meta.url);
   await transaction(upgraded,async tx=>{
    for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&f<'0055').sort())await tx.query(await readFile(new URL(file,dir),'utf8'));
    await tx.query("INSERT INTO audit_events VALUES('old','org','app','historic-service','test','old-resource','historic reason','{}',now())");
    await tx.query(await readFile(new URL('0055_external_identity.sql',dir),'utf8'));
   });
   expect((await upgraded.query("SELECT actor_id,audit_identity FROM audit_events WHERE id='old'")).rows[0]).toEqual({actor_id:'historic-service',audit_identity:null});
  }finally{await upgraded?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end()}
 },60000);
});
