import {authenticateRequest,requestTransaction} from './request-principal.js';
import {quotaBindingSnapshot,updateQuotaBindings} from '../../../packages/queue/src/quota-bindings.js';
import {createQuotaGroup} from '../../../packages/queue/src/quota-create.js';
import {replaceQuotaRules,updateQuotaRuleLimits} from '../../../packages/queue/src/quota-rule-limits.js';
import {registerQuotaSnapshot} from './quota-snapshot.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {DomainError,type Clock} from '../../../packages/contracts/src/index.js';
import {type Tx} from '../../../packages/db/src/index.js';
import {requireScopes,command,type Principal} from '../../../packages/auth/src/index.js';
import {listQuotaSettings,updateQuotaSettings} from '../../../packages/queue/src/quota-settings.js';

export function registerQuotaSettings(app:FastifyInstance,pool:pg.Pool,clock:Clock){
 registerQuotaSnapshot(app,pool);
 const run=(request:FastifyRequest,write:boolean,fn:(tx:Tx,p:Principal)=>Promise<unknown>)=>requestTransaction(pool,request,async tx=>{
  const p=await authenticateRequest(tx,request);requireScopes(p,'operations:admin',...(write?['config:write']:[]));
  if(p.account_ids)throw new DomainError('scope_denied','Quota administrator required',403);
  return fn(tx,p);
 });
 app.get('/v1/admin/provider-quota-bindings',async request=>run(request,false,async(tx,p)=>{
  const query=apiSchemas.QuotaBindingsQuery.parse(request.query);
  return quotaBindingSnapshot(tx,p,query.connection_id,query.model);
 }));
 app.put('/v1/admin/provider-quota-bindings',async request=>run(request,true,async(tx,p)=>{
  const body=apiSchemas.AdminQuotaBindingsBody.parse(request.body);
  await command(tx,p,'quota-bindings:update',apiSchemas.IdempotencyKey.parse(request.headers['idempotency-key']),body,async()=>{await updateQuotaBindings(tx,p,clock,body.connection_id,body.model,body.bindings_revision,body.group_ids,{actor_id:p.id,reason:body.reason});return {connection_id:body.connection_id,model:body.model}});
  return quotaBindingSnapshot(tx,p,body.connection_id,body.model);
 }));
 app.post('/v1/admin/provider-quotas',async request=>run(request,true,async(tx,p)=>{
  const body=apiSchemas.AdminQuotaCreateBody.parse(request.body);
  const result=await command(tx,p,'quota-group:create',apiSchemas.IdempotencyKey.parse(request.headers['idempotency-key']),body,async()=>({group_id:await createQuotaGroup(tx,p,clock,body.group,{actor_id:p.id,reason:body.reason})}));
  return (await listQuotaSettings(tx,p,clock,result.group_id))[0];
 }));
 app.get('/v1/admin/provider-quotas',async request=>run(request,false,async(tx,p)=>({data:await listQuotaSettings(tx,p,clock)})));
 app.put('/v1/admin/provider-quotas/:id/rules',async request=>run(request,true,async(tx,p)=>{
  const groupId=apiSchemas.Identifier.parse((request.params as {id:string}).id),body=apiSchemas.AdminQuotaRulesBody.parse(request.body);
  await command(tx,p,'quota-rules:replace',apiSchemas.IdempotencyKey.parse(request.headers['idempotency-key']),{groupId,...body},async()=>{
   await replaceQuotaRules(tx,p,clock,groupId,body.rules_revision,body.rules,{actor_id:p.id,reason:body.reason});return {group_id:groupId};
  });
  return (await listQuotaSettings(tx,p,clock,groupId))[0];
 }));
 app.patch('/v1/admin/provider-quotas/:id/rules',async request=>run(request,true,async(tx,p)=>{
  const groupId=apiSchemas.Identifier.parse((request.params as {id:string}).id),body=apiSchemas.AdminQuotaRuleLimitsBody.parse(request.body);
  await command(tx,p,'quota-rules:update',apiSchemas.IdempotencyKey.parse(request.headers['idempotency-key']),{groupId,...body},async()=>{
   await updateQuotaRuleLimits(tx,p,clock,groupId,body.rules_revision,body.rules,{actor_id:p.id,reason:body.reason});return {group_id:groupId};
  });
  return (await listQuotaSettings(tx,p,clock,groupId))[0];
 }));
 app.patch('/v1/admin/provider-quotas/:id',async request=>run(request,true,async(tx,p)=>{
  const groupId=apiSchemas.Identifier.parse((request.params as {id:string}).id),body=apiSchemas.AdminQuotaSettingsBody.parse(request.body);
  await command(tx,p,'quota-settings:update',apiSchemas.IdempotencyKey.parse(request.headers['idempotency-key']),{groupId,...body},async()=>{
   await updateQuotaSettings(tx,p,clock,groupId,body.settings_revision,body.settings,{actor_id:p.id,reason:body.reason});return {group_id:groupId};
  });
  return (await listQuotaSettings(tx,p,clock,groupId))[0];
 }));
}
