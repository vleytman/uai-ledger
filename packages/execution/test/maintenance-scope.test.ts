import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {transaction} from '../../db/src/index.js';
import {lockExecutionAccount,lockLegacyCapacity} from '../../db/src/execution-lock.js';
import {id,ManualClock} from '../../contracts/src/index.js';
import {enqueue,leaseNext,expireRequests,type ExecutionRoute} from '../src/index.js';
const database=isolatedTestDatabase(process.env.DATABASE_URL);
beforeAll(async()=>{if(process.env.DATABASE_URL)await database.initialize()});
afterAll(()=>database.close());
describe.skipIf(!process.env.DATABASE_URL)('unscoped maintenance compatibility',()=>{
 it('skips a locked account, closes another and picks up the skipped request on the next sweep',async()=>{
  const pool=database.pool!,clock=new ManualClock(new Date('2026-01-03T12:00:00Z'));
  const a={organization_id:id('org'),application_id:id('app'),account_id:id('account')},b={...a,account_id:id('account')};
  const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const add=(scope:typeof a)=>transaction(pool,tx=>enqueue(tx,scope,clock,{backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'result',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(clock.now().getTime()+1000)}));
  const first=await add(a),second=await add(b);clock.advance(1001);const held=await pool.connect(),charged:string[]=[];
  const sweep=()=>transaction(pool,async tx=>{await tx.query("SET LOCAL statement_timeout='1500ms'");return expireRequests(tx,clock,async(_tx,_scope,input)=>{charged.push(input.request_id)})});
  try{
   await held.query('BEGIN');await lockExecutionAccount(held,a);
   expect(await sweep()).toBe(1);expect(charged).toEqual([second.id]);
   expect((await pool.query('SELECT execution_status FROM execution_requests WHERE id=$1',[first.id])).rows[0].execution_status).toBe('queued');
   await held.query('ROLLBACK');expect(await sweep()).toBe(1);expect(charged).toEqual([second.id,first.id]);expect(await sweep()).toBe(0);
  }finally{await held.query('ROLLBACK');held.release()}
 });
 it('legacy capacity cannot block BullMQ leases or independent account transactions',async()=>{
  const pool=database.pool!,clock=new ManualClock(new Date('2026-01-04T12:00:00Z'));
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const request=await transaction(pool,tx=>enqueue(tx,scope,clock,{backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'result',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(clock.now().getTime()+3600000)}));
  const held=await pool.connect();
  try{
   await held.query('BEGIN');await lockLegacyCapacity(held);
   await transaction(pool,async tx=>{await tx.query("SET LOCAL statement_timeout='1500ms'");await lockExecutionAccount(tx,scope)});
   const leased=await transaction(pool,async tx=>{await tx.query("SET LOCAL statement_timeout='1500ms'");return leaseNext(tx,clock,'bullmq-worker',{backend:'bullmq',scope,generation:0},undefined,request.id,true)});
   expect(leased.id).toBe(request.id);
  }finally{await held.query('ROLLBACK');held.release()}
 });

});
