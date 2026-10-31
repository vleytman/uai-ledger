import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {transaction} from '../../db/src/index.js';
import {id,systemClock,type Scope} from '../../contracts/src/index.js';
import {enqueue,leaseNext,type ExecutionRoute} from '../../execution/src/index.js';
import {recordAdmissionIntent,acquireDurable} from '../src/admission.js';
import {QuotaStore} from '../src/quota.js';

const url=process.env.REDIS_URL,database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!url;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());

describe.skipIf(!enabled)('quota recovery after Redis loss',()=>{
 it('restores only what can still count, so the first call after a restore is admitted at once and not against stale intents',async()=>{
  const pool=database.pool!,scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota');
  await pool.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,concurrency_limit) VALUES($1,$2,$1,'fake','{}','epoch','test',100)",[group,scope.organization_id]);
  await pool.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',1000,60000)",[group]);
  const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const call=async()=>{
   const request=await transaction(pool,tx=>enqueue(tx,scope,systemClock,{priority:10,operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'test',input_ref:'test',route,max_units:'0',deadline_at:new Date(Date.now()+600000)}));
   const lease=await transaction(pool,tx=>leaseNext(tx,systemClock,'worker',{scope,account:100,application:100},undefined,request.id));
   return {id:id('admission'),group_id:group,request_id:request.id as string,fence:String(lease.fencing_token),demands:[{key:'requests',capacity:1000,amount:1,window_ms:60000}]};
  };
  const demands=JSON.stringify([{key:'requests',capacity:1000,amount:1,window_ms:60000}]);
  // A finished call from earlier runs: its admissions and intents belong to fences that will never be used again.
  const finished=await call();
  await pool.query("UPDATE execution_requests SET execution_status='succeeded',fencing_token=100000,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[finished.request_id]);
  const insert=(count:number,state:string,ago:string,offset:number)=>pool.query(`INSERT INTO dispatch_admissions(id,group_id,request_id,fencing_token,rules_revision,demands,state,admitted_at,created_at,slot_expires_at,slot_released_at,rule_metrics)
   SELECT 'old-'||$5||'-'||n,$1,$2,$3::int+n,0,$4::jsonb,$5,CASE WHEN $5='admitted' THEN now()-$6::interval END,now()-$6::interval,now()-$6::interval,CASE WHEN $5='admitted' THEN now()-$6::interval END,'{"requests":"requests"}'
   FROM generate_series(1,$7::int) n`,[group,finished.request_id,offset,demands,state,ago,count]);
  await insert(5000,'admitted','2 hours',0);
  await insert(300,'intent','3 hours',5000);
  // Still in the window: five calls admitted ten seconds ago.
  await pool.query(`INSERT INTO dispatch_admissions(id,group_id,request_id,fencing_token,rules_revision,demands,state,admitted_at,created_at,slot_expires_at,slot_released_at,rule_metrics)
   SELECT 'recent-'||n,$1,$2,6000+n,0,$3::jsonb,'admitted',now()-interval '10 seconds',now()-interval '10 seconds',now()-interval '5 seconds',now()-interval '5 seconds','{"requests":"requests"}' FROM generate_series(1,5) n`,[group,finished.request_id,demands]);
  // A live call whose acquire may have happened without an acknowledgement: counted conservatively.
  const live=await call();await recordAdmissionIntent(pool,live);
  // A new, empty Redis: a fresh installation namespace has no state for this group.
  const installation=id('restored'),store=new QuotaStore(url!,installation,group);
  const tag=createHash('sha256').update(JSON.stringify([installation,group])).digest('hex');
  try{
   await store.connect();
   const next=await call();await recordAdmissionIntent(pool,next);
   const started=performance.now();const result=await acquireDurable(pool,store,next);const ms=performance.now()-started;
   expect(result.allowed).toBe(true);
   const snapshot=await store.snapshot('epoch',[{key:'requests',capacity:1000,window_ms:60000}]);
   const markers=(await store.redis.keys(`uai-quota:{${tag}}:admission:*`)).length;
   const report={stale_admissions:5000,stale_intents:300,recent_admissions:5,live_intents:1,first_admission_ms:Math.round(ms),restored_markers:markers,used:snapshot.ready?snapshot.rules[0]!.used:null};
   await mkdir('.data/test-reports',{recursive:true});await writeFile('.data/test-reports/quota-recovery.json',JSON.stringify(report,null,2)+'\n');
   // Five recent admissions, the live intent and the new call.
   expect(report.used).toBe('7');
   expect(markers).toBe(7);
   expect(ms).toBeLessThan(2000);
  }finally{
   await pool.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);
   const keys=await store.redis.keys(`uai-quota:{${tag}}:*`);if(keys.length)await store.redis.del(...keys);
   await store.close();
  }
 },120000);
});
