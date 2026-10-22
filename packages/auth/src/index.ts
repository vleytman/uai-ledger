import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { DomainError, hash, id, type Scope } from '../../contracts/src/index.js';
import { decodeExternalIdentity, type ExternalIdentity } from '../../contracts/external-identity.js';
import { setAuditAccount } from '../../db/src/identity.js';
import type { Tx } from '../../db/src/index.js';
export interface Principal {
 id: string; organization_id: string; application_id: string; account_ids: string[] | null;
 scopes: string[]; max_grant_units: string | null; identity?: ExternalIdentity;
}
export async function authenticate(tx: Tx, authorization?: string, externalHeader?: string | string[]): Promise<Principal> {
 const token=authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
 if(!token) throw new DomainError('unauthenticated','Service token required',401);
 const digest=createHash('sha256').update(token).digest('hex');
 const row=(await tx.query('SELECT * FROM service_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())',[digest])).rows[0];
 if(!row) throw new DomainError('unauthenticated','Invalid or expired token',401);
 const principal:Principal={id:row.id,organization_id:row.organization_id,application_id:row.application_id,account_ids:row.account_ids,scopes:row.scopes,max_grant_units:row.max_grant_units};
 if(externalHeader !== undefined) {
  let identity:ExternalIdentity;
  try { if(Array.isArray(externalHeader)) throw new Error('Duplicate identity header'); identity=decodeExternalIdentity(externalHeader); }
  catch { throw new DomainError('invalid_identity','Invalid external identity context',400); }
  requireScopes(principal,'identity:assert');
  if(identity.kind==='user') {
   await accountScope(tx,principal,identity.account_id);
   principal.account_ids=[identity.account_id];
  }
  principal.identity=identity;
 }
 return principal;
}
export function requireScopes(principal: Principal,...required:string[]) {
 const identity=principal.identity;
 const viewerReads=new Set(['ai:read','wallets:read','operations:admin','identity:assert']);
 if(identity?.kind==='user' && required.some(scope=>scope==='accounts:write'||scope==='accounts:spending'||scope.startsWith('credits:')||scope==='config:write'||scope==='operations:admin')) throw new DomainError('scope_denied','User identity cannot perform administrative actions',403);
 if(identity?.kind==='staff' && identity.role==='viewer' && required.some(scope=>!viewerReads.has(scope))) throw new DomainError('scope_denied','Viewer identity cannot perform this action',403);
 requireServiceScopes(principal,...required);
}
/** Check the service credential ceiling after the caller separately authorizes the action/role. */
export function requireServiceScopes(principal:Principal,...required:string[]) {
 if(required.some(s=>!principal.scopes.includes(s))) throw new DomainError('scope_denied','Required scope unavailable',403);
}
export async function accountScope(tx: Tx, principal: Principal, accountId: string): Promise<Scope> {
 if(principal.account_ids && !principal.account_ids.includes(accountId)) throw new DomainError('not_found','Resource not found',404);
 const found=await tx.query('SELECT id FROM accounts WHERE id=$1 AND organization_id=$2 AND application_id=$3',[accountId,principal.organization_id,principal.application_id]);
 if(!found.rows.length) throw new DomainError('not_found','Resource not found',404);
 await setAuditAccount(tx,accountId);
 return {organization_id:principal.organization_id,application_id:principal.application_id,account_id:accountId};
}
export async function issueToken(tx:Tx,input:Omit<Principal,'id'|'identity'> & {expires_at:string|null}):Promise<{principal:Principal;token:string}> {
 const token=randomBytes(32).toString('base64url'), tokenId=id('principal');
 await tx.query('INSERT INTO service_tokens(id,organization_id,application_id,account_ids,scopes,max_grant_units,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[tokenId,input.organization_id,input.application_id,input.account_ids,input.scopes,input.max_grant_units,createHash('sha256').update(token).digest('hex'),input.expires_at]);
 return {principal:{id:tokenId,...input},token};
}
export function constantTimeEqual(a:string,b:string) { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y); }
/** Stores references only. Replays must read current resources, never cached content. */
export async function command<T extends Record<string,string>>(tx:Tx,principal:Principal,endpoint:string,key:string,input:unknown,execute:()=>Promise<T>):Promise<T> {
 if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new DomainError('invalid_input','Idempotency-Key is required',422);
 const identity=JSON.stringify([principal.organization_id,principal.application_id,endpoint,key]);
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[identity]);
 const inputHash=hash(input);
 const old=(await tx.query('SELECT input_hash,resource_refs FROM command_idempotency WHERE organization_id=$1 AND application_id=$2 AND command=$3 AND key=$4',[principal.organization_id,principal.application_id,endpoint,key])).rows[0];
 if(old) { if(old.input_hash!==inputHash) throw new DomainError('idempotency_conflict'); return old.resource_refs; }
 const refs=await execute();
 await tx.query('INSERT INTO command_idempotency(organization_id,application_id,command,key,input_hash,resource_refs) VALUES($1,$2,$3,$4,$5,$6)',[principal.organization_id,principal.application_id,endpoint,key,inputHash,refs]);
 return refs;
}
