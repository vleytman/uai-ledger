import {DomainError,systemClock,type Clock} from '../../contracts/src/index.js';
import type {SqlExecutor,Tx} from '../../db/src/index.js';
import {audit,type Actor,type OperationsScope} from '../../reconciliation/src/connections.js';
import {queueKinds,type QueueKind} from './transport.js';
export interface DispatchPolicySettings {interactive_reserve?:number;account_limit:number;application_limit:number;queue_limit:number;active_account_limit?:number;active_application_limit?:number;active_queue_limit?:number}
export async function listDispatchPolicies(db:SqlExecutor){return (await db.query('SELECT * FROM execution_dispatch_policies ORDER BY queue_kind')).rows;}
export async function getDispatchPolicy(db:SqlExecutor,kind:string){
 if(!queueKinds.includes(kind as QueueKind))throw new DomainError('not_found','Queue not found',404);
 const row=(await db.query('SELECT * FROM execution_dispatch_policies WHERE queue_kind=$1',[kind])).rows[0];
 if(!row)throw new DomainError('not_found','Queue not found',404);return row;
}
/** Installation-wide settings. Caller must authorize the installation administrator and own the transaction. */
export async function updateDispatchPolicy(tx:Tx,scope:OperationsScope,kind:string,revision:number,settings:DispatchPolicySettings,actor:Actor,clock:Clock=systemClock){
 if(!Number.isSafeInteger(revision)||revision<1||!['account_limit','application_limit','queue_limit'].every(key=>{const n=settings[key as keyof DispatchPolicySettings];return typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=100000})||settings.account_limit>settings.application_limit||settings.application_limit>settings.queue_limit)throw new DomainError('invalid_input','Expected 1 <= account <= application <= queue <= 100000',422);
 if(!queueKinds.includes(kind as QueueKind))throw new DomainError('not_found','Queue not found',404);
 const previous=(await tx.query('SELECT * FROM execution_dispatch_policies WHERE queue_kind=$1 FOR UPDATE',[kind])).rows[0];
 if(!previous)throw new DomainError('not_found','Queue not found',404);
 if(previous.revision!==revision)throw new DomainError('revision_conflict','Queue policy changed; reload it before saving',409);
 const reserve=settings.interactive_reserve??previous.interactive_reserve;if(!Number.isSafeInteger(reserve)||reserve<0||reserve>100000)throw new DomainError('invalid_input','Invalid interactive reserve',422);
 const active={active_account_limit:settings.active_account_limit??previous.active_account_limit,active_application_limit:settings.active_application_limit??previous.active_application_limit,active_queue_limit:settings.active_queue_limit??previous.active_queue_limit};
 if(!Object.values(active).every(n=>Number.isSafeInteger(n)&&n>=1&&n<=100000)||active.active_account_limit>active.active_application_limit||active.active_application_limit>active.active_queue_limit)throw new DomainError('invalid_input','Expected active account <= application <= queue between 1 and 100000',422);
 if(['observe','maintenance'].includes(kind)&&Object.keys(active).some(key=>settings[key as keyof DispatchPolicySettings]!==undefined))throw new DomainError('invalid_input','Active execution limits apply only to generation queues',422);
 const row=(await tx.query('UPDATE execution_dispatch_policies SET account_limit=$2,application_limit=$3,queue_limit=$4,active_account_limit=$5,active_application_limit=$6,active_queue_limit=$7,interactive_reserve=$8,revision=revision+1 WHERE queue_kind=$1 RETURNING *',[kind,settings.account_limit,settings.application_limit,settings.queue_limit,active.active_account_limit,active.active_application_limit,active.active_queue_limit,reserve])).rows[0];
 const values=(p:any)=>({interactive_reserve:p.interactive_reserve,account_limit:p.account_limit,application_limit:p.application_limit,queue_limit:p.queue_limit,active_account_limit:p.active_account_limit,active_application_limit:p.active_application_limit,active_queue_limit:p.active_queue_limit,revision:p.revision});
 await audit(tx,scope,clock,actor,'dispatch.policy.updated',kind,{scope:'installation',before:values(previous),after:values(row)});
 return row;
}
