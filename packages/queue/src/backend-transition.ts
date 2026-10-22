import {DomainError,type Clock,type Scope} from '../../contracts/src/index.js';
import {emit,type SqlExecutor,type Tx} from '../../db/src/index.js';
import {lockExecutionAccount} from '../../db/src/execution-lock.js';
import {releaseUnusedAdmissions} from '../../execution/src/index.js';
import {audit,type Actor} from '../../reconciliation/src/connections.js';

export type ExecutionBackend='legacy'|'bullmq';
export interface BackendTransition {request_id:string;from:ExecutionBackend;to:ExecutionBackend;generation:number}
function validate(input:BackendTransition){
 if(!['legacy','bullmq'].includes(input.from)||!['legacy','bullmq'].includes(input.to)||input.from===input.to||!Number.isSafeInteger(input.generation)||input.generation<0)throw new DomainError('invalid_backend_transition','Choose distinct backends and the current generation',422);
}
function blocked(row:any,clock:Clock):string|null{
 if(row.attempt_count!==0||row.has_attempt||row.first_dispatched_at)return 'request_already_attempted';
 if(!['queued','waiting_retry','waiting_recovery','paused'].includes(row.execution_status)||row.lease_owner||row.lease_expires_at)return 'request_not_waiting';
 if(row.cancel_requested_at||row.financial_closed_at||row.settlement_status==='settled')return 'request_closed';
 if(new Date(row.deadline_at)<=clock.now())return 'request_expired';
 return null;
}
async function read(db:SqlExecutor,scope:Scope,requestId:string,lock=false){
 const row=(await db.query(`SELECT r.*,EXISTS(SELECT 1 FROM execution_attempts a WHERE a.request_id=r.id) AS has_attempt
  FROM execution_requests r WHERE r.id=$1 AND r.organization_id=$2 AND r.application_id=$3 AND r.account_id=$4${lock?' FOR UPDATE OF r':''}`,[requestId,scope.organization_id,scope.application_id,scope.account_id])).rows[0];
 if(!row)throw new DomainError('not_found','Request not found',404);return row;
}
/** Preview is advisory only. Applying always rechecks under the account/request barriers. */
export async function previewBackendTransition(db:SqlExecutor,scope:Scope,clock:Clock,requestId:string){
 const row=await read(db,scope,requestId),reason=blocked(row,clock);
 return {request_id:row.id,backend:row.execution_backend as ExecutionBackend,generation:row.dispatch_generation as number,status:row.execution_status as string,eligible:reason===null,reason};
}
/** Transfers never-attempted work only; active/unknown/retry-after-send stays with its original executor. */
export async function transitionRequestBackend(tx:Tx,scope:Scope,clock:Clock,input:BackendTransition,actor:Actor){
 validate(input);await lockExecutionAccount(tx,scope);
 const row=await read(tx,scope,input.request_id,true);
 if(row.execution_backend!==input.from||row.dispatch_generation!==input.generation)throw new DomainError('revision_conflict','Backend or generation changed; preview again',409);
 const reason=blocked(row,clock);if(reason)throw new DomainError('backend_transition_unsafe',reason,409);
 // Invalidate old transport messages and quota intents in the same PostgreSQL commit.
 // An in-flight Redis reply cannot regain permission with the old request fence.
 await releaseUnusedAdmissions(tx,row,clock);
 const generation=row.dispatch_generation+1;
 await tx.query('UPDATE execution_requests SET execution_backend=$2,dispatch_generation=$3,fencing_token=fencing_token+1 WHERE id=$1',[row.id,input.to,generation]);
 if(input.to==='bullmq')await tx.query('INSERT INTO execution_dispatches(request_id,generation,queue_kind,due_at) VALUES($1,$2,$3,$4)',[row.id,generation,row.queue_kind,row.not_before]);
 const result={request_id:row.id,backend:input.to,generation};
 await audit(tx,scope,clock,actor,'execution.backend.transferred',row.id,{before:{backend:input.from,generation:input.generation},after:{backend:input.to,generation}});
 await emit(tx,scope,'request.backend_changed',{type:'request',id:row.id},{from:input.from,to:input.to,generation});
 return result;
}
