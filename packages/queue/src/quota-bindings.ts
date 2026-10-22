import {DomainError,hash,type Clock} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';
import {audit,type Actor,type OperationsScope} from '../../reconciliation/src/connections.js';

const revision=(connection:string,model:string,groups:string[])=>hash([connection,model,[...groups].sort()]);
export async function quotaBindingSnapshot(tx:Tx,scope:OperationsScope,connectionId:string,model:string){
 const connection=(await tx.query('SELECT id,name,provider FROM provider_connections WHERE id=$1 AND organization_id=$2 AND application_id=$3',[connectionId,scope.organization_id,scope.application_id])).rows[0];
 if(!connection)throw new DomainError('not_found','Connection not found',404);
 const groups=(await tx.query(`SELECT g.id,g.name,g.provider,g.coordination_domain FROM provider_quota_bindings b JOIN provider_quota_groups g ON g.id=b.group_id
  WHERE b.connection_id=$1 AND b.model=$2 AND g.organization_id=$3 ORDER BY g.id`,[connectionId,model,scope.organization_id])).rows;
 return {connection_id:connectionId,connection_name:connection.name,provider:connection.provider,model,bindings_revision:revision(connectionId,model,groups.map(g=>g.id)),groups};
}
/** The same route lock fences mutation against final pre-submission quota proof. */
export async function updateQuotaBindings(tx:Tx,scope:OperationsScope,clock:Clock,connectionId:string,model:string,expectedRevision:string,groupIds:string[],actor:Actor){
 if(groupIds.length>16||new Set(groupIds).size!==groupIds.length)throw new DomainError('invalid_input','Use at most 16 distinct quota groups',422);
 await tx.query('SELECT pg_advisory_xact_lock(quota_binding_lock_key($1,$2))',[connectionId,model]);
 const before=await quotaBindingSnapshot(tx,scope,connectionId,model);
 if(before.bindings_revision!==expectedRevision)throw new DomainError('revision_conflict','Quota bindings changed; reload before saving',409);
 const groups=(await tx.query('SELECT * FROM provider_quota_groups WHERE id=ANY($1::text[]) AND organization_id=$2 ORDER BY id FOR SHARE',[groupIds,scope.organization_id])).rows;
 if(groups.length!==groupIds.length)throw new DomainError('not_found','Quota group not found',404);
 if(groups.some(g=>g.provider!==before.provider))throw new DomainError('quota_provider_mismatch','Group and connection providers must match',422);
 if(groups.length>1&&(!groups[0].coordination_domain||groups.some(g=>g.coordination_domain!==groups[0].coordination_domain)))throw new DomainError('quota_domains_must_match','Shared groups need the same coordination domain',422);
 if(groupIds.length){
  const definitions=(await tx.query(`SELECT m AS model FROM configuration_versions v CROSS JOIN LATERAL jsonb_array_elements(v.payload->'models') m
   WHERE v.organization_id=$1 AND v.application_id=$2 AND v.kind='catalog' AND v.status='published'
    AND m->>'id'=$3 AND m->>'provider'=$4 AND m->>'status'='active'`,[scope.organization_id,scope.application_id,model,before.provider])).rows;
  if(!definitions.length)throw new DomainError('quota_model_not_published','Choose an active model from a published catalog for this connection provider',422);
  for(const group of groups){
   if(group.scope.capability&&!definitions.some(d=>d.model.capabilities.includes(group.scope.capability)))throw new DomainError('quota_capability_mismatch','Group capability is not supported by the model',422);
   if(!(await tx.query('SELECT 1 FROM provider_quota_rules WHERE group_id=$1 LIMIT 1',[group.id])).rowCount)throw new DomainError('quota_rules_missing','Configure group rules before assigning a model',422);
  }
 }
 const removed=before.groups.map(g=>g.id).filter(group=>!groupIds.includes(group));
 if(removed.length){
  // A newly assigned empty counter cannot replace consumed provider capacity.
  // Group-wide protection is conservative when several models share the same quota.
  const held=await tx.query(`SELECT 1 FROM dispatch_admissions a WHERE a.group_id=ANY($1::text[]) AND a.unused_at IS NULL AND a.state<>'rejected'
   AND ((a.state='intent' AND a.created_at>now()-interval '25 hours')
    OR (a.slot_released_at IS NULL AND a.slot_expires_at>now())
    OR a.admitted_at>now()-GREATEST(
     (SELECT max(r.window_ms) FROM provider_quota_rules r WHERE r.group_id=a.group_id),
     (SELECT max((d->>'window_ms')::integer) FROM jsonb_array_elements(a.demands) d))*interval '1 millisecond') LIMIT 1`,[removed]);
  if(held.rowCount)throw new DomainError('quota_binding_usage_active','Removed groups still have recent consumption or held calls; wait for their windows and holds to expire',409);
 }
 const nextRevision=revision(connectionId,model,groupIds);
 if(nextRevision===before.bindings_revision)return before;
 await tx.query('DELETE FROM provider_quota_bindings WHERE connection_id=$1 AND model=$2 AND NOT(group_id=ANY($3::text[]))',[connectionId,model,groupIds]);
 for(const group of groups)await tx.query('INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[connectionId,model,group.id]);
 const after=await quotaBindingSnapshot(tx,scope,connectionId,model);
 await audit(tx,scope,clock,actor,'quota.bindings.updated',connectionId,{model,before:{groups:before.groups.map(g=>g.id),bindings_revision:before.bindings_revision},after:{groups:after.groups.map(g=>g.id),bindings_revision:after.bindings_revision}});
 return after;
}
