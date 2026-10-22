import {afterAll,describe,expect,test} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {id,ManualClock} from '../../contracts/src/index.js';
import {ConnectionService,CredentialVault,ReportingCredentialService} from '../src/index.js';
const integration=process.env.DATABASE_URL?describe:describe.skip;const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end()});
integration('separate reporting credentials',()=>{
 test('rotation is scoped, encrypted, audited, CAS and independent of inference key',async()=>{
  const scope={organization_id:id('org'),application_id:id('app')};const clock=new ManualClock(new Date('2026-01-01'));const vault=new CredentialVault(Buffer.alloc(32,7));const actor={actor_id:'fixture',reason:'Rotate reporting fixture'};const bound={organization_id:'provider-org',project_id:'provider-project'};
  const c=await transaction(pool!,tx=>new ConnectionService(tx,clock,vault).create(scope,{provider:'openai',name:'Fixture',account_scope:bound,capabilities:{usage_reporting:true,cost_reporting:true,balance_reporting:false,request_cost_lookup:false,reporting_granularity:['day'],reporting_lag_seconds:300},limits:{},risk_policy:{}},actor));
  await transaction(pool!,tx=>new ConnectionService(tx,clock,vault).rotateCredential(scope,c.id,1,'inference-fixture',actor));
  const changed=await transaction(pool!,tx=>new ReportingCredentialService(tx,clock,vault).rotate(scope,c.id,2,'report-fixture',bound,actor));expect(changed.reporting_credential_revision).toBe(1);expect(changed.credential_revision).toBe(1);
  const reporting=new ReportingCredentialService(pool!,clock,vault);expect(await reporting.resolve(scope,c.id)).toEqual({credential:'report-fixture',credential_scope:bound,revision:1});expect(await new ConnectionService(pool!,clock,vault).resolveCredential(scope,c.id)).toBe('inference-fixture');
  expect(JSON.stringify(await reporting.metadata(scope,c.id))).not.toMatch(/report-fixture|ciphertext|tag|iv/);expect(JSON.stringify(await new ConnectionService(pool!,clock,vault).list(scope))).not.toMatch(/report-fixture|inference-fixture|ciphertext/);
  await expect(transaction(pool!,tx=>new ReportingCredentialService(tx,clock,vault).rotate(scope,c.id,2,'second',bound,actor))).rejects.toMatchObject({code:'revision_conflict'});
  await expect(transaction(pool!,tx=>new ReportingCredentialService(tx,clock,vault).rotate(scope,c.id,3,'second',{...bound,project_id:'foreign'},actor))).rejects.toMatchObject({code:'report_scope_mismatch'});
  await expect(reporting.resolve({...scope,application_id:'foreign'},c.id)).rejects.toMatchObject({code:'not_found'});
  const stored=(await pool!.query('SELECT * FROM provider_reporting_credentials WHERE connection_id=$1',[c.id])).rows;expect(stored).toHaveLength(1);expect(JSON.stringify(stored)).not.toContain('report-fixture');
  const audit=(await pool!.query("SELECT metadata FROM audit_events WHERE resource_id=$1 AND action='connection.reporting_credential_rotated'",[c.id])).rows;expect(audit).toHaveLength(1);expect(audit[0].metadata.reporting_credential_revision).toBe(1);
 });
});
