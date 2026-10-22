import {DomainError} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';

// A valid issued admission remains authorized after a capacity revision. New
// admission acquisition validates the latest rules; proof still checks fence, age,
// slot ownership and binding membership here.
/** One representative admission ID identifies the immutable bundle through its membership. */
export async function assertQuotaProof(tx:Tx,admissionId:string,requestId:string,fence:string|number,connectionId:string,model:string){
 // The database trigger takes the matching exclusive lock for every binding
 // mutation, including INSERT. Unrelated routes remain independently editable.
 await tx.query('SELECT pg_advisory_xact_lock_shared(quota_binding_lock_key($1,$2))',[connectionId,model]);
 const membership=(await tx.query('SELECT bundle_id FROM dispatch_admission_bundle_members WHERE admission_id=$1',[admissionId])).rows[0];
 // No row lock: an UPDATE/DELETE may already own its tuple while its trigger
 // waits for our advisory lock. MVCC reads avoid that reverse lock dependency.
 const expected=(await tx.query('SELECT group_id FROM provider_quota_bindings WHERE connection_id=$1 AND model=$2 ORDER BY group_id',[connectionId,model])).rows.map(row=>row.group_id);
 if(!expected.length)throw new DomainError('quota_admission_invalid');
 if(!membership){
  if(expected.length!==1)throw new DomainError('quota_admission_invalid');
  const proof=(await tx.query(`SELECT a.id FROM dispatch_admissions a JOIN provider_quota_groups g ON g.id=a.group_id
   WHERE a.id=$1 AND a.group_id=$4 AND a.request_id=$2 AND a.fencing_token=$3 AND a.state='admitted'
    AND g.coordination_domain IS NULL AND a.slot_expires_at>now() AND a.slot_heartbeat_until>now()
    AND a.slot_unknown_at IS NULL AND a.slot_released_at IS NULL
    AND a.admitted_at>now()-interval '30 seconds' FOR SHARE OF a,g`,[admissionId,requestId,fence,expected[0]])).rows[0];
  if(!proof)throw new DomainError('quota_admission_invalid');return;
 }
 const bundle=(await tx.query('SELECT * FROM dispatch_admission_bundles WHERE id=$1 AND request_id=$2 AND fencing_token=$3 FOR SHARE',[membership.bundle_id,requestId,fence])).rows[0];
 if(!bundle)throw new DomainError('quota_admission_invalid');
 const members=(await tx.query('SELECT group_id FROM dispatch_admission_bundle_members WHERE bundle_id=$1 ORDER BY group_id FOR SHARE',[bundle.id])).rows.map(row=>row.group_id);
 if(JSON.stringify(members)!==JSON.stringify(expected))throw new DomainError('quota_admission_invalid');
 const proofs=(await tx.query(`SELECT a.id FROM dispatch_admission_bundle_members m
  JOIN dispatch_admissions a ON a.id=m.admission_id JOIN provider_quota_groups g ON g.id=a.group_id
  WHERE m.bundle_id=$1 AND a.request_id=$2 AND a.fencing_token=$3 AND a.state='admitted'
   AND g.organization_id=$4 AND g.coordination_domain=$5
   AND a.slot_expires_at>now() AND a.slot_heartbeat_until>now() AND a.slot_unknown_at IS NULL
   AND a.slot_released_at IS NULL
   AND a.admitted_at>now()-interval '30 seconds' FOR SHARE OF a,g`,[bundle.id,requestId,fence,bundle.organization_id,bundle.coordination_domain])).rows;
 if(proofs.length!==expected.length)throw new DomainError('quota_admission_invalid');
}
