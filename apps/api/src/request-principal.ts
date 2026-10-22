import type {FastifyRequest} from 'fastify';
import {authenticate, type Principal} from '../../../packages/auth/src/index.js';
import {DomainError,hash,id} from '../../../packages/contracts/src/index.js';
import {EXTERNAL_IDENTITY_HEADER} from '../../../packages/contracts/external-identity.js';
import {isViewerApiRead} from '../../../packages/contracts/admin-access.js';
import {transaction,type Tx} from '../../../packages/db/src/index.js';
import type pg from 'pg';
import {setAuditIdentity} from '../../../packages/db/src/identity.js';
const requestPrincipals=new WeakMap<Tx,Principal>();

/** Request identity is revalidated, including on SSE polls; audit context is transaction-local. */
export async function authenticateRequest(tx:Tx,request:FastifyRequest,{audit=true}:{audit?:boolean}={}):Promise<Principal>{
 const principal=await authenticate(tx,request.headers.authorization,request.headers[EXTERNAL_IDENTITY_HEADER]);
 const route=request.routeOptions.url??'';
 if(principal.identity?.kind==='user'&&route.startsWith('/v1/admin/'))
  throw new DomainError('scope_denied','Staff access required',403);
 if(principal.identity?.kind==='staff'&&principal.identity.role==='viewer'&&!isViewerApiRead(request.method,route))
  throw new DomainError('scope_denied','This action is unavailable to a viewer',403);
 if(audit){requestPrincipals.set(tx,principal);await setAuditIdentity(tx,{
  service_principal_id:principal.id,organization_id:principal.organization_id,application_id:principal.application_id,
  ...(principal.identity?{user_id:principal.identity.user_id}:{}),
  ...(principal.identity?.kind==='user'?{account_id:principal.identity.account_id}:{}),
 });}
 return principal;
}

/** Audit successful external commands atomically; logical replays preserve their first actor. */
export function requestTransaction<T>(pool:pg.Pool,request:FastifyRequest,run:(tx:Tx)=>Promise<T>):Promise<T>{
 return transaction(pool,async tx=>{
  try{
   const result=await run(tx),principal=requestPrincipals.get(tx);
   if(principal?.identity&&request.method!=='GET'&&request.method!=='HEAD'){
    const route=request.routeOptions.url??request.url.split('?')[0];
    const value=result&&typeof result==='object'?result as Record<string,unknown>:{};
    const params=request.params as Record<string,unknown>;
    const resource=params?.id??value.operation_id??value.request_id??value.id??value.version_id??value.transaction_id??value.grant_id??value.deletion_id??'installation';
    const key=request.headers['idempotency-key'];
    const auditId=typeof key==='string'?'audit_'+hash([principal.organization_id,principal.application_id,request.method,route,key,params??{},request.headers['if-match']??null,request.body??null]):id('audit');
    const body=request.body&&typeof request.body==='object'?request.body as Record<string,unknown>:{};
    const reason=typeof body.reason==='string'?body.reason.slice(0,1000):'Authorized external command';
    await tx.query('INSERT INTO audit_events(id,organization_id,application_id,actor_id,action,resource_id,reason,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',
     [auditId,principal.organization_id,principal.application_id,principal.id,`${request.method} ${route}`,String(resource),reason,{source:'external_identity'}]);
   }
   return result;
  }finally{requestPrincipals.delete(tx)}
 });
}
