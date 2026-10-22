import type {Tx} from './index.js';

export interface AuditIdentityInput {
 service_principal_id:string;
 organization_id:string;
 application_id:string;
 user_id?:string;
 account_id?:string;
}
/** A durable snapshot. Null user means system/service execution, never a guessed human. */
export interface AuditIdentitySnapshot {
 version:1;
 organization_id:string;
 application_id:string;
 service_principal_id:string|null;
 user_id:string|null;
 account_id:string|null;
 external_team_id:string|null;
 operation_id:string|null;
}
/** Call only within the transaction performing the authorized action. */
export async function setAuditIdentity(tx:Tx,identity:AuditIdentityInput):Promise<void>{
 const value:AuditIdentityInput={service_principal_id:identity.service_principal_id,organization_id:identity.organization_id,application_id:identity.application_id};
 if(identity.user_id!==undefined)value.user_id=identity.user_id;
 if(identity.account_id!==undefined)value.account_id=identity.account_id;
 await tx.query("SELECT set_config('uai.audit_identity',$1,true)",[JSON.stringify(value)]);
 if(identity.account_id!==undefined)await setAuditAccount(tx,identity.account_id);
}
/** Bind a staff action to its resolved target. Outside an identity transaction this is a no-op. */
export async function setAuditAccount(tx:Tx,accountId:string):Promise<void>{
 await tx.query('SELECT uai_set_audit_account($1)',[accountId]);
}
