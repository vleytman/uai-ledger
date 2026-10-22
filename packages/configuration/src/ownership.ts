import {DomainError} from '../../contracts/src/index.js';
import type {SqlExecutor} from '../../db/src/index.js';
export interface FileSource {
 bundle_key:string;release_id:string;path:string;git_revision:string;content_hash:string;
 schema_version:1;git_dirty:boolean;publisher:string;dependencies:Record<string,string>;
}
export async function assertDatabaseManaged(db:SqlExecutor,scope:{organization_id:string;application_id:string},kind:string,key:string){
 // Shares the publication lock; a racing legacy create cannot claim a managed key.
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':configuration',0))",[scope.organization_id,scope.application_id]);
 const table=kind==='recipe'?'recipe_versions':'configuration_versions';
 const rows=await db.query(`SELECT 1 FROM ${table} WHERE organization_id=$1 AND application_id=$2 AND key=$3 AND file_source IS NOT NULL ${kind==='recipe'?'':'AND kind=$4'} LIMIT 1`,kind==='recipe'?[scope.organization_id,scope.application_id,key]:[scope.organization_id,scope.application_id,key,kind]);
 if(rows.rowCount||(await db.query('SELECT 1 FROM configuration_file_adoptions WHERE organization_id=$1 AND application_id=$2 AND kind=$3 AND key=$4',[scope.organization_id,scope.application_id,kind,key])).rowCount)throw new DomainError('file_managed_configuration','Edit the Git definition and publish a new release.',409);
}
/** For public discovery only. Internal/accepted snapshots remain addressable by ID. */
export async function activeFileReleases(db:SqlExecutor,scope:{organization_id:string;application_id:string}){
 return new Set<string>((await db.query('SELECT release_id FROM configuration_activations WHERE organization_id=$1 AND application_id=$2',[scope.organization_id,scope.application_id])).rows.map(r=>r.release_id));
}
