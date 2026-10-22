import {authenticateRequest,requestTransaction} from './request-principal.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {DomainError,type Clock} from '../../../packages/contracts/src/index.js';
import {type Tx} from '../../../packages/db/src/index.js';
import {requireScopes,command,type Principal} from '../../../packages/auth/src/index.js';
import {listDispatchPolicies,getDispatchPolicy,updateDispatchPolicy} from '../../../packages/queue/src/policies.js';
export function registerDispatchPolicies(app:FastifyInstance,pool:pg.Pool,clock:Clock){
 const run=(request:FastifyRequest,write:boolean,fn:(tx:Tx,p:Principal)=>Promise<unknown>)=>requestTransaction(pool,request,async tx=>{
  const p=await authenticateRequest(tx,request);requireScopes(p,'operations:admin',...(write?['config:write']:[]));
  if(p.account_ids)throw new DomainError('scope_denied','Installation administrator required',403);
  return fn(tx,p);
 });
 app.get('/v1/admin/dispatch-policies',async request=>run(request,false,async tx=>({data:await listDispatchPolicies(tx)})));
 app.patch('/v1/admin/dispatch-policies/:kind',async request=>run(request,true,async(tx,p)=>{
  const kind=apiSchemas.DispatchQueueKind.parse((request.params as {kind:string}).kind),body=apiSchemas.AdminDispatchPolicyBody.parse(request.body);
  await command(tx,p,'dispatch-policy:update',apiSchemas.IdempotencyKey.parse(request.headers['idempotency-key']),{kind,...body},async()=>{
   await updateDispatchPolicy(tx,p,kind,body.revision,body.settings,{actor_id:p.id,reason:body.reason},clock);
   return {queue_kind:kind};
  });
  return getDispatchPolicy(tx,kind);
 }));
}
