import {DomainError,type Scope} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';

/**
 * Under BullMQ a call is sent only after admission through the provider quota groups bound to its
 * connection and model. A route target without such a group, or with a group that has no rules,
 * could never be admitted, so the call is refused here, before anything is reserved.
 */
export async function assertQuotaGroupsReady(tx:Tx,scope:Scope,targets:{connection_id:string;model:string}[]){
 if(process.env.UAI_EXECUTION_BACKEND!=='bullmq')return;
 for(const target of targets){
  const groups=(await tx.query(`SELECT g.id,EXISTS(SELECT 1 FROM provider_quota_rules r WHERE r.group_id=g.id) AS has_rules
   FROM provider_quota_groups g JOIN provider_quota_bindings b ON b.group_id=g.id WHERE b.connection_id=$1 AND b.model=$2 AND g.organization_id=$3 ORDER BY g.id`,[target.connection_id,target.model,scope.organization_id])).rows;
  const details={connection_id:target.connection_id,model:target.model};
  if(!groups.length)throw new DomainError('quota_group_missing',`No provider quota group is bound to connection ${target.connection_id} and model ${target.model}`,409,details);
  const empty=groups.find(group=>!group.has_rules);
  if(empty)throw new DomainError('quota_rules_missing',`Provider quota group ${empty.id} for connection ${target.connection_id} and model ${target.model} has no rules`,409,{...details,group_id:empty.id});
 }
}
