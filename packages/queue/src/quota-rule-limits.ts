import {DomainError,id,type Clock} from '../../contracts/src/index.js';
import {validateQuotaRuleDefinitions,type QuotaRuleDefinition} from './quota-create.js';
import type {Tx} from '../../db/src/index.js';
import {audit,type Actor,type OperationsScope} from '../../reconciliation/src/connections.js';

export interface QuotaRuleLimit {key:string;capacity:string;provider_capacity:string|null}
/** Structural changes cannot reinterpret facts still eligible for Redis recovery. */
export async function replaceQuotaRules(tx:Tx,scope:OperationsScope,clock:Clock,groupId:string,revision:number,rules:QuotaRuleDefinition[],actor:Actor){
 validateQuotaRuleDefinitions(rules);
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8192))',[groupId]);
 const group=(await tx.query('SELECT * FROM provider_quota_groups WHERE id=$1 AND organization_id=$2 FOR UPDATE',[groupId,scope.organization_id])).rows[0];
 if(!group)throw new DomainError('not_found','Quota group not found',404);
 if(group.revision!==revision)throw new DomainError('revision_conflict','Quota rules changed; reload before saving',409);
 const before=(await tx.query('SELECT key,metric,window_ms,capacity::text,provider_capacity::text FROM provider_quota_rules WHERE group_id=$1 ORDER BY key FOR UPDATE',[groupId])).rows;
 if(before.length===rules.length&&before.every(old=>rules.some(rule=>rule.key===old.key&&rule.metric===old.metric&&rule.window_ms===old.window_ms))){
  await updateQuotaRuleLimits(tx,scope,clock,groupId,revision,rules,actor);return;
 }
 // Recovery replays 25 hours of admissions, excess usage and provider headers.
 // Waiting only the old window would silently erase usage on a longer new window.
 const held=await tx.query(`SELECT 1 WHERE
  EXISTS(SELECT 1 FROM dispatch_admissions a JOIN execution_requests r ON r.id=a.request_id
   WHERE a.group_id=$1 AND a.unused_at IS NULL AND a.state<>'rejected' AND
    (a.state='intent' OR a.created_at>now()-interval '25 hours' OR a.admitted_at>now()-interval '25 hours'
     OR (a.slot_released_at IS NULL AND a.slot_expires_at>now()) OR r.settlement_status<>'settled'))
  OR EXISTS(SELECT 1 FROM quota_usage_adjustments WHERE group_id=$1 AND (observed_at>now()-interval '25 hours' OR applied_at IS NULL))
  OR EXISTS(SELECT 1 FROM quota_observations WHERE group_id=$1 AND (received_at>now()-interval '25 hours' OR applied_at IS NULL))
  OR EXISTS(SELECT 1 FROM quota_result_feedback f JOIN dispatch_admissions a ON a.request_id=f.request_id
   WHERE a.group_id=$1 AND f.applied_at IS NULL)
  OR EXISTS(SELECT 1 FROM provider_quota_groups WHERE id=$1 AND blocked_until>now())`,[groupId]);
 if(held.rowCount)throw new DomainError('quota_rules_usage_active','Structural rule changes require no pending calls or feedback and no quota activity in the last 25 hours; capacity limits can be edited immediately',409);
 await tx.query('DELETE FROM provider_quota_rules WHERE group_id=$1',[groupId]);
 for(const rule of rules)await tx.query('INSERT INTO provider_quota_rules(group_id,key,metric,capacity,provider_capacity,window_ms) VALUES($1,$2,$3,$4,$5,$6)',[groupId,rule.key,rule.metric,rule.capacity,rule.provider_capacity,rule.window_ms]);
 await tx.query('UPDATE provider_quota_groups SET revision=revision+1,recovery_epoch=$2 WHERE id=$1',[groupId,id('epoch')]);
 await audit(tx,scope,clock,actor,'quota.rules.replaced',groupId,{before:{rules_revision:revision,rules:before},after:{rules_revision:revision+1,rules}});
}
/** Capacity edits retain event keys, windows, admission history and Redis recovery epoch. */
export async function updateQuotaRuleLimits(tx:Tx,scope:OperationsScope,clock:Clock,groupId:string,revision:number,limits:QuotaRuleLimit[],actor:Actor){
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8192))',[groupId]);
 const group=(await tx.query('SELECT * FROM provider_quota_groups WHERE id=$1 AND organization_id=$2 FOR UPDATE',[groupId,scope.organization_id])).rows[0];
 if(!group)throw new DomainError('not_found','Quota group not found',404);
 if(group.revision!==revision)throw new DomainError('revision_conflict','Quota rules changed; reload before saving',409);
 const before=(await tx.query('SELECT key,metric,window_ms,capacity::text,provider_capacity::text FROM provider_quota_rules WHERE group_id=$1 ORDER BY key FOR UPDATE',[groupId])).rows;
 const sorted=[...limits].sort((a,b)=>a.key.localeCompare(b.key));
 if(!before.length||before.length!==limits.length||new Set(limits.map(r=>r.key)).size!==limits.length||before.some(r=>!limits.some(l=>l.key===r.key)))throw new DomainError('quota_rules_mismatch','Supply every existing rule exactly once',422);
 for(const limit of sorted){
  const valid=(n:string)=>/^[1-9]\d{0,15}$/.test(n)&&BigInt(n)<=9007199254740991n;
  if(!valid(limit.capacity)||(limit.provider_capacity!==null&&(!valid(limit.provider_capacity)||BigInt(limit.capacity)>BigInt(limit.provider_capacity))))throw new DomainError('invalid_input','Local quota must be positive and no greater than the known provider quota',422);
  await tx.query('UPDATE provider_quota_rules SET capacity=$3,provider_capacity=$4 WHERE group_id=$1 AND key=$2',[groupId,limit.key,limit.capacity,limit.provider_capacity]);
 }
 await tx.query('UPDATE provider_quota_groups SET revision=revision+1 WHERE id=$1',[groupId]);
 await audit(tx,scope,clock,actor,'quota.rules.updated',groupId,{before:{rules_revision:revision,rules:before},after:{rules_revision:revision+1,rules:before.map(rule=>({...rule,...limits.find(limit=>limit.key===rule.key)}))}});
}
