import {fork,type ChildProcess} from 'node:child_process';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {transaction} from '../../db/src/index.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {enqueue,type ExecutionRoute} from '../../execution/src/index.js';
import {ExecutionTransport,queueKinds} from '../src/transport.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL);
const enabled=Boolean(process.env.DATABASE_URL&&process.env.REDIS_URL);
beforeAll(async()=>{if(enabled)await database.initialize()});
afterAll(()=>database.close());
describe.skipIf(!enabled)('scheduler process recovery',()=>{
 it('replays publication after SIGKILL before the PostgreSQL acknowledgement with one Redis job',async()=>{
  const pool=database.pool!,installation=id('scheduler_crash');
  const transport=new ExecutionTransport(installation,process.env.REDIS_URL!);
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const route:ExecutionRoute={primary:{connection_id:'mock',model:'mock',endpoint_scope:'mock',max_cost_units:'0'},period_budget_key:'mock',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const request=await transaction(pool,tx=>enqueue(tx,scope,systemClock,{backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'test',client_request_key:id('key'),input_hash:'mock',input_ref:'mock',route,max_units:'0',deadline_at:new Date(Date.now()+120000)}));
  const children:ChildProcess[]=[],errors:string[]=[],messages:unknown[]=[];
  const start=(fixture:boolean)=>{
   const child=fork(new URL(fixture?'./fixtures/crash-scheduler.ts':'../../../apps/scheduler/src/index.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:database.url,UAI_EXECUTION_BACKEND:'bullmq',UAI_INSTALLATION_ID:installation,UAI_CRASH_TEST_ONLY:'1',UAI_SCHEDULER_ONCE:'true',UAI_ALLOW_REAL_PROVIDERS:'false'},stdio:['ignore','ignore','pipe','ipc']});
   children.push(child);child.on('message',message=>messages.push(message));child.on('error',error=>errors.push(error.message));child.stderr?.on('data',chunk=>errors.push(String(chunk)));
   return child;
  };
  try{
   const child=start(true);
   await vi.waitFor(()=>expect(messages).toContainEqual({type:'published',request_id:request.id}),{timeout:10000});
   const before=(await pool.query('SELECT published_at,lease_owner,delivery_count FROM execution_dispatches WHERE request_id=$1',[request.id])).rows[0];
   expect(before).toEqual({published_at:null,lease_owner:expect.any(String),delivery_count:0});
   expect(await transport.queue('text').getWaitingCount()).toBe(1);
   const killed=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
   child.kill('SIGKILL');expect(await killed).toEqual({code:null,signal:'SIGKILL'});
   // Use the real 30-second lease expiry, without modifying durable timestamps.
   await vi.waitFor(async()=>expect((await pool.query('SELECT lease_until<now() AS expired FROM execution_dispatches WHERE request_id=$1',[request.id])).rows[0].expired).toBe(true),{timeout:35000,interval:250});
   const restarted=start(false);
   const exit=await new Promise(resolve=>restarted.once('exit',(code,signal)=>resolve({code,signal})));
   expect(exit).toEqual({code:0,signal:null});
   const after=(await pool.query('SELECT published_at,lease_owner,delivery_count,generation FROM execution_dispatches WHERE request_id=$1',[request.id])).rows[0];
   expect(after).toEqual({published_at:expect.any(Date),lease_owner:null,delivery_count:1,generation:0});
   expect(await transport.queue('text').getWaitingCount()).toBe(1);
   expect((await pool.query('SELECT attempt_count,execution_status FROM execution_requests WHERE id=$1',[request.id])).rows[0]).toEqual({attempt_count:0,execution_status:'queued'});
   expect(errors).toEqual([]);
  }finally{
   for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await done}
   for(const kind of queueKinds)await transport.queue(kind).obliterate({force:true});
   await transport.close();
  }
 },60000);
});
