import {ExecutionLimits,DEFAULT_EXECUTION,resolveExecutionPolicy} from '../../contracts/invocation.js';
import type {SqlExecutor} from '../../db/src/index.js';

export async function executionLimits(db:SqlExecutor){
 const result=await db.query('SELECT max_attempts,max_deadline_seconds FROM invocation_execution_limits WHERE singleton=true');
 return ExecutionLimits.parse(result.rows[0]);
}

export async function defaultExecutionPolicy(db:SqlExecutor,scope:{organization_id:string;application_id:string}){
 const result=await db.query(`SELECT v.id,v.payload FROM configuration_versions v
 JOIN configuration_activations a ON a.release_id=v.file_source->>'release_id'
 AND a.organization_id=v.organization_id AND a.application_id=v.application_id
 WHERE v.organization_id=$1 AND v.application_id=$2 AND v.kind='execution_policy'
 AND v.key='default' AND v.status='published' ORDER BY v.version DESC LIMIT 1`,[scope.organization_id,scope.application_id]);
 const row=result.rows[0];
 return {id:row?.id??null,policy:resolveExecutionPolicy(undefined,undefined,await executionLimits(db),row?.payload??DEFAULT_EXECUTION)};
}
