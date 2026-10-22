import {afterAll,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {id,systemClock,type Scope} from '../../contracts/src/index.js';
import {enqueue,leaseNext,type ExecutionRoute} from '../../execution/src/index.js';
import {priorityValue} from '../../execution/src/priority.js';
import {WorkerPriorityGate} from '../src/worker-priority.js';
import {recordAdmissionIntent,acquireDurable} from '../src/admission.js';
import {QuotaStore} from '../src/quota.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
it('LF-A08 reserves physical worker capacity and releases it after completion',async()=>{
 const gate=new WorkerPriorityGate(2,1);let release!:()=>void;
 const running=gate.run(0,()=>new Promise(resolve=>{release=()=>resolve('done')}));
 expect(await gate.run(0,async()=> 'must wait')).toMatchObject({worked:false});
 expect(await gate.run(10,async()=> 'interactive')).toBe('interactive');release();await running;
 expect(await gate.run(0,async()=> 'background again')).toBe('background again');
 expect(priorityValue(undefined)).toBe(0);expect(()=>priorityValue('urgent')).toThrow();
});
it.skipIf(!pool)('LF-A08 LF-A09 concurrent leases reserve a live slot and never double-admit',async()=>{
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
 const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'fixture',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
 const add=(priority:number)=>transaction(pool!,tx=>enqueue(tx,scope,systemClock,{priority,operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(Date.now()+60000)}));
 const requests=await Promise.all([add(0),add(0),add(10)]);
 const lease=(requestId:string)=>transaction(pool!,tx=>leaseNext(tx,systemClock,id('worker'),{scope,global:2,application:2,account:2},undefined,requestId));
 try{
  const background=await Promise.all(requests.slice(0,2).map(r=>lease(r.id)));
  expect(background.filter(Boolean)).toHaveLength(1);const live=await lease(requests[2].id);expect(live?.priority).toBe(10);
  expect(await lease(requests[2].id)).toBeNull();
 }finally{await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);}
});
it.skipIf(!pool||!process.env.REDIS_URL)('LF-A09 PostgreSQL and Redis quota admission retains the provider slot for interactive',async()=>{
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('group'),store=new QuotaStore(process.env.REDIS_URL!,'lf-test',group);
 await store.connect();
 await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,concurrency_limit) VALUES($1,$2,$1,'fake','{}','epoch','fixture',2)",[group,scope.organization_id]);
 await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',10,60000)",[group]);
 const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'fixture',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
 const add=async(priority:number)=>{
  const request=await transaction(pool!,tx=>enqueue(tx,scope,systemClock,{priority,operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(Date.now()+60000)}));
  const leased=await transaction(pool!,tx=>leaseNext(tx,systemClock,'worker',{scope,account:10,application:10},undefined,request.id));
  const input={id:id('admission'),group_id:group,request_id:request.id,fence:String(leased.fencing_token),demands:[{key:'requests',capacity:10,amount:1,window_ms:60000}]};await recordAdmissionIntent(pool!,input);return input;
 };
 try{
  const first=await add(0),second=await add(0),live=await add(10);
  const results=await Promise.all([acquireDurable(pool!,store,first),acquireDurable(pool!,store,second)]);
  expect(results.filter(r=>r.allowed)).toHaveLength(1);
  expect((await acquireDurable(pool!,store,live)).allowed).toBe(true);
  expect((await acquireDurable(pool!,store,live)).allowed).toBe(true);
  expect((await pool!.query("SELECT count(*)::int n FROM dispatch_admissions WHERE group_id=$1 AND state='admitted'",[group])).rows[0].n).toBe(2);
 }finally{await store.close();await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);}
});
it.skipIf(!pool||!process.env.REDIS_URL)('LF-A08 preserves publication room for live work and serves an aged background task after capacity frees',async()=>{
 const {isolatedTestDatabase}=await import('../../db/test/isolated-database.js'),database=isolatedTestDatabase(process.env.DATABASE_URL);await database.initialize();const db=database.pool!;
 const {ExecutionTransport}=await import('../src/transport.js'),{relayOne}=await import('../src/relay.js');const transport=new ExecutionTransport(id('lf-priority'),process.env.REDIS_URL!);
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'fixture',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
 const add=(priority:number)=>transaction(db,tx=>enqueue(tx,scope,systemClock,{priority,backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'fixture',input_ref:'fixture',route,max_units:'0',deadline_at:new Date(Date.now()+3600000)}));
 try{
  await db.query("UPDATE execution_dispatch_policies SET account_limit=2,application_limit=2,queue_limit=2,interactive_reserve=1 WHERE queue_kind='text'");
  const first=await add(0),aged=await add(0);expect(await relayOne(db,transport)).toBe(true);expect(await relayOne(db,transport)).toBe(false);
  const live=await add(10);expect(await relayOne(db,transport)).toBe(true);expect((await db.query('SELECT selected_at FROM execution_dispatches WHERE request_id=$1',[live.id])).rows[0].selected_at).not.toBeNull();
  await db.query("UPDATE execution_requests SET execution_status='succeeded' WHERE id=ANY($1)",[[first.id,live.id]]);
  await db.query("UPDATE execution_requests SET enqueued_at=now()-interval '11 minutes' WHERE id=$1",[aged.id]);const newer=await add(10);
  expect(await relayOne(db,transport)).toBe(true);expect((await db.query('SELECT selected_at FROM execution_dispatches WHERE request_id=$1',[aged.id])).rows[0].selected_at).not.toBeNull();expect((await db.query('SELECT selected_at FROM execution_dispatches WHERE request_id=$1',[newer.id])).rows[0].selected_at).toBeNull();
 }finally{await transport.queue('text').obliterate({force:true});await transport.close();await database.close()}
});
