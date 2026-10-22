import {embeddingModel,embeddingInstallationLimits} from '../../../packages/providers/src/embeddings.js';
import {defaultExecutionPolicy,executionLimits} from '../../../packages/execution/src/policy.js';
import {ExecutionOverrides,resolveExecutionPolicy} from '../../../packages/contracts/invocation.js';
import {activeFileReleases} from '../../../packages/configuration/src/ownership.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';
import type {Clock,Scope} from '../../../packages/contracts/src/index.js';
import type {Tx} from '../../../packages/db/src/index.js';
type PublicScope=Pick<Scope,'organization_id'|'application_id'>;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const roles=['primary','fallback'] as const;
const metrics=['prepaid_balance','spending_cap','quota','credit_limit'];

/** Public profile metadata contains provider-account snapshots, never credentials or account identifiers. */
export async function listPublicProfiles(tx:Tx,scope:PublicScope,clock:Clock){
 const active=await activeFileReleases(tx,scope);
 const defaults=await defaultExecutionPolicy(tx,scope),limits=await executionLimits(tx);
 const policies=(await tx.query("SELECT id,payload FROM configuration_versions WHERE organization_id=$1 AND application_id=$2 AND kind='execution_policy' AND status='published'",[scope.organization_id,scope.application_id])).rows;
 const namedPolicies=new Map(policies.map(row=>[row.id,row.payload]));
 const profiles=(await new CatalogService(tx,clock).list(scope,'route')).filter(row=>row.status==='published'&&(!row.file_source||active.has(row.file_source.release_id)));
 const catalogs=(await new CatalogService(tx,clock).list(scope,'catalog')).filter(row=>row.status==='published');
 const modelsByCatalog=new Map(catalogs.map(row=>[row.id,(row.payload as any).models??[]]));
 const connectionIds=[...new Set(profiles.flatMap(row=>roles.map(role=>object(object(row.payload)[role]).connection_id)).filter((value):value is string=>typeof value==='string'))];
 const connections=connectionIds.length?(await tx.query('SELECT id,provider FROM provider_connections WHERE organization_id=$1 AND application_id=$2 AND id=ANY($3::text[])',[scope.organization_id,scope.application_id,connectionIds])).rows:[];
 const knownConnections=new Map(connections.map(row=>[row.id,row]));
 const snapshots=connections.length?(await tx.query(`SELECT DISTINCT ON(s.connection_id,s.metric) s.connection_id,s.metric,s.source,s.precision,s.native_unit,s.total,s.used,s.remaining,s.fetched_at,s.covered_through,s.stale_after_seconds
  FROM provider_snapshots s JOIN provider_connections c ON c.id=s.connection_id AND c.organization_id=s.organization_id AND c.application_id=s.application_id AND c.account_scope=s.account_scope
  WHERE s.organization_id=$1 AND s.application_id=$2 AND s.connection_id=ANY($3::text[]) AND s.metric=ANY($4::text[])
  ORDER BY s.connection_id,s.metric,s.fetched_at DESC,s.id DESC`,[scope.organization_id,scope.application_id,[...knownConnections.keys()],metrics])).rows:[];
 const byConnection=new Map<string,Record<string,unknown>[]>();
 for(const snapshot of snapshots){
  const list=byConnection.get(snapshot.connection_id)??[];
  list.push({metric:snapshot.metric,source:snapshot.source,precision:['exact','estimated','unknown'].includes(snapshot.precision)?snapshot.precision:'unknown',freshness:clock.now().getTime()-new Date(snapshot.fetched_at).getTime()>snapshot.stale_after_seconds*1000?'stale':'fresh',fetched_at:new Date(snapshot.fetched_at).toISOString(),covered_through:snapshot.covered_through?new Date(snapshot.covered_through).toISOString():null,native_unit:snapshot.native_unit,total:snapshot.total,used:snapshot.used,remaining:snapshot.remaining});byConnection.set(snapshot.connection_id,list);
 }
 return profiles.map(row=>{
  const original=object(row.payload),payload:Record<string,unknown>={};
  for(const key of ['capability','platform_risk_budget_units'])if(typeof original[key]==='string')payload[key]=original[key];
  if(typeof original.deadline_seconds==='number'&&Number.isSafeInteger(original.deadline_seconds))payload.deadline_seconds=original.deadline_seconds;
  const parsedPolicy=ExecutionOverrides.safeParse(original.execution===undefined?{}:original.execution);
  if(parsedPolicy.success){try{payload.execution=resolveExecutionPolicy(parsedPolicy.data,undefined,limits,namedPolicies.get(original.execution_policy_version_id)??defaults.policy);payload.execution_policy_version_id=namedPolicies.has(original.execution_policy_version_id)?original.execution_policy_version_id:defaults.id;}catch{/* Malformed profiles must not disclose raw configuration. */}}
  const provider_limits=roles.filter(role=>role==='primary'||original[role]!==undefined).map(role=>{
   const target=object(original[role]);const connection=typeof target.connection_id==='string'?knownConnections.get(target.connection_id):undefined;
   const model=typeof target.model==='string'?target.model:'unavailable';const metricRows=connection?byConnection.get(connection.id)??[]:[];
   const definition=modelsByCatalog.get(String(target.catalog_version_id))?.find((entry:any)=>entry.id===model);
   const publicTarget:Record<string,unknown>={model,provider:definition?.provider,preview:definition?.preview,live_validation:definition?.live_validation,service_mode:target.service_mode,...(definition?.capabilities.includes('embeddings.generate')?{embedding_features:{...embeddingModel(model),installation_limits:embeddingInstallationLimits}}:{}),...(definition?.text_features?{text_features:definition.text_features}:{})};
   // Internal references are retained only when the target connection belongs to this application.
   if(connection)for(const key of ['catalog_version_id','connection_id','max_cost_units','limiter_key'])if(typeof target[key]==='string')publicTarget[key]=target[key];
   payload[role]=publicTarget;
   return {role,model,provider:connection?.provider??'unavailable',scope:'provider_account' as const,status:metricRows.some(metric=>metric.precision!=='unknown'&&(metric.total!==null||metric.used!==null||metric.remaining!==null))?'known' as const:'unknown' as const,metrics:metricRows};
  });
  return {id:row.id,key:row.key,version:row.version,revision:row.revision,kind:row.kind,status:row.status,created_at:row.created_at,published_at:row.published_at,payload,provider_limits};
 });
}
