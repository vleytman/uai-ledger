import {DomainError,hash,systemClock,type Clock} from '../../contracts/src/index.js';
import type {SqlExecutor} from '../../db/src/index.js';
import {ConnectionService,CredentialVault,audit,type Actor,type OperationsScope} from './connections.js';
/** Separate admin reporting key: never reused as an inference credential. Mutations require Tx. */
export class ReportingCredentialService {
 constructor(private db:SqlExecutor,private clock:Clock=systemClock,private vault?:CredentialVault){}
 async metadata(scope:OperationsScope,connectionId:string){const c=await new ConnectionService(this.db,this.clock).get(scope,connectionId);const row=(await this.db.query('SELECT revision,credential_scope,created_at FROM provider_reporting_credentials WHERE connection_id=$1 AND revision=$2',[c.id,c.reporting_credential_revision])).rows[0];return {connection_id:c.id,status:row?'configured':'missing',...(row??{})};}
 async rotate(scope:OperationsScope,connectionId:string,revision:number,secret:string,credentialScope:Record<string,string>,actor:Actor){
  if(!this.vault)throw new DomainError('vault_not_configured');if(typeof secret!=='string'||!secret||secret.length>16384)throw new DomainError('invalid_credential');
  const c=await new ConnectionService(this.db,this.clock).get(scope,connectionId);if(!['openai','anthropic'].includes(c.provider))throw new DomainError('reporting_unsupported');
  const keys=c.provider==='openai'?['organization_id','project_id','api_key_id']:['organization_id','workspace_id'];
  if(!credentialScope?.organization_id||Object.entries(credentialScope).some(([k,v])=>!keys.includes(k)||typeof v!=='string'||!v||v.length>200)||hash(c.account_scope)!==hash(credentialScope))throw new DomainError('report_scope_mismatch');
  const next=c.reporting_credential_revision+1;const encrypted=this.vault.encrypt(secret,`${scope.organization_id}:${scope.application_id}:${c.id}:reporting:${next}:${hash(credentialScope)}`);
  await audit(this.db,scope,this.clock,actor,'connection.reporting_credential_rotated',c.id,{reporting_credential_revision:next,credential_scope:credentialScope});
  const changed=(await this.db.query('UPDATE provider_connections SET reporting_credential_revision=$1,revision=revision+1,updated_at=$2 WHERE id=$3 AND organization_id=$4 AND application_id=$5 AND revision=$6 RETURNING *',[next,this.clock.now(),c.id,scope.organization_id,scope.application_id,revision])).rows[0];if(!changed)throw new DomainError('revision_conflict');
  await this.db.query('INSERT INTO provider_reporting_credentials(connection_id,revision,credential_scope,ciphertext,iv,tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,next,JSON.stringify(credentialScope),encrypted.ciphertext,encrypted.iv,encrypted.tag,this.clock.now()]);return changed;
 }
 /** Server-only capability. Call outside a long-running transaction before the network request. */
 async resolve(scope:OperationsScope,connectionId:string){
  if(!this.vault)throw new DomainError('vault_not_configured');const c=await new ConnectionService(this.db,this.clock).get(scope,connectionId);
  const row=(await this.db.query('SELECT * FROM provider_reporting_credentials WHERE connection_id=$1 AND revision=$2',[c.id,c.reporting_credential_revision])).rows[0];if(!row)throw new DomainError('reporting_credential_missing');if(hash(row.credential_scope)!==hash(c.account_scope))throw new DomainError('report_scope_mismatch');
  return {credential:this.vault.decrypt(row as any,`${scope.organization_id}:${scope.application_id}:${c.id}:reporting:${row.revision}:${hash(row.credential_scope)}`),credential_scope:row.credential_scope as Record<string,string>,revision:row.revision};
 }
}
