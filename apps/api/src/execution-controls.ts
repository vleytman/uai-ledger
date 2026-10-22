import {authenticateRequest,requestTransaction} from './request-principal.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {type Tx} from '../../../packages/db/src/index.js';
import {requireScopes,command,type Principal} from '../../../packages/auth/src/index.js';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {DomainError,hash,type Clock} from '../../../packages/contracts/src/index.js';
import {configureBudget,configureLimiter} from '../../../packages/execution/src/index.js';
import {audit} from '../../../packages/reconciliation/src/connections.js';

// Counter keys are organization-wide. An application administrator may manage only exclusively owned keys.
// Draft references never grant access; shared-key administration needs an organization-level authority.
const budgetScope=`((b.kind='provider' AND EXISTS(SELECT 1 FROM provider_connections c WHERE c.id=b.budget_key AND c.organization_id=$1 AND c.application_id=$2)) OR (b.kind='period' AND EXISTS(SELECT 1 FROM recipe_versions r WHERE r.organization_id=$1 AND r.application_id=$2 AND r.definition->>'period_budget_key'=b.budget_key) AND NOT EXISTS(SELECT 1 FROM recipe_versions other WHERE other.organization_id=$1 AND other.application_id<>$2 AND other.definition->>'period_budget_key'=b.budget_key)))`;
const limiterScope=`(EXISTS(SELECT 1 FROM configuration_versions c WHERE c.organization_id=$1 AND c.application_id=$2 AND c.kind='route' AND c.status='published' AND (c.payload->'primary'->>'limiter_key'=l.limiter_key OR c.payload->'fallback'->>'limiter_key'=l.limiter_key)) AND NOT EXISTS(SELECT 1 FROM configuration_versions other WHERE other.organization_id=$1 AND other.application_id<>$2 AND other.kind='route' AND other.status='published' AND (other.payload->'primary'->>'limiter_key'=l.limiter_key OR other.payload->'fallback'->>'limiter_key'=l.limiter_key)))`;
const configHash=(row:any)=>hash({interactive_reserve:row.interactive_reserve,window_ms:row.window_ms,request_limit:row.request_limit,token_limit:row.token_limit,concurrency_limit:row.concurrency_limit});
export function registerExecutionControls(app:FastifyInstance,pool:pg.Pool,clock:Clock){
 const run=(r:FastifyRequest,fn:(tx:Tx,p:Principal)=>Promise<unknown>)=>requestTransaction(pool,r,async tx=>{
  const p=await authenticateRequest(tx,r);requireScopes(p,'operations:admin');if(p.account_ids)throw new DomainError('scope_denied','Installation administrator required',403);
  if(r.method!=='GET')requireScopes(p,'config:write');return fn(tx,p);
 });
 app.get('/v1/admin/execution-budgets',r=>run(r,async(tx,p)=>({data:(await tx.query(`SELECT b.* FROM execution_budgets b WHERE b.organization_id=$1 AND ${budgetScope} ORDER BY b.kind,b.budget_key`,[p.organization_id,p.application_id])).rows})));
 app.post('/v1/admin/execution-budgets',r=>run(r,async(tx,p)=>{
  const b=apiSchemas.AdminBudgetBody.parse(r.body),key=apiSchemas.IdempotencyKey.parse(r.headers['idempotency-key']);
  const scoped=(await tx.query(`SELECT 1 FROM (SELECT $3::text kind,$4::text budget_key) b WHERE ${budgetScope}`,[p.organization_id,p.application_id,b.kind,b.budget_key])).rows[0];
  if(!scoped)throw new DomainError('not_found','Budget key must belong exclusively to this application',404);
  await command(tx,p,'execution-budget.update',key,b,async()=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.organization_id}:budget:${b.kind}:${b.budget_key}`]);
   const old=(await tx.query('SELECT * FROM execution_budgets WHERE organization_id=$1 AND kind=$2 AND budget_key=$3 FOR UPDATE',[p.organization_id,b.kind,b.budget_key])).rows[0];
   if((old?.limit_units??null)!==b.expected_limit_units)throw new DomainError('revision_conflict','Budget changed; refresh before editing',409);
   await configureBudget(tx,{...p,account_id:'system'},b.kind,b.budget_key,b.limit_units);
   await audit(tx,p,clock,{actor_id:p.id,reason:b.reason},'execution_budget.updated',b.budget_key,{kind:b.kind,before_units:old?.limit_units??null,after_units:b.limit_units});
   return {budget_key:b.budget_key};
  });
  return (await tx.query('SELECT * FROM execution_budgets WHERE organization_id=$1 AND kind=$2 AND budget_key=$3',[p.organization_id,b.kind,b.budget_key])).rows[0];
 }));
 app.get('/v1/admin/execution-limiters',r=>run(r,async(tx,p)=>({data:(await tx.query(`SELECT l.* FROM execution_limiters l WHERE l.organization_id=$1 AND ${limiterScope} ORDER BY l.limiter_key`,[p.organization_id,p.application_id])).rows.map(row=>({...row,config_hash:configHash(row)}))})));
 app.post('/v1/admin/execution-limiters',r=>run(r,async(tx,p)=>{
  const b=apiSchemas.AdminLimiterBody.parse(r.body),key=apiSchemas.IdempotencyKey.parse(r.headers['idempotency-key']);
  const scoped=(await tx.query(`SELECT 1 FROM (SELECT $3::text limiter_key) l WHERE ${limiterScope}`,[p.organization_id,p.application_id,b.key])).rows[0];if(!scoped)throw new DomainError('not_found','Limiter must belong exclusively to published routes of this application',404);
  await command(tx,p,'execution-limiter.update',key,b,async()=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.organization_id}:limiter:${b.key}`]);
   const old=(await tx.query('SELECT * FROM execution_limiters WHERE organization_id=$1 AND limiter_key=$2 FOR UPDATE',[p.organization_id,b.key])).rows[0];
   if((old?configHash(old):null)!==b.expected_config_hash)throw new DomainError('revision_conflict','Limiter changed; refresh before editing',409);
   await configureLimiter(tx,{...p,account_id:'system'},clock,b);
   await audit(tx,p,clock,{actor_id:p.id,reason:b.reason},'execution_limiter.updated',b.key,{interactive_reserve:b.interactive_reserve??old?.interactive_reserve??1,window_ms:b.window_ms,request_limit:b.request_limit,token_limit:b.token_limit,concurrency_limit:b.concurrency_limit});return {limiter_key:b.key};
  });
  const row=(await tx.query('SELECT * FROM execution_limiters WHERE organization_id=$1 AND limiter_key=$2',[p.organization_id,b.key])).rows[0];return {...row,config_hash:configHash(row)};
 }));
}
