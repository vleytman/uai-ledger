/** Mock-only dispatch benchmark. Requires an explicitly selected disposable database. */
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {createPool,transaction} from '../packages/db/src/index.js';
import {id} from '../packages/contracts/src/index.js';
import {ExecutionTransport} from '../packages/queue/src/transport.js';
import {relayOne,dispatchCandidateSql,dispatchRequestSql} from '../packages/queue/src/relay.js';
if(!process.env.DATABASE_URL||!process.env.REDIS_URL||process.env.UAI_DISPATCH_BENCHMARK!=='test-only')throw new Error('explicit_test_database_and_opt_in_required');
const count=Number(process.env.BACKLOG_COUNT??10000);
if(!Number.isSafeInteger(count)||count<10||count>1000000)throw new Error('invalid_backlog_count');
const pool=createPool(),scope=id('backlog'),transport=new ExecutionTransport(scope,process.env.REDIS_URL);
const route={primary:{connection_id:'mock',model:'mock',endpoint_scope:'mock',max_cost_units:'0'},period_budget_key:'mock',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
try{
 await transaction(pool,async tx=>{
  await tx.query(`INSERT INTO execution_requests(id,organization_id,application_id,account_id,operation_id,component,client_request_key,input_hash,input_ref,route,max_units,enqueued_at,not_before,deadline_at,created_at,execution_backend,queue_kind)
   SELECT $1||'-'||n,$1,$1,CASE WHEN n<=$2 THEN $1||'-large' ELSE $1||'-small-'||n END,$1||'-op-'||n,'test',$1||'-key-'||n,'mock','mock',$3,0,now(),now(),now()+interval '1 hour',now(),'bullmq','text'
   FROM generate_series(1,$2::integer+3) n`,[scope,count,route]);
  await tx.query("INSERT INTO execution_dispatches(request_id,generation,queue_kind,due_at) SELECT id,0,'text',now() FROM execution_requests WHERE organization_id=$1",[scope]);
 });
 await pool.query('ANALYZE execution_requests');await pool.query('ANALYZE execution_dispatches');await pool.query('ANALYZE execution_dispatch_fairness');
 if(process.env.DISPATCH_EXPLAIN_PATH){const plan=await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+dispatchCandidateSql,['text',2,32,128]);const request=await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+dispatchRequestSql,['text',scope,scope,scope+'-large',true]);await writeFile(process.env.DISPATCH_EXPLAIN_PATH,JSON.stringify({accounts:plan.rows[0]['QUERY PLAN'],request:request.rows[0]['QUERY PLAN']},null,2))}
 const samples:number[]=[];
 for(let n=0;n<8;n++){const start=performance.now();await relayOne(pool,transport);samples.push(Math.round((performance.now()-start)*100)/100)}
 const selected=(await pool.query(`SELECT r.account_id,count(*)::integer count FROM execution_requests r JOIN execution_dispatches d ON d.request_id=r.id WHERE r.organization_id=$1 AND d.selected_at IS NOT NULL GROUP BY r.account_id`,[scope])).rows;
 if(selected.length!==4||selected.find(r=>r.account_id.endsWith('-large'))?.count!==2)throw new Error('dispatch_fairness_failed');
 console.log(JSON.stringify({backlog:count,accounts:4,selected:selected.reduce((sum,r)=>sum+r.count,0),relay_ms:samples,max_ms:Math.max(...samples)},null,2));
}finally{
 await pool.query('DELETE FROM execution_dispatches WHERE request_id IN (SELECT id FROM execution_requests WHERE organization_id=$1)',[scope]);
 await pool.query('DELETE FROM execution_requests WHERE organization_id=$1',[scope]);
 await pool.query('DELETE FROM execution_dispatch_fairness WHERE organization_id=$1',[scope]);
 await transport.queue('text').obliterate({force:true});await transport.close();await pool.end();
}
