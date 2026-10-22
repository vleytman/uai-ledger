import {backgroundSlotsFull} from './priority.js';
import {withQuotaLocks,quotaTransaction} from './group-lock.js';
import {applyQuotaExcess} from './quota-adjustments.js';
import {refundUnusedAdmissions} from './unused-admissions.js';
import {QuotaStore,type Admission} from './quota.js';
import {applyQuotaHeaders} from './headers.js';
import type pg from 'pg';
import {transaction} from '../../db/src/index.js';
import {DomainError,hash} from '../../contracts/src/index.js';
import {concurrencyRetryAt,validateIntent,type AdmissionInput} from './admission.js';

/** One committed intent records the complete set before any multi-group Redis call. */
export async function recordAdmissionBundle(pool:pg.Pool,bundleId:string,inputs:AdmissionInput[]){
 if(!bundleId||inputs.length<1||inputs.length>16||new Set(inputs.map(input=>input.group_id)).size!==inputs.length||new Set(inputs.map(input=>input.id)).size!==inputs.length)throw new DomainError('invalid_quota_bundle');
 const sorted=[...inputs].sort((a,b)=>a.group_id.localeCompare(b.group_id));
 const first=sorted[0]!;
 if(sorted.some(input=>input.request_id!==first.request_id||input.fence!==first.fence))throw new DomainError('invalid_quota_bundle');
 const canonical=sorted.map(input=>({...input,demands:input.demands.map(({key,capacity,amount,window_ms})=>({key,capacity,amount,window_ms})).sort((a,b)=>a.key.localeCompare(b.key))}));
 const fingerprint=hash(canonical);
 return transaction(pool,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8193))',[bundleId]);
  for(const input of sorted)await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8192))',[input.group_id]);
  const groups:Array<Awaited<ReturnType<typeof validateIntent>>>=[];for(const input of sorted)groups.push(await validateIntent(tx,input));
  const group=groups[0]!;
  if(!group.coordination_domain||groups.some(item=>item.organization_id!==group.organization_id||item.provider!==group.provider||item.coordination_domain!==group.coordination_domain))throw new DomainError('quota_domains_must_match');
  const existing=(await tx.query('SELECT * FROM dispatch_admission_bundles WHERE id=$1 OR (request_id=$2 AND fencing_token=$3)',[bundleId,first.request_id,first.fence])).rows;
  if(existing.length){
   if(existing.length!==1||existing[0].id!==bundleId||existing[0].fingerprint!==fingerprint||existing[0].coordination_domain!==group.coordination_domain)throw new DomainError('idempotency_conflict');
   return existing[0];
  }
  const bundle=(await tx.query(`INSERT INTO dispatch_admission_bundles(id,request_id,fencing_token,organization_id,coordination_domain,fingerprint)
   VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[bundleId,first.request_id,first.fence,group.organization_id,group.coordination_domain,fingerprint])).rows[0];
  for(let index=0;index<canonical.length;index++){
   const input=canonical[index]!,revision=groups[index].revision;
   const prior=await tx.query('SELECT id FROM dispatch_admissions WHERE id=$1 OR (group_id=$2 AND request_id=$3 AND fencing_token=$4)',[input.id,input.group_id,input.request_id,input.fence]);
   if(prior.rowCount)throw new DomainError('idempotency_conflict');
   await tx.query("INSERT INTO dispatch_admissions(id,group_id,request_id,fencing_token,rules_revision,demands,state,rule_metrics) VALUES($1,$2,$3,$4,$5,$6,'intent',(SELECT COALESCE(jsonb_object_agg(key,metric),'{}'::jsonb) FROM provider_quota_rules WHERE group_id=$2))",[input.id,input.group_id,input.request_id,input.fence,revision,JSON.stringify(input.demands)]);
   await tx.query('INSERT INTO dispatch_admission_bundle_members(bundle_id,admission_id,group_id) VALUES($1,$2,$3)',[bundleId,input.id,input.group_id]);
  }
  return bundle;
 });
}

/** Group locks serialize concurrency, recovery and the acknowledgement of one atomic Redis result. */
export async function acquireAdmissionBundle(pool:pg.Pool,url:string,installation:string,bundleId:string):Promise<Admission>{
 const stores:QuotaStore[]=[];
 try{return await withQuotaLocks(pool,async(client,lock)=>{
  await lock(bundleId,8193);
  const bundle=(await client.query('SELECT * FROM dispatch_admission_bundles WHERE id=$1',[bundleId])).rows[0];
  if(!bundle)throw new DomainError('quota_bundle_missing');
  let members=(await client.query(`SELECT a.*,a.slot_heartbeat_until>now() AS slot_live FROM dispatch_admission_bundle_members m
   JOIN dispatch_admissions a ON a.id=m.admission_id WHERE m.bundle_id=$1 ORDER BY a.group_id`,[bundleId])).rows;
  if(members.length<1)throw new DomainError('invalid_quota_bundle');
  // Use the same ordering as recordAdmissionBundle, independently of database collation.
  members.sort((a,b)=>a.group_id.localeCompare(b.group_id));
  for(const member of members)await lock(member.group_id,8192);
  const signature=(rows:any[])=>hash(rows.map(row=>({id:row.id,group_id:row.group_id,request_id:row.request_id,fence:String(row.fencing_token),demands:row.demands})).sort((a,b)=>a.group_id.localeCompare(b.group_id)));
  const originalSignature=signature(members);
  const prepared=await quotaTransaction(client,async tx=>{
   const inputs=members.map(member=>({id:member.id,group_id:member.group_id,request_id:member.request_id,fence:String(member.fencing_token),demands:member.demands}));
   const groups:Array<Awaited<ReturnType<typeof validateIntent>>>=[];for(const input of inputs)groups.push(await validateIntent(tx,input));
   members=(await tx.query(`SELECT a.*,a.slot_heartbeat_until>now() AS slot_live FROM dispatch_admission_bundle_members m JOIN dispatch_admissions a ON a.id=m.admission_id WHERE m.bundle_id=$1 ORDER BY a.group_id FOR UPDATE OF a`,[bundleId])).rows;
   members.sort((a,b)=>a.group_id.localeCompare(b.group_id));
   if(signature(members)!==originalSignature)throw new DomainError('quota_bundle_inconsistent');
   if(groups.some(group=>group.organization_id!==bundle.organization_id||group.coordination_domain!==bundle.coordination_domain||group.provider!==groups[0].provider))throw new DomainError('quota_domains_must_match');
   if(members.some((member,index)=>member.rules_revision!==groups[index].revision))throw new DomainError('quota_revision_changed');
   if(new Set(members.map(member=>member.state)).size!==1)throw new DomainError('quota_bundle_inconsistent');
   if(members.some(member=>member.unused_at))throw new DomainError('quota_slot_lost');
   if(members[0].state==='rejected')return {result:members[0].rejection as Admission};
   if(members.some(member=>member.state==='admitted'&&(member.slot_released_at||member.slot_unknown_at||!member.slot_live)))throw new DomainError('quota_slot_lost');
   for(let index=0;index<members.length;index++){
    const member=members[index],group=groups[index];
    const slots=(await tx.query(`SELECT count(*)::int n,min(slot_expires_at) earliest,now() checked_at FROM dispatch_admissions
     WHERE group_id=$1 AND id<>$2 AND slot_released_at IS NULL AND slot_expires_at>now()`,[group.id,member.id])).rows[0];
    if(member.state!=='admitted'&&(slots.n>=group.concurrency_limit||await backgroundSlotsFull(tx,group,member.request_id,member.id)))return {result:{allowed:false,reason:'limited',rule:'concurrency',retry_at:concurrencyRetryAt(slots.earliest),details:{group_id:group.id,rule:'concurrency',demand:'1',available:'0',capacity:String(group.concurrency_limit),window_ms:null,checked_at:new Date(slots.checked_at).getTime()}} as Admission};
   }
   return {groups,inputs};
  });
  if(prepared.result)return prepared.result;
  const {groups,inputs}=prepared;
  for(let index=0;index<members.length;index++){
   const member=members[index],group=groups[index];
   const store=new QuotaStore(url,installation,group.id,JSON.stringify([bundle.organization_id,bundle.coordination_domain]));stores.push(store);store.redis.on('error',()=>{});await store.connect();
   if(!await store.isReady(group.recovery_epoch)){
    await store.closeGate();
    const prior=(await client.query("SELECT * FROM dispatch_admissions WHERE group_id=$1 AND (id<>$2 OR state='admitted') AND state<>'rejected' AND unused_at IS NULL AND created_at>now()-interval '25 hours' ORDER BY created_at",[group.id,member.id])).rows;
    const recoveryTime=await store.currentTime();
    for(const row of prior)await store.restore(row.id,row.admitted_at?new Date(row.admitted_at).getTime():recoveryTime,row.demands);
    await applyQuotaExcess(client,store,group,true);
    const observations=(await client.query("SELECT * FROM quota_observations WHERE group_id=$1 AND received_at>now()-interval '25 hours' ORDER BY received_at",[group.id])).rows;
    const rules=(await client.query('SELECT key,metric,window_ms FROM provider_quota_rules WHERE group_id=$1',[group.id])).rows;
    for(const observation of observations)await applyQuotaHeaders(store,rules,{...observation,sent_at:new Date(observation.sent_at).toISOString(),received_at:new Date(observation.received_at).toISOString()});
    await store.markRestored(group.recovery_epoch);
   }
   await applyQuotaExcess(client,store,group);
   await refundUnusedAdmissions(client,store,group);
   if(group.blocked_until&&new Date(group.blocked_until).getTime()>Date.now()){
    for(const demand of member.demands)await store.blockUntil(group.recovery_epoch,demand.key,new Date(group.blocked_until).getTime());
   }
  }
  const permits=members.map((member,index)=>({store:stores[index]!,epoch:groups[index].recovery_epoch,admissionId:member.id,demands:member.demands}));
  let result=await QuotaStore.acquireMany(permits);
  if(!result.allowed&&result.reason==='conflict'&&members.every(member=>member.state==='intent')){
   const submitted=await client.query('SELECT 1 FROM execution_attempts WHERE request_id=$1 AND fencing_token=$2 LIMIT 1',[bundle.request_id,bundle.fencing_token]);
   if(!submitted.rowCount&&await QuotaStore.discardUnsentMany(permits))result=await QuotaStore.acquireMany(permits);
  }
  // Without the unsent proof an epoch/cache conflict remains uncertain.
  if(!result.allowed&&(result.reason==='conflict'||result.reason==='not_ready'))return result;
  try{return await quotaTransaction(client,async tx=>{
   const currentGroups:Array<Awaited<ReturnType<typeof validateIntent>>>=[];
   for(const input of inputs)currentGroups.push(await validateIntent(tx,input));
   const latest=(await tx.query(`SELECT a.*,a.slot_heartbeat_until>now() AS slot_live FROM dispatch_admission_bundle_members m
    JOIN dispatch_admissions a ON a.id=m.admission_id WHERE m.bundle_id=$1 ORDER BY a.group_id FOR UPDATE OF a`,[bundleId])).rows;
   latest.sort((a,b)=>a.group_id.localeCompare(b.group_id));
   if(signature(latest)!==originalSignature||latest.some((row,index)=>row.state!==members[index].state))throw new DomainError('quota_bundle_inconsistent');
   for(let index=0;index<latest.length;index++){
    const member=latest[index],current=currentGroups[index],group=groups[index];
    if(current.organization_id!==bundle.organization_id||current.coordination_domain!==bundle.coordination_domain||current.provider!==group.provider)throw new DomainError('quota_domains_must_match');
    if(current.revision!==group.revision||current.recovery_epoch!==group.recovery_epoch||member.rules_revision!==current.revision)throw new DomainError('quota_revision_changed');
    if(member.unused_at||member.slot_released_at||member.slot_unknown_at||(member.state==='admitted'&&!member.slot_live))throw new DomainError('quota_slot_lost');
    if(result.allowed&&member.state!=='admitted'){
     const slots=(await tx.query(`SELECT count(*)::int n FROM dispatch_admissions WHERE group_id=$1 AND id<>$2 AND slot_released_at IS NULL AND slot_expires_at>now()`,[group.id,member.id])).rows[0];
     if(slots.n>=current.concurrency_limit||await backgroundSlotsFull(tx,current,member.request_id,member.id))throw new DomainError('quota_concurrency_changed');
     if(current.blocked_until&&new Date(current.blocked_until).getTime()>Date.now())throw new DomainError('quota_cooldown_changed');
    }
   }
   // Validate every group before acknowledging any; all updates commit together.
   for(let index=0;index<latest.length;index++){
    const member=latest[index],group=currentGroups[index];
    await tx.query('UPDATE dispatch_admissions SET state=$2,admitted_at=$3,rejection=$4 WHERE id=$1',[member.id,result.allowed?'admitted':'rejected',result.allowed?new Date(result.at):null,result.allowed?null:result]);
    if(result.allowed&&member.state!=='admitted')await tx.query("UPDATE dispatch_admissions SET slot_heartbeat_until=now()+$2*interval '1 millisecond',slot_expires_at=now()+($2+$3)*interval '1 millisecond',slot_released_at=NULL WHERE id=$1",[member.id,group.slot_lease_ms,group.unknown_hold_ms]);
   }
   return result;
  })}catch(error){
   await quotaTransaction(client,async tx=>{
    await tx.query('SELECT id FROM execution_requests WHERE id=$1 FOR UPDATE',[bundle.request_id]);
    await tx.query(`UPDATE dispatch_admissions d SET unused_at=COALESCE(unused_at,now()),slot_released_at=COALESCE(slot_released_at,now()),slot_heartbeat_until=NULL
     WHERE d.id=ANY($1::text[]) AND d.state='intent' AND d.slot_unknown_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM execution_attempts a WHERE a.request_id=d.request_id AND a.fencing_token=d.fencing_token)`,[members.map(member=>member.id)]);
   });
   throw error;
  }
 });}finally{await Promise.allSettled(stores.map(store=>store.close()))}
}
