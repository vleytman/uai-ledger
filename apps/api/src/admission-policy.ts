import {authenticateRequest,requestTransaction} from './request-principal.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {DomainError,type Clock} from '../../../packages/contracts/src/index.js';
import {type Tx} from '../../../packages/db/src/index.js';
import {requireScopes,command,type Principal} from '../../../packages/auth/src/index.js';
import {getAdmissionPolicy,updateAdmissionPolicy} from '../../../packages/quoting/src/admission-policy.js';
export function registerAdmissionPolicy(app:FastifyInstance,pool:pg.Pool,clock:Clock){
 const run=(request:FastifyRequest,write:boolean,fn:(tx:Tx,p:Principal)=>Promise<unknown>)=>requestTransaction(pool,request,async tx=>{
  const principal=await authenticateRequest(tx,request);requireScopes(principal,'operations:admin',...(write?['config:write']:[]));
  if(principal.account_ids)throw new DomainError('scope_denied','Application administrator required',403);
  return fn(tx,principal);
 });
 app.get('/v1/admin/admission-policy',async request=>run(request,false,(tx,p)=>getAdmissionPolicy(tx,p)));
 app.patch('/v1/admin/admission-policy',async request=>run(request,true,async(tx,p)=>{
  const body=apiSchemas.AdminAdmissionPolicyBody.parse(request.body);
  await command(tx,p,'admission-policy:update',apiSchemas.IdempotencyKey.parse(request.headers['idempotency-key']),body,async()=>{
   await updateAdmissionPolicy(tx,p,body.revision,body.settings,{actor_id:p.id,reason:body.reason},clock);return {application_id:p.application_id};
  });
  return getAdmissionPolicy(tx,p);
 }));
}
