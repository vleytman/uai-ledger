import {DomainError,hash,systemClock,type Clock} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';
import type {CatalogScope} from '../../catalog/src/index.js';
import {publishConfiguration,parseConfiguration,type Provenance} from './index.js';
export interface AdoptionBaseline {kind:'catalog'|'rate_card'|'route'|'recipe';key:string;id:string;hash:string}
/** A reviewed export is the CAS baseline. Publication and ownership transfer must commit together. */
export async function adoptConfiguration(tx:Tx,scope:CatalogScope,value:unknown,bindings:unknown,provenance:Provenance,baselines:AdoptionBaseline[],reason:string,clock:Clock=systemClock){
 if(!reason.trim()||!baselines.length)throw new DomainError('adoption_evidence_required');
 const document=parseConfiguration(value);
 await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':configuration',0))",[scope.organization_id,scope.application_id]);
 for(const baseline of baselines){
  if(!document.resources.some(r=>r.kind===baseline.kind&&r.key===baseline.key))throw new DomainError('adoption_resource_missing');
  const table=baseline.kind==='recipe'?'recipe_versions':'configuration_versions';
  const row=(await tx.query(`SELECT * FROM ${table} WHERE organization_id=$1 AND application_id=$2 AND key=$3 ${baseline.kind==='recipe'?'':'AND kind=$4'} ORDER BY version DESC LIMIT 1`,baseline.kind==='recipe'?[scope.organization_id,scope.application_id,baseline.key]:[scope.organization_id,scope.application_id,baseline.key,baseline.kind])).rows[0];
  const existing=(await tx.query('SELECT * FROM configuration_file_adoptions WHERE organization_id=$1 AND application_id=$2 AND kind=$3 AND key=$4',[scope.organization_id,scope.application_id,baseline.kind,baseline.key])).rows[0];
  if(existing){if(existing.bundle_key!==document.bundle_key||existing.baseline_id!==baseline.id||existing.baseline_hash!==baseline.hash)throw new DomainError('adoption_conflict');continue;}
  if(!row||row.id!==baseline.id||row.file_source||hash(JSON.parse(JSON.stringify(row)))!==baseline.hash)throw new DomainError('adoption_baseline_changed','Re-export the changed legacy definition',409);
  await tx.query('INSERT INTO configuration_file_adoptions(organization_id,application_id,kind,key,bundle_key,baseline_id,baseline_hash,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[scope.organization_id,scope.application_id,baseline.kind,baseline.key,document.bundle_key,baseline.id,baseline.hash,provenance.publisher,reason]);
 }
 return publishConfiguration(tx,scope,document,bindings,provenance,clock);
}
