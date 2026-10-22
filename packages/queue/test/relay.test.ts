import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id,systemClock,type Scope} from '../../contracts/src/index.js';
import {enqueue,type ExecutionRoute} from '../../execution/src/index.js';
import {ExecutionTransport,deliveryId} from '../src/transport.js';
import {relayOne,reconcileDeliveries} from '../src/relay.js';
const sourceUrl=process.env.DATABASE_URL,database=isolatedTestDatabase(sourceUrl);
let pool:ReturnType<typeof createPool>|null=null;
beforeAll(async()=>{if(sourceUrl&&process.env.REDIS_URL){await database.initialize();pool=database.pool}});
afterAll(()=>database.close());
describe.skipIf(!sourceUrl||!process.env.REDIS_URL)('durable dispatch relay',()=>{
 it('rotates accounts, bounds concurrent publication and leaves future work in PostgreSQL',async()=>{
  const transport=new ExecutionTransport(id('fair'),process.env.REDIS_URL!);
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};
  const second={...scope,account_id:id('acct')},future={...scope,account_id:id('acct')};
  const route:ExecutionRoute={primary:{connection_id:'mock',model:'mock',endpoint_scope:'mock',max_cost_units:'0'},period_budget_key:'mock',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const add=(s:Scope,capability='text.generate')=>transaction(pool!,tx=>enqueue(tx,s,systemClock,{priority:10,backend:'bullmq',capability,operation_id:id('op'),component:'test',client_request_key:id('key'),input_hash:'mock',input_ref:'mock',route,max_units:'0',deadline_at:new Date(Date.now()+60000)}));
  try{
   const requests=[];for(let n=0;n<5;n++)requests.push(await add(scope));
   for(let n=0;n<2;n++)requests.push(await add(second));
   await pool!.query('UPDATE execution_requests SET priority=100 WHERE id=$1',[requests[4].id]);
   expect(await relayOne(pool!,transport)).toBe(true);expect(await relayOne(pool!,transport)).toBe(true);
   const first=(await pool!.query(`SELECT r.id,r.account_id FROM execution_dispatches d JOIN execution_requests r ON r.id=d.request_id WHERE r.organization_id=$1 AND d.selected_at IS NOT NULL ORDER BY d.selected_at`,[scope.organization_id])).rows;
   expect(first.map(r=>r.account_id)).toEqual([scope.account_id,second.account_id]);
   expect(first[0].id).toBe(requests[4].id);
   for(let n=0;n<5;n++)requests.push(await add(scope,'image.generate'));
   const later=await add(future);
   await pool!.query("UPDATE execution_requests SET not_before=now()+interval '30 seconds' WHERE id=$1",[later.id]);
   await pool!.query("UPDATE execution_dispatches SET due_at=now()+interval '30 seconds' WHERE request_id=$1",[later.id]);
   await Promise.all(Array.from({length:12},(_,n)=>relayOne(pool!,transport,`parallel-${n}`)));
   // Busy capability locks may make a concurrent poll return idle; the next tick fills capacity.
   for(let n=0;n<10&&await relayOne(pool!,transport);n++);
   const counts=(await pool!.query(`SELECT r.account_id,d.queue_kind,count(*)::int n FROM execution_dispatches d JOIN execution_requests r ON r.id=d.request_id WHERE r.organization_id=$1 AND d.selected_at IS NOT NULL GROUP BY r.account_id,d.queue_kind`,[scope.organization_id])).rows;
   expect(counts).toHaveLength(3);expect(counts.every(r=>r.n===2)).toBe(true);
   expect(await relayOne(pool!,transport)).toBe(false);
   const selected=(await pool!.query(`SELECT r.id FROM execution_dispatches d JOIN execution_requests r ON r.id=d.request_id WHERE r.organization_id=$1 AND r.account_id=$2 AND d.queue_kind='text' AND d.selected_at IS NOT NULL LIMIT 1`,[scope.organization_id,scope.account_id])).rows[0];
   await pool!.query("UPDATE execution_requests SET execution_status='succeeded' WHERE id=$1",[selected.id]);
   expect(await relayOne(pool!,transport)).toBe(true);
   expect((await pool!.query('SELECT selected_at FROM execution_dispatches WHERE request_id=$1',[later.id])).rows[0].selected_at).toBeNull();
  }finally{
   await pool!.query("UPDATE execution_requests SET execution_status='canceled' WHERE organization_id=$1",[scope.organization_id]);
   await transport.queue('text').obliterate({force:true});await transport.queue('image').obliterate({force:true});await transport.close();
  }
 });
 it('enforces application and capability publication caps across different accounts',async()=>{
  const transport=new ExecutionTransport(id('caps'),process.env.REDIS_URL!);
  const organization=id('org'),applications=[id('app'),id('app')];
  const original=(await pool!.query("SELECT * FROM execution_dispatch_policies WHERE queue_kind='tools'")).rows[0];
  const route:ExecutionRoute={primary:{connection_id:'mock',model:'mock',endpoint_scope:'mock',max_cost_units:'0'},period_budget_key:'mock',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  try{
   await pool!.query("UPDATE execution_dispatch_policies SET account_limit=1,application_limit=2,queue_limit=3 WHERE queue_kind='tools'");
   for(const application of applications)for(let n=0;n<3;n++)await transaction(pool!,tx=>enqueue(tx,{organization_id:organization,application_id:application,account_id:id('account')},systemClock,{priority:10,backend:'bullmq',capability:'search',operation_id:id('op'),component:'search',client_request_key:id('key'),input_hash:'mock',input_ref:'mock',route,max_units:'0',deadline_at:new Date(Date.now()+60000)}));
   await Promise.all(Array.from({length:8},()=>relayOne(pool!,transport)));
   for(let n=0;n<10&&await relayOne(pool!,transport);n++);
   const counts=(await pool!.query(`SELECT r.application_id,count(*)::int n FROM execution_dispatches d JOIN execution_requests r ON r.id=d.request_id WHERE r.organization_id=$1 AND d.selected_at IS NOT NULL GROUP BY r.application_id`,[organization])).rows;
   expect(counts.reduce((n,r)=>n+r.n,0)).toBe(3);expect(counts.every(r=>r.n<=2)).toBe(true);
   expect(await relayOne(pool!,transport)).toBe(false);
  }finally{
   await pool!.query("UPDATE execution_dispatch_policies SET account_limit=$1,application_limit=$2,queue_limit=$3 WHERE queue_kind='tools'",[original.account_limit,original.application_limit,original.queue_limit]);
   await pool!.query("UPDATE execution_requests SET execution_status='canceled' WHERE organization_id=$1",[organization]);
   await transport.queue('tools').obliterate({force:true});await transport.close();
  }
 });
 it('sweeps past healthy jobs and restores later lost jobs with competing reconcilers',async()=>{
  const transport=new ExecutionTransport(id('sweep'),process.env.REDIS_URL!);
  const organization=id('org'),application=id('app'),requests:any[]=[];
  const route:ExecutionRoute={primary:{connection_id:'mock',model:'mock',endpoint_scope:'mock',max_cost_units:'0'},period_budget_key:'mock',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  try{
   for(let n=0;n<6;n++){
    const request=await transaction(pool!,tx=>enqueue(tx,{organization_id:organization,application_id:application,account_id:id('account')},systemClock,{priority:10,backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'mock',input_ref:'mock',route,max_units:'0',deadline_at:new Date(Date.now()+60000)}));requests.push(request);
    expect(await relayOne(pool!,transport)).toBe(true);
   }
   for(const request of requests.slice(4))await (await transport.queue('text').getJob(deliveryId(transport.installation,{request_id:request.id,generation:0,purpose:'execute'})))!.remove();
   expect(await reconcileDeliveries(pool!,transport,2)).toBe(0);
   const results=await Promise.all([reconcileDeliveries(pool!,transport,2),reconcileDeliveries(pool!,transport,2)]);
   expect(results.reduce((sum,n)=>sum+n,0)).toBe(2);
   const rows=(await pool!.query('SELECT id,dispatch_generation FROM execution_requests WHERE organization_id=$1 ORDER BY created_at,id',[organization])).rows;
   expect(rows.map(r=>r.dispatch_generation)).toEqual([0,0,0,0,1,1]);
   expect(await reconcileDeliveries(pool!,transport,2)).toBe(0);
   // After the bounded check lease expires, an earlier job lost since its healthy check is found too.
   await (await transport.queue('text').getJob(deliveryId(transport.installation,{request_id:requests[0].id,generation:0,purpose:'execute'})))!.remove();
   await pool!.query("UPDATE execution_dispatches SET reconcile_after=now()-interval '1 second' WHERE request_id=$1",[requests[0].id]);
   expect(await reconcileDeliveries(pool!,transport,2)).toBe(1);
  }finally{
   await pool!.query("UPDATE execution_requests SET execution_status='canceled' WHERE organization_id=$1",[organization]);await transport.queue('text').obliterate({force:true});await transport.close();
  }
 });
 it('replays lost acknowledgement and rebuilds a lost job with a fenced generation',async()=>{
  const transport=new ExecutionTransport(id('test'),process.env.REDIS_URL!);
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};
  const route:ExecutionRoute={primary:{connection_id:'mock',model:'mock',endpoint_scope:'mock',max_cost_units:'0'},period_budget_key:'mock',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const request=await transaction(pool!,tx=>enqueue(tx,scope,systemClock,{priority:10,backend:'bullmq',capability:'text.generate',operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'mock',input_ref:'mock',route,max_units:'0',deadline_at:new Date(Date.now()+60000)}));
  try{
   expect(await relayOne(pool!,transport)).toBe(true);
   await pool!.query('UPDATE execution_dispatches SET published_at=NULL WHERE request_id=$1',[request.id]);
   expect(await relayOne(pool!,transport)).toBe(true);
   expect(await transport.queue('text').getWaitingCount()).toBe(1);
   const job=await transport.queue('text').getJob(deliveryId(transport.installation,{request_id:request.id,generation:0,purpose:'execute'}));await job!.remove();
   expect(await reconcileDeliveries(pool!,transport)).toBe(1);
   expect((await pool!.query('SELECT generation FROM execution_dispatches WHERE request_id=$1 AND recovered_at IS NOT NULL',[request.id])).rows).toEqual([{generation:1}]);
   expect((await pool!.query('SELECT dispatch_generation FROM execution_requests WHERE id=$1',[request.id])).rows[0].dispatch_generation).toBe(1);
   expect(await relayOne(pool!,transport)).toBe(true);
   expect(await transport.queue('text').getWaitingCount()).toBe(1);
   await pool!.query("UPDATE execution_requests SET execution_status='outcome_unknown' WHERE id=$1",[request.id]);
   await transport.queue('text').drain();expect(await reconcileDeliveries(pool!,transport)).toBe(0);
  }finally{await pool!.query("UPDATE execution_requests SET execution_status='canceled' WHERE id=$1",[request.id]);await transport.queue('text').obliterate({force:true});await transport.close()}
 });
});
