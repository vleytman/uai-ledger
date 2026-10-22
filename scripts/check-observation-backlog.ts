/** Mock-only profiling, never provider calls. Select a disposable DB explicitly. */
import {writeFile} from 'node:fs/promises';
import {createPool,transaction} from '../packages/db/src/index.js';
import {id} from '../packages/contracts/src/index.js';
import {observationCandidateSql} from '../packages/queue/src/observation-relay.js';
if(!process.env.DATABASE_URL||process.env.UAI_OBSERVATION_BENCHMARK!=='test-only')throw new Error('explicit_test_database_and_opt_in_required');
const count=Number(process.env.BACKLOG_COUNT??10000);
if(!Number.isSafeInteger(count)||count<10||count>1000000)throw new Error('invalid_backlog_count');
const pool=createPool(),scope=id('observation-backlog'),now=new Date('2198-01-01T00:00:00Z');
const route={primary:{connection_id:'mock',model:'mock',endpoint_scope:'mock',max_cost_units:'0'},period_budget_key:'mock',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
try{
 await transaction(pool,async tx=>{
  await tx.query(`INSERT INTO execution_requests(id,organization_id,application_id,account_id,operation_id,component,client_request_key,input_hash,input_ref,route,max_units,enqueued_at,not_before,deadline_at,created_at,execution_backend,queue_kind,execution_status,attempt_count)
   SELECT $1||'-'||n,$1,$1,CASE WHEN n<=$2 THEN $1||'-large' ELSE $1||'-small-'||n END,$1||'-op-'||n,'image',$1||'-key-'||n,'mock','mock',$3,0,$4,$4,$4::timestamptz+interval '1 hour',$4,'bullmq','image','running',1
   FROM generate_series(1,$2::integer+3) n`,[scope,count,route,now]);
  await tx.query(`INSERT INTO execution_attempts(id,request_id,number,fencing_token,variant,status,submission_intent_at,provider_idempotency_key,remote_job_id,created_at)
   SELECT id||'-attempt',id,1,0,$2,'running',$3,id,id,$3 FROM execution_requests WHERE organization_id=$1`,[scope,route.primary,now]);
  await tx.query(`INSERT INTO execution_dispatch_fairness(queue_kind,organization_id,application_id,account_id,last_served_at)
   SELECT 'observe',organization_id,application_id,account_id,min(enqueued_at) FROM execution_requests WHERE organization_id=$1 GROUP BY organization_id,application_id,account_id ON CONFLICT DO NOTHING`,[scope]);
 });
 await pool.query('ANALYZE execution_requests');await pool.query('ANALYZE execution_attempts');await pool.query('ANALYZE execution_dispatch_fairness');
 const plans=[],times=[];
 for(let i=0;i<3;i++){
  const result=await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+observationCandidateSql,[now,256,null,null,null,true,'[]','[]',2]);
  const plan=result.rows[0]['QUERY PLAN'][0];plans.push(plan);times.push(plan['Execution Time']);
 }
 const rows=(await pool.query(observationCandidateSql,[now,256,null,null,null,true,'[]','[]',2])).rows;
 if(new Set(rows.slice(0,4).map(row=>row.account_id)).size!==4)throw new Error('observation_fairness_failed');
 const result={backlog:count,accounts:4,candidates:rows.length,selection_ms:times,plans};
 if(process.env.OBSERVATION_EXPLAIN_PATH)await writeFile(process.env.OBSERVATION_EXPLAIN_PATH,JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,plans:undefined},null,2));
}finally{
 await pool.query('DELETE FROM execution_attempts WHERE request_id IN (SELECT id FROM execution_requests WHERE organization_id=$1)',[scope]);
 await pool.query('DELETE FROM execution_requests WHERE organization_id=$1',[scope]);
 await pool.query('DELETE FROM execution_dispatch_fairness WHERE organization_id=$1',[scope]);await pool.end();
}
