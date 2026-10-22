import {DomainError,id,type Clock} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';
import {audit,type Actor,type OperationsScope} from '../../reconciliation/src/connections.js';
import type {QuotaSettings} from './quota-settings.js';

export interface QuotaRuleDefinition {key:string;metric:string;capacity:string;provider_capacity:string|null;window_ms:number}
export interface QuotaGroupDefinition extends QuotaSettings {provider:string;scope:Record<string,string>;coordination_domain:string|null;rules:QuotaRuleDefinition[]}
export function validateQuotaRuleDefinitions(rules:QuotaRuleDefinition[]){
 const positive=(value:string)=>/^[1-9]\d{0,15}$/.test(value)&&BigInt(value)<=9007199254740991n;
 if(!rules.length||rules.length>32||new Set(rules.map(rule=>rule.key)).size!==rules.length)throw new DomainError('invalid_input','Use 1–32 rules with distinct keys',422);
 for(const rule of rules){
  if(!rule.key.trim()||!['requests','tokens','input_tokens','output_tokens','images','audio_seconds','credits','pages','files','bytes'].includes(rule.metric)||!Number.isSafeInteger(rule.window_ms)||rule.window_ms<1||rule.window_ms>86400000||!positive(rule.capacity)||(rule.provider_capacity!==null&&(!positive(rule.provider_capacity)||BigInt(rule.capacity)>BigInt(rule.provider_capacity))))throw new DomainError('invalid_input','Invalid quota rule or local limit exceeds provider limit',422);
 }
}
/** New groups have no route bindings; creating one never changes an existing route's quota. */
export async function createQuotaGroup(tx:Tx,scope:OperationsScope,clock:Clock,definition:QuotaGroupDefinition,actor:Actor){
 validateQuotaRuleDefinitions(definition.rules);
 const groupId=id('quota');
 try{
  await tx.query(`INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,checked_at,concurrency_limit,coordination_domain,interactive_reserve)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[groupId,scope.organization_id,definition.name,definition.provider,definition.scope,id('epoch'),definition.source,definition.checked_at,definition.concurrency_limit,definition.coordination_domain,definition.interactive_reserve??1]);
 }catch(error){if((error as {code?:string}).code==='23505')throw new DomainError('quota_name_conflict','Quota group name is already used',409);throw error}
 for(const rule of definition.rules)await tx.query(`INSERT INTO provider_quota_rules(group_id,key,metric,capacity,provider_capacity,window_ms) VALUES($1,$2,$3,$4,$5,$6)`,[groupId,rule.key,rule.metric,rule.capacity,rule.provider_capacity,rule.window_ms]);
 await audit(tx,scope,clock,actor,'quota.group.created',groupId,{scope:'organization',after:{...definition,rules_revision:1,settings_revision:1}});
 return groupId;
}
