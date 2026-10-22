import type pg from 'pg';
import {hash,type Scope} from '../../contracts/src/index.js';
import type {ProviderResult} from '../../providers/src/contracts.js';
import {validLimitUsage} from '../../providers/src/limit-usage.js';
type Handler=(scope:Scope,request:any,attempt:any,result:ProviderResult)=>Promise<void>;
/** Only quota metadata is journaled. This is never a source for output or financial settlement. */
export async function deliverQuotaFeedback(pool:pg.Pool,handler:Handler|undefined,scope:Scope,request:any,attempt:any,result:ProviderResult){
 if(!handler)return;
 if(!attempt.quota_admission_id){await handler(scope,request,attempt,result);return}
 const metadata:ProviderResult=result.outcome==='success'
  ?{outcome:'success',output:{content_type:'application/octet-stream'},usage:{state:'unknown',reason:'quota_metadata_only'}}
  :result.outcome==='refused'?{outcome:'refused',refusal:'',failure:result.failure,usage:{state:'unknown',reason:'quota_metadata_only'}}:{outcome:result.outcome,failure:result.failure,usage:{state:'unknown',reason:'quota_metadata_only'}};
 const counters=validLimitUsage(result.limit_usage);
 if(counters)metadata.limit_usage=counters;
 const key=`qfeedback-${hash([attempt.id,metadata])}`;
 await pool.query('INSERT INTO quota_result_feedback(id,request_id,attempt_id,result) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[key,request.id,attempt.id,metadata]);
 const row=(await pool.query('SELECT * FROM quota_result_feedback WHERE id=$1',[key])).rows[0];
 if(row.applied_at)return;
 try{await handler(scope,request,{...attempt,quota_observed_at:row.observed_at},result);await pool.query('UPDATE quota_result_feedback SET applied_at=now() WHERE id=$1',[key])}
 catch{console.error('quota_result_observation_failed')}
}
export async function replayQuotaFeedback(pool:pg.Pool,handler:Handler){
 const rows=(await pool.query(`UPDATE quota_result_feedback SET retry_at=now()+interval '30 seconds'
  WHERE id IN (SELECT id FROM quota_result_feedback WHERE applied_at IS NULL AND retry_at<=now()
   ORDER BY retry_at,id LIMIT 32 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows;
 for(const row of rows)try{
  const request=(await pool.query('SELECT * FROM execution_requests WHERE id=$1',[row.request_id])).rows[0];
  const attempt=(await pool.query('SELECT * FROM execution_attempts WHERE id=$1',[row.attempt_id])).rows[0];
  const scope={organization_id:request.organization_id,application_id:request.application_id,account_id:request.account_id};
  await handler(scope,request,{...attempt,quota_observed_at:row.observed_at},row.result);
  await pool.query('UPDATE quota_result_feedback SET applied_at=now() WHERE id=$1',[row.id]);
 }catch{console.error('quota_result_replay_failed')}
 return rows.length;
}
