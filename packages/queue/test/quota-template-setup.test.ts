import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {transaction} from '../../db/src/index.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {previewQuotaTemplateSetup,applyQuotaTemplateSetup} from '../src/quota-template-setup.js';
const database=isolatedTestDatabase(process.env.DATABASE_URL);
beforeAll(async()=>{if(process.env.DATABASE_URL)await database.initialize()});afterAll(()=>database.close());
describe.skipIf(!process.env.DATABASE_URL)('verified quota template setup',()=>{
 it('shares alias groups, preserves customized limits and counters, rejects stale manifests and replays without writes',async()=>{
  const pool=database.pool!,scope={organization_id:id('org'),application_id:id('app')},actor={actor_id:'test',reason:'Isolated setup verification'};
  const models=['gpt-image-2.5-flare','gpt-image-2.5-flare-2026-09-08','gpt-4.1'];
  const connection=await transaction(pool,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
   const c=await new ConnectionService(tx,systemClock).create(scope,{provider:'openai',name:'Synthetic connection, no credentials',account_scope:{fixture:'test'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},actor);
   await tx.query(`INSERT INTO configuration_versions(id,organization_id,application_id,kind,key,version,status,payload,author,comment,created_at,published_at) VALUES($1,$2,$3,'catalog','fixture',1,'published',$4,'test','test',now(),now())`,[id('catalog'),scope.organization_id,scope.application_id,{models:models.map(model=>({id:model,provider:'openai',status:'active',capabilities:[model.startsWith('gpt-image')?'image.generate':'text.generate']}))}]);return c;
  });
  const setup={connection_id:connection.id,models,provider_account:'synthetic-account',provider_project:'synthetic-project',coordination_domain:'synthetic-domain',concurrency_limit:3};
  const preview=()=>transaction(pool,tx=>previewQuotaTemplateSetup(tx,scope,setup));
  const apply=(revision:string)=>transaction(pool,tx=>applyQuotaTemplateSetup(tx,scope,systemClock,setup,revision,actor));
  const initial=await preview();expect(initial.entries).toHaveLength(3);
  expect((await pool.query('SELECT id FROM provider_quota_groups')).rows).toHaveLength(0);
  const first=await apply(initial.revision);expect(new Set(first.map(r=>r.group_id)).size).toBe(2);
  expect(first.find(r=>r.model===models[0])!.group_id).toBe(first.find(r=>r.model===models[1])!.group_id);
  await expect(apply(initial.revision)).rejects.toMatchObject({code:'revision_conflict'});
  const flare=first.find(r=>r.model===models[0])!.group_id;
  await pool.query("UPDATE provider_quota_rules SET capacity=90 WHERE group_id=$1 AND key='ipm'",[flare]);
  await pool.query('UPDATE provider_quota_groups SET revision=revision+1,concurrency_limit=2 WHERE id=$1',[flare]);
  const fresh=await preview(),auditBefore=(await pool.query('SELECT count(*) n FROM audit_events')).rows[0].n;
  expect(await apply(fresh.revision)).toEqual(first);
  expect((await pool.query('SELECT count(*) n FROM audit_events')).rows[0].n).toBe(auditBefore);
  expect((await pool.query("SELECT capacity::text FROM provider_quota_rules WHERE group_id=$1 AND key='ipm'",[flare])).rows[0].capacity).toBe('90');
  expect((await pool.query('SELECT concurrency_limit FROM provider_quota_groups WHERE id=$1',[flare])).rows[0].concurrency_limit).toBe(2);
  await expect(transaction(pool,tx=>previewQuotaTemplateSetup(tx,{...scope,application_id:id('foreign')},setup))).rejects.toMatchObject({code:'not_found'});
  await expect(transaction(pool,tx=>previewQuotaTemplateSetup(tx,scope,{...setup,models:['unverified-model']}))).rejects.toMatchObject({code:'quota_template_missing'});
 });
});
