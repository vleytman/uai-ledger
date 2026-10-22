import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {transaction} from '../../db/src/index.js';
import {ensureWallet} from '../../accounting/src/index.js';
import {id,systemClock,ManualClock,type Scope} from '../../contracts/src/index.js';
import {lockExecutionAccount} from '../../db/src/execution-lock.js';
import {financialMaintenance} from '../src/financial-maintenance.js';
import {enqueue,cancelRequest,getRequest,leaseNext,enableIncident,type Settlement} from '../src/index.js';
const database=isolatedTestDatabase(process.env.DATABASE_URL);
beforeAll(async()=>{if(process.env.DATABASE_URL)await database.initialize()});
afterAll(async()=>{await database.close()});
describe.skipIf(!process.env.DATABASE_URL)('Account execution barrier',()=>{
 it('serializes incident re-enable by endpoint without blocking another endpoint',async()=>{
  const pool=database.pool!,scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},ids=[id('incident'),id('incident')];
  for(const incident of ids)await pool.query("INSERT INTO execution_incidents(id,organization_id,failure_scope,status,next_retry_at,created_at,reason) VALUES($1,$2,$1,'locked',now(),now(),'synthetic')",[incident,scope.organization_id]);
  const held=await pool.connect();
  try{
   await held.query('BEGIN');await enableIncident(held,scope,systemClock,ids[0],'Synthetic recovery');
   const other=await transaction(pool,async tx=>{await tx.query("SET LOCAL lock_timeout='500ms'");return enableIncident(tx,scope,systemClock,ids[1],'Independent recovery')});
   expect(other.status).toBe('recovered');
   await expect(transaction(pool,async tx=>{await tx.query("SET LOCAL lock_timeout='100ms'");return enableIncident(tx,scope,systemClock,ids[0],'Same endpoint')})).rejects.toMatchObject({code:'55P03'});
   await expect(transaction(pool,tx=>enableIncident(tx,{...scope,organization_id:id('foreign')},systemClock,ids[1],'Wrong scope'))).rejects.toMatchObject({code:'not_found'});
  }finally{await held.query('ROLLBACK');held.release()}
 });
 for(const blockerKind of ['barrier','wallet'] as const)it(`maintenance skips a busy ${blockerKind}, processes another account and retries once after release`,async()=>{
  const pool=database.pool!,clock=new ManualClock(new Date()),first:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},second={...first,account_id:id('account')};
  await pool.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[first.application_id,first.organization_id]);
  for(const scope of [first,second])await pool.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
  const add=(scope:Scope)=>transaction(pool,tx=>enqueue(tx,scope,clock,{backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'test',input_ref:'test',route:{primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(clock.now().getTime()+1000)}));
  const a=await add(first),b=await add(second);clock.advance(1001);
  const settle:Settlement=async(tx,scope)=>{await ensureWallet(tx,scope)};
  const held=await pool.connect();
  try{
   await held.query('BEGIN');
   if(blockerKind==='barrier')await lockExecutionAccount(held,first);else await ensureWallet(held,first);
   const result=await financialMaintenance(pool,clock,settle);
   expect(result).toMatchObject({deadlines:1,maintenance_accounts:1,maintenance_busy_accounts:1});
   expect(await getRequest(pool,first,a.id)).toMatchObject({execution_status:'queued',financial_closed_at:null});
   expect(await getRequest(pool,second,b.id)).toMatchObject({execution_status:'canceled',settlement_status:'settled'});
   await held.query('COMMIT');
   expect(await financialMaintenance(pool,clock,settle)).toMatchObject({deadlines:1,maintenance_busy_accounts:0});
   expect(await financialMaintenance(pool,clock,settle)).toMatchObject({deadlines:0,maintenance_accounts:0});
   expect((await pool.query("SELECT resource->>'id' AS request,count(*)::int n FROM outbox_events WHERE organization_id=$1 AND type='request.canceled' GROUP BY resource->>'id' ORDER BY request",[first.organization_id])).rows).toEqual([a.id,b.id].sort().map(request=>({request,n:1})));
  }finally{await held.query('ROLLBACK');held.release()}
 });
 it('allows another account to settle while a cancellation transaction stays open, but fences the same account',async()=>{
  const pool=database.pool!,first:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},second={...first,account_id:id('account')};
  await pool.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[first.application_id,first.organization_id]);
  for(const scope of [first,second])await pool.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
  const add=(scope:Scope)=>transaction(pool,tx=>enqueue(tx,scope,systemClock,{backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'test',input_ref:'test',route:{primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(Date.now()+60000)}));
  const a=await add(first),b=await add(second),c=await add(first),d=await add(second);
  const settle:Settlement=async(tx,scope)=>{await ensureWallet(tx,scope)};
  const held=await pool.connect();
  try{
   await held.query('BEGIN');await cancelRequest(held,first,systemClock,a.id,settle);
   await transaction(pool,async tx=>{await tx.query("SET LOCAL lock_timeout='500ms'");await cancelRequest(tx,second,systemClock,b.id,settle)});
   expect(await getRequest(pool,second,b.id)).toMatchObject({execution_status:'canceled',settlement_status:'settled'});
   const lease=await transaction(pool,async tx=>{await tx.query("SET LOCAL lock_timeout='500ms'");return leaseNext(tx,systemClock,'parallel',{backend:'bullmq',scope:second},undefined,d.id,true)});
   expect(lease.id).toBe(d.id);
   await expect(transaction(pool,async tx=>{await tx.query("SET LOCAL lock_timeout='100ms'");return cancelRequest(tx,first,systemClock,c.id,settle)})).rejects.toMatchObject({code:'55P03'});
   expect((await getRequest(pool,first,c.id)).execution_status).toBe('queued');
   await held.query('COMMIT');
   await transaction(pool,tx=>cancelRequest(tx,first,systemClock,c.id,settle));
   expect((await getRequest(pool,first,c.id)).execution_status).toBe('canceled');
  }finally{await held.query('ROLLBACK');held.release()}
 });
});
