import {afterAll,describe,expect,it} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {enqueue,leaseNext} from '../../execution/src/index.js';
import {assertQuotaProof} from '../../execution/src/quota-proof.js';

const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool)('Quota binding configuration during dispatch',()=>{
 for(const mutation of ['insert','update','delete'])it(`isolates unrelated routes while fencing ${mutation} on the checked route`,async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},connection=id('connection'),group=id('quota'),second=id('quota');
  const {request,admission,fence}=await transaction(pool!,async tx=>{
   await tx.query("INSERT INTO provider_connections(id,organization_id,application_id,provider,name,account_scope,capabilities,limits,risk_policy,created_at,updated_at) VALUES($1,$2,$3,'fake','Fixture','{}','{}','{}','{}',now(),now())",[connection,scope.organization_id,scope.application_id]);
   for(const g of [group,second])await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','test','synthetic')",[g,scope.organization_id]);
   await tx.query("INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,'model-a',$2)",[connection,group]);
   const request=await enqueue(tx,scope,systemClock,{operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'mock',input_ref:'mock',route:{primary:{connection_id:connection,model:'model-a',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(Date.now()+60000)});
   const lease=await leaseNext(tx,systemClock,'test',{scope,account:10,application:10},undefined,request.id),admission=id('admission');
   await tx.query("INSERT INTO dispatch_admissions(id,group_id,request_id,fencing_token,rules_revision,demands,state,admitted_at,slot_heartbeat_until,slot_expires_at) VALUES($1,$2,$3,$4,1,'[]','admitted',now(),now()+interval '30 seconds',now()+interval '60 seconds')",[admission,group,request.id,lease.fencing_token]);
   return {request:request.id,admission,fence:String(lease.fencing_token)};
  });
  const reader=await pool!.connect(),writer=await pool!.connect();
  const change=()=>mutation==='insert'
   ?writer.query("INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,'model-a',$2)",[connection,second])
   :mutation==='update'
    ?writer.query("UPDATE provider_quota_bindings SET model='model-c' WHERE connection_id=$1 AND model='model-a'",[connection])
    :writer.query("DELETE FROM provider_quota_bindings WHERE connection_id=$1 AND model='model-a'",[connection]);
  try{
   await reader.query('BEGIN');await assertQuotaProof(reader,admission,request,fence,connection,'model-a');
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='300ms'");
   // A different model on the SAME connection must remain editable.
   await writer.query("INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,'model-b',$2)",[connection,second]);
   await writer.query('COMMIT');
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='150ms'");
   await expect(change()).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK');
   await writer.query('BEGIN');await writer.query("SET LOCAL statement_timeout='3000ms'");
   const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const pending=change().then(()=>({ok:true as const}),error=>({ok:false as const,error}));
   let waiting=false;
   for(let tries=0;tries<100;tries++){
    waiting=(await pool!.query('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[writerPid])).rows[0].waiting;
    if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(waiting).toBe(true);
   // UPDATE/DELETE already holds its tuple here. Proof must read under the
   // advisory lock without trying to lock that tuple and deadlocking.
   await reader.query("SET LOCAL statement_timeout='1000ms'");
   await assertQuotaProof(reader,admission,request,fence,connection,'model-a');await reader.query('COMMIT');
   expect(await pending).toEqual({ok:true});await writer.query('COMMIT');
   await expect(transaction(pool!,tx=>assertQuotaProof(tx,admission,request,fence,connection,'model-a'))).rejects.toMatchObject({code:'quota_admission_invalid'});
  }finally{
   await reader.query('ROLLBACK');await writer.query('ROLLBACK');reader.release();writer.release();
   await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE id=$1",[request]);
  }
 });
});
