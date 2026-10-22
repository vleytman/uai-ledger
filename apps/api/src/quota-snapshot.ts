import {authenticateRequest} from './request-principal.js';
import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {transaction} from '../../../packages/db/src/index.js';
import {requireScopes} from '../../../packages/auth/src/index.js';
import {DomainError} from '../../../packages/contracts/src/index.js';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {QuotaStore} from '../../../packages/queue/src/quota.js';

export function registerQuotaSnapshot(app:FastifyInstance,pool:pg.Pool){
 app.get('/v1/admin/provider-quotas/:id/snapshot',async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  const groupId=apiSchemas.Identifier.parse((request.params as {id:string}).id);
  const {group,rules}=await transaction(pool,async tx=>{
   const p=await authenticateRequest(tx,request);requireScopes(p,'operations:admin');
   if(p.account_ids)throw new DomainError('scope_denied','Quota administrator required',403);
   const group=(await tx.query('SELECT * FROM provider_quota_groups WHERE id=$1 AND organization_id=$2',[groupId,p.organization_id])).rows[0];
   if(!group)throw new DomainError('not_found','Quota group not found',404);
   const rules=(await tx.query('SELECT key,capacity,window_ms FROM provider_quota_rules WHERE group_id=$1 ORDER BY key',[groupId])).rows.map(r=>({...r,capacity:Number(r.capacity)}));
   return {group,rules};
  });
  const unavailable=(status:string,at:number|null=null)=>({group_id:group.id,rules_revision:group.revision,status,sampled_at:at===null?null:new Date(at).toISOString(),rules:[]});
  const url=process.env.REDIS_URL,installation=process.env.UAI_INSTALLATION_ID;
  if(!url||!installation)return unavailable('not_configured');
  if(!rules.length)return unavailable('no_rules');
  let store:QuotaStore|undefined;
  try{
   // No SQL transaction or lock is held during Redis I/O.
   store=new QuotaStore(url,installation,group.id,group.coordination_domain?JSON.stringify([group.organization_id,group.coordination_domain]):undefined);
   await store.connect();const snapshot=await store.snapshot(group.recovery_epoch,rules);
   if(!snapshot.ready)return unavailable(snapshot.reason,snapshot.at);
   const current=(await pool.query('SELECT revision,recovery_epoch,blocked_until FROM provider_quota_groups WHERE id=$1 AND organization_id=$2',[group.id,group.organization_id])).rows[0];
   if(!current||current.revision!==group.revision||current.recovery_epoch!==group.recovery_epoch)return unavailable('configuration_changed',snapshot.at);
   const pausedUntil=current.blocked_until?new Date(current.blocked_until).getTime():0;
   const iso=(value:number|null)=>value===null?null:new Date(value).toISOString();
   return {group_id:group.id,rules_revision:group.revision,status:'ready',sampled_at:iso(snapshot.at),rules:snapshot.rules.map(rule=>({...rule,
    available:pausedUntil>snapshot.at?'0':rule.available,
    blocked_until:iso(Math.max(rule.blocked_until??0,pausedUntil)>snapshot.at?Math.max(rule.blocked_until??0,pausedUntil):null),
    provider:rule.provider?{...rule.provider,reset_at:iso(rule.provider.reset_at),observed_at:iso(rule.provider.observed_at)}:null
   }))};
  }catch{return unavailable('unavailable')}
  finally{store?.redis.disconnect()}
 });
}
