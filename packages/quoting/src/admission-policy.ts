import {DomainError,systemClock,type Clock} from '../../contracts/src/index.js';
import type {SqlExecutor,Tx} from '../../db/src/index.js';
import {audit,type Actor,type OperationsScope} from '../../reconciliation/src/connections.js';
export const defaultAdmissionLimits={account_limit:20,application_limit:200,max_queue_age_ms:900000} as const;
export interface AdmissionLimits {account_limit:number;application_limit:number;max_queue_age_ms:number}
export async function getAdmissionPolicy(db:SqlExecutor,scope:OperationsScope){
 const row=(await db.query('SELECT * FROM execution_admission_policies WHERE organization_id=$1 AND application_id=$2',[scope.organization_id,scope.application_id])).rows[0];
 return row?{...row,enabled:true}:{organization_id:scope.organization_id,application_id:scope.application_id,...defaultAdmissionLimits,revision:0,enabled:false};
}
export async function updateAdmissionPolicy(tx:Tx,scope:OperationsScope,revision:number,limits:AdmissionLimits,actor:Actor,clock:Clock=systemClock){
 if(!Number.isSafeInteger(revision)||revision<0||!Object.values(limits).every(Number.isSafeInteger)||limits.account_limit<1||limits.account_limit>100000||limits.application_limit<limits.account_limit||limits.application_limit>1000000||limits.max_queue_age_ms<1000||limits.max_queue_age_ms>86400000)throw new DomainError('invalid_input','Invalid admission limits',422);
 // UPDATE revision and insert-on-conflict enforce the same CAS for first activation.
 const locked=(await tx.query('SELECT * FROM execution_admission_policies WHERE organization_id=$1 AND application_id=$2 FOR UPDATE',[scope.organization_id,scope.application_id])).rows[0];
 const before=locked?{...locked,enabled:true}:{organization_id:scope.organization_id,application_id:scope.application_id,...defaultAdmissionLimits,revision:0,enabled:false};
 if(before.revision!==revision)throw new DomainError('revision_conflict','Admission limits changed; reload before saving',409);
 const params=[scope.organization_id,scope.application_id,limits.account_limit,limits.application_limit,limits.max_queue_age_ms];
 const result=revision===0?await tx.query(`INSERT INTO execution_admission_policies(organization_id,application_id,account_limit,application_limit,max_queue_age_ms)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,params):await tx.query(`UPDATE execution_admission_policies SET account_limit=$3,application_limit=$4,max_queue_age_ms=$5,revision=revision+1
  WHERE organization_id=$1 AND application_id=$2 AND revision=$6 RETURNING *`,[...params,revision]);
 if(!result.rowCount)throw new DomainError('revision_conflict','Admission limits changed; reload before saving',409);
 const after={...result.rows[0],enabled:true};
 await audit(tx,scope,clock,actor,'admission.policy.updated',scope.application_id,{before,after});
 return after;
}
