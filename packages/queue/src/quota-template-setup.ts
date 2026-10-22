import {DomainError,hash,type Clock} from '../../contracts/src/index.js';
import {openaiTier4QuotaTemplates} from '../../contracts/src/quota-templates.js';
import type {Tx} from '../../db/src/index.js';
import type {Actor,OperationsScope} from '../../reconciliation/src/connections.js';
import {createQuotaGroup,type QuotaGroupDefinition} from './quota-create.js';
import {quotaBindingSnapshot,updateQuotaBindings} from './quota-bindings.js';
export interface TemplateSetup {
 connection_id:string;models:string[];provider_account:string;provider_project:string;
 coordination_domain:string;concurrency_limit:number;
}
function validate(input:TemplateSetup){
 if(!input.connection_id||!Array.isArray(input.models)||!input.models.length||input.models.length>32||new Set(input.models).size!==input.models.length||!input.provider_account?.trim()||!input.provider_project?.trim()||!input.coordination_domain?.trim()||!Number.isSafeInteger(input.concurrency_limit)||input.concurrency_limit<1||input.concurrency_limit>100000)throw new DomainError('invalid_input','Specify connection, distinct models, provider account/project, domain and local concurrency',422);
}
/** Read-only manifest. Existing group settings and bindings are preserved. */
export async function previewQuotaTemplateSetup(tx:Tx,scope:OperationsScope,input:TemplateSetup){
 validate(input);const entries=[];
 for(const model of [...input.models].sort()){
  const template=openaiTier4QuotaTemplates.find(t=>t.models.includes(model));if(!template)throw new DomainError('quota_template_missing',`No verified template for ${model}`,422);
  const binding=await quotaBindingSnapshot(tx,scope,input.connection_id,model);
  if(binding.provider!=='openai')throw new DomainError('quota_provider_mismatch','OpenAI connection required',422);
  const published=await tx.query(`SELECT 1 FROM configuration_versions v CROSS JOIN LATERAL jsonb_array_elements(v.payload->'models') m WHERE v.organization_id=$1 AND v.application_id=$2 AND v.kind='catalog' AND v.status='published' AND m->>'id'=$3 AND m->>'provider'='openai' AND m->>'status'='active'`,[scope.organization_id,scope.application_id,model]);
  if(!published.rowCount)throw new DomainError('quota_model_not_published','Publish the model before configuring its quota',422);
  const identity={provider_account:input.provider_account,provider_project:input.provider_project,template_id:template.id};
  const groups=(await tx.query(`SELECT g.id,g.name,g.revision,g.settings_revision,g.coordination_domain,g.source,g.checked_at,g.concurrency_limit,COALESCE((SELECT jsonb_agg(jsonb_build_object('key',r.key,'metric',r.metric,'capacity',r.capacity::text,'provider_capacity',r.provider_capacity::text,'window_ms',r.window_ms) ORDER BY r.key) FROM provider_quota_rules r WHERE r.group_id=g.id),'[]'::jsonb) AS rules FROM provider_quota_groups g WHERE organization_id=$1 AND provider='openai' AND scope @> $2::jsonb ORDER BY id`,[scope.organization_id,identity])).rows;
  if(groups.length>1)throw new DomainError('quota_template_ambiguous','Several groups match the template identity',409);
  const existing=groups[0]??null;
  if(existing&&existing.coordination_domain!==input.coordination_domain)throw new DomainError('quota_domains_must_match','Existing template uses another domain',409);
  if(binding.groups.some(g=>g.coordination_domain!==input.coordination_domain))throw new DomainError('quota_domains_must_match','Existing model groups use another domain',409);
  const definition:QuotaGroupDefinition={name:`${template.name} · ${hash(identity).slice(0,12)}`,provider:'openai',scope:{...identity,capability:template.capability},coordination_domain:input.coordination_domain,source:template.source,checked_at:template.checked_at,concurrency_limit:input.concurrency_limit,rules:template.rules.map(rule=>({...rule}))};
  entries.push({model,template_id:template.id,existing,binding,definition});
 }
 return {revision:hash({scope,input,entries}),entries};
}
/** Caller owns the transaction. All mutations roll back on conflict; no Redis counters are reset. */
export async function applyQuotaTemplateSetup(tx:Tx,scope:OperationsScope,clock:Clock,input:TemplateSetup,expectedRevision:string,actor:Actor){
 validate(input);
 // Serialize installers for one provider pool, then fence route assignments in stable order.
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8197))',[JSON.stringify([scope.organization_id,input.provider_account,input.provider_project])]);
 for(const model of [...input.models].sort())await tx.query('SELECT pg_advisory_xact_lock(quota_binding_lock_key($1,$2))',[input.connection_id,model]);
 await tx.query("SELECT id FROM provider_quota_groups WHERE organization_id=$1 AND provider='openai' AND scope @> $2::jsonb ORDER BY id FOR SHARE",[scope.organization_id,{provider_account:input.provider_account,provider_project:input.provider_project}]);
 const plan=await previewQuotaTemplateSetup(tx,scope,input);
 if(plan.revision!==expectedRevision)throw new DomainError('revision_conflict','Quota setup changed; review a fresh preview',409);
 const applied=[],created=new Map<string,string>();
 for(const entry of plan.entries){
  const group=entry.existing?.id??created.get(entry.template_id)??await createQuotaGroup(tx,scope,clock,entry.definition,actor);
  created.set(entry.template_id,group);
  const groups=[...new Set([...entry.binding.groups.map(g=>g.id),group])];
  // Aliases in the same manifest discover the group created earlier in this transaction.
  const current=await quotaBindingSnapshot(tx,scope,input.connection_id,entry.model);
  if(!current.groups.some(g=>g.id===group))await updateQuotaBindings(tx,scope,clock,input.connection_id,entry.model,current.bindings_revision,groups,actor);
  applied.push({model:entry.model,group_id:group});
 }
 return applied;
}
