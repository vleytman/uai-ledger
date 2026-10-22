import {DomainError,type Clock} from '../../contracts/src/index.js';
import type {SqlExecutor,Tx} from '../../db/src/index.js';
import {audit,type Actor,type OperationsScope} from '../../reconciliation/src/connections.js';

export interface QuotaSettings {interactive_reserve?:number;name:string;source:string;checked_at:string|null;concurrency_limit:number}
export async function listQuotaSettings(db:SqlExecutor,scope:OperationsScope,clock:Clock,groupId?:string){
 return (await db.query(`SELECT g.id,g.name,g.provider,g.scope,g.revision AS rules_revision,g.settings_revision,
  g.source,g.checked_at,g.concurrency_limit,g.interactive_reserve,g.slot_lease_ms,g.unknown_hold_ms,g.blocked_until,g.coordination_domain,
  (SELECT count(*)::int FROM dispatch_admissions a WHERE a.group_id=g.id AND a.slot_released_at IS NULL AND a.slot_expires_at>$3) AS held_slots,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('key',r.key,'metric',r.metric,'capacity',r.capacity::text,'provider_capacity',r.provider_capacity::text,'window_ms',r.window_ms) ORDER BY r.key) FROM provider_quota_rules r WHERE r.group_id=g.id),'[]'::jsonb) AS rules,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('connection_id',c.id,'connection_name',c.name,'model',b.model) ORDER BY c.name,b.model) FROM provider_quota_bindings b JOIN provider_connections c ON c.id=b.connection_id AND c.organization_id=g.organization_id WHERE b.group_id=g.id),'[]'::jsonb) AS bindings
 FROM provider_quota_groups g WHERE g.organization_id=$1 AND ($2::text IS NULL OR g.id=$2) ORDER BY g.name,g.id`,[scope.organization_id,groupId??null,clock.now()])).rows;
}
export async function updateQuotaSettings(tx:Tx,scope:OperationsScope,clock:Clock,groupId:string,revision:number,settings:QuotaSettings,actor:Actor){
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8192))',[groupId]);
 const before=(await tx.query('SELECT * FROM provider_quota_groups WHERE id=$1 AND organization_id=$2 FOR UPDATE',[groupId,scope.organization_id])).rows[0];
 if(!before)throw new DomainError('not_found','Quota group not found',404);
 if(before.settings_revision!==revision)throw new DomainError('revision_conflict','Quota settings changed; reload before saving',409);
 if(!Number.isSafeInteger(settings.concurrency_limit)||settings.concurrency_limit<1||settings.concurrency_limit>100000||!settings.name.trim()||!settings.source.trim())throw new DomainError('invalid_input','Invalid quota settings',422);
 const reserve=settings.interactive_reserve??before.interactive_reserve;if(!Number.isSafeInteger(reserve)||reserve<0||reserve>100000)throw new DomainError('invalid_input','Invalid interactive reserve',422);
 const duplicate=await tx.query('SELECT 1 FROM provider_quota_groups WHERE organization_id=$1 AND name=$2 AND id<>$3',[scope.organization_id,settings.name,groupId]);
 if(duplicate.rowCount)throw new DomainError('quota_name_conflict','Quota group name is already used',409);
 let after:any;
 try{after=(await tx.query(`UPDATE provider_quota_groups SET name=$2,source=$3,checked_at=$4,concurrency_limit=$5,interactive_reserve=$6,settings_revision=settings_revision+1 WHERE id=$1 RETURNING *`,[groupId,settings.name,settings.source,settings.checked_at,settings.concurrency_limit,reserve])).rows[0];}
 catch(error){if((error as {code?:string}).code==='23505')throw new DomainError('quota_name_conflict','Quota group name is already used',409);throw error}
 const values=(row:any)=>({interactive_reserve:row.interactive_reserve,name:row.name,source:row.source,checked_at:row.checked_at,concurrency_limit:row.concurrency_limit,settings_revision:row.settings_revision});
 await audit(tx,scope,clock,actor,'quota.settings.updated',groupId,{scope:'organization',before:values(before),after:values(after)});
}
