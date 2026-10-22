import {TextFeatures,ExecutionPolicy,ExecutionOverrides,BillingOverrides} from '../../contracts/invocation.js';
import {z} from 'zod';
import {paidApiSchemas} from '../../contracts/paid-api.js';
import {validateTariff} from '../../allowance/src/index.js';
import {DomainError,hash,id,systemClock,type Clock} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';
import {CatalogService,type CatalogScope,type ConfigurationKind,type ConfigurationPayload,type CatalogDefinition,type RouteDefinition,type PublishSample} from '../../catalog/src/index.js';
import {publishRecipe,type RecipeDefinition} from '../../quoting/src/index.js';
import {adapterDefinition} from '../../providers/src/registry.js';
import type {FileSource} from './ownership.js';

const key=z.string().regex(/^[a-zA-Z0-9_.-]{1,160}$/);
const object=z.record(z.string(),z.unknown());
const ref=(kind:string)=>z.string().regex(new RegExp(`^@${kind}:[a-zA-Z0-9_.-]{1,160}$`));
const units=z.string().regex(/^(0|[1-9]\d*)$/);
const capability=z.enum(['embeddings.generate','text.generate','image.generate','image.vectorize','speech.synthesize','search','api.call']);
const target=z.strictObject({service_mode:z.literal('standard').optional(),catalog_version_id:ref('catalog'),model:z.string().min(1),connection_id:ref('connection'),max_cost_units:units,limiter_key:z.string().optional()});
const resource={key,display_name:z.string().trim().min(1).max(200).optional()};
// Nested calculation, rate and recipe policies use their existing domain validators.
// This schema owns the file envelope, allowed fields and symbolic references.
export const fileConfigurationSchema=z.strictObject({
 schema_version:z.literal(1),bundle_key:key,
 resources:z.array(z.discriminatedUnion('kind',[
  z.strictObject({...resource,kind:z.literal('execution_policy'),payload:ExecutionPolicy}),
  z.strictObject({...resource,kind:z.literal('tariff'),payload:paidApiSchemas.TariffTemplate}),
  z.strictObject({...resource,kind:z.literal('rate_card'),payload:z.strictObject({id:z.string(),currency:z.literal('USD'),source:z.string(),checked_at:z.string(),rates:z.array(object)}),samples:z.array(z.strictObject({usage:object,context:object})).min(1)}),
  z.strictObject({...resource,kind:z.literal('catalog'),payload:z.strictObject({models:z.array(z.strictObject({preview:z.boolean().optional(),live_validation:z.enum(['not_run','passed','failed']).optional(),id:z.string().min(1),provider:z.string().min(1),adapter_ref:z.string().min(1),capabilities:z.array(capability).min(1),allowed_parameters:z.array(z.string()),status:z.enum(['active','disabled']),identity_kind:z.enum(['snapshot','alias']).optional(),text_features:TextFeatures.optional(),calculation:object.optional(),api:paidApiSchemas.ServiceOperation.optional(),rate_card_version_id:ref('rate_card').optional()})).min(1)})}),
  z.strictObject({...resource,kind:z.literal('route'),payload:z.strictObject({capability,primary:target,fallback:target.optional(),execution_policy_version_id:ref('execution_policy').optional(),execution:ExecutionOverrides.optional(),deadline_seconds:z.number().int().positive().optional(),platform_risk_budget_units:units})}),
  z.strictObject({key,kind:z.literal('recipe'),payload:z.strictObject({period_budget_key:ref('budget'),execution:ExecutionOverrides.optional(),billing:BillingOverrides.optional(),inputs:object.optional(),partial_policy:z.literal('successful_parts').optional(),settlement:z.enum(['actual_usage','fixed','mixed','quoted_final']).optional(),deadline_seconds:z.number().int().positive().optional(),content_ttl_seconds:z.number().int().positive().optional(),components:z.array(z.strictObject({key,capability,route_version_id:ref('route'),rate_card_version_id:ref('rate_card'),count:object,limits:object,billing:object.optional(),pricing_mode:z.enum(['quoted_final','estimated_actual','actual_capped']).optional(),estimation:object.optional(),maximum_items:z.array(object).optional(),conditions:z.record(z.string(),z.string()).optional(),response_schema:object.optional()})).min(1)})}),
 ])).min(1).max(100),
});
export const bindingsSchema=z.strictObject({connections:z.record(key,z.string().min(1).max(200)),budgets:z.record(key,z.string().min(1).max(200))});
export const provenanceSchema=z.strictObject({path:z.string().min(1).refine(p=>!p.startsWith('/')&&!p.split('/').includes('..'),'Repository-relative path required'),git_dirty:z.boolean(),git_revision:z.string().regex(/^[a-f0-9]{40,64}$/),content_hash:z.string().regex(/^[a-f0-9]{64}$/),publisher:z.string().min(1).max(200)});
export type FileConfiguration=z.infer<typeof fileConfigurationSchema>;
export type Bindings=z.infer<typeof bindingsSchema>;
export type Provenance=z.infer<typeof provenanceSchema>;
const priority={execution_policy:0,tariff:0,rate_card:0,catalog:1,route:2,recipe:3};
export function parseConfiguration(value:unknown):FileConfiguration {
 const document=fileConfigurationSchema.parse(value),keys=new Set<string>();
 for(const resource of document.resources){const k=`${resource.kind}:${resource.key}`;if(keys.has(k))throw new DomainError('duplicate_configuration_key',k,422);keys.add(k);}
 // A bundle owns a complete publishable profile; future kinds need explicit schemas.
 if(!document.resources.some(r=>r.kind==='recipe')&&!document.resources.every(r=>r.kind==='tariff'||r.kind==='execution_policy'))throw new DomainError('recipe_required','A service bundle must include an entry recipe; tariff-only bundles are also allowed.',422);
 return document;
}
function changes(before:unknown,after:unknown,path='',result:Array<{path:string;before?:unknown;after?:unknown}>=[]){
 if(hash(before??null)===hash(after??null))return result;
 if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){
  for(const key of new Set([...Object.keys(before),...Object.keys(after)]))changes((before as any)[key],(after as any)[key],`${path}/${key}`,result);
 }else result.push({path:path||'/',before,after});
 return result;
}
async function lock(tx:Tx,scope:CatalogScope){await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':configuration',0))",[scope.organization_id,scope.application_id]);}
export async function previewConfiguration(tx:Tx,scope:CatalogScope,value:unknown,bindingsValue:unknown,provenance:Provenance,clock:Clock=systemClock){
 const document=parseConfiguration(value),bindings=bindingsSchema.parse(bindingsValue);
 await lock(tx,scope);
 const previous=(await tx.query("SELECT r.* FROM configuration_releases r WHERE organization_id=$1 AND application_id=$2 AND bundle_key=$3 ORDER BY GREATEST((SELECT MAX(v.version) FROM recipe_versions v WHERE v.organization_id=r.organization_id AND v.application_id=r.application_id AND v.file_source->>'release_id'=r.id),(SELECT MAX(t.version) FROM provider_tariff_versions t WHERE t.organization_id=r.organization_id AND t.application_id=r.application_id AND t.file_source->>'release_id'=r.id)) DESC LIMIT 1",[scope.organization_id,scope.application_id,document.bundle_key])).rows[0];
 // Run the exact publication validators and database guards, rolling back all writes.
 await tx.query('SAVEPOINT configuration_preview');
 try{
  const published=await publishConfiguration(tx,scope,document,bindings,provenance,clock);
  return {bundle_key:document.bundle_key,digest:published.digest,unchanged:published.reused,changes:changes(previous?{document:previous.document,bindings:previous.bindings}:undefined,{document,bindings}),resources:published.resources.map((r:ResourceVersion)=>({kind:r.kind,key:r.key,version:r.version})),activation:'unchanged'};
 }finally{await tx.query('ROLLBACK TO SAVEPOINT configuration_preview');await tx.query('RELEASE SAVEPOINT configuration_preview');}
}
interface ResourceVersion {kind:string;key:string;version:number;id:string}
export async function releaseResources(tx:Tx,scope:CatalogScope,releaseId:string):Promise<ResourceVersion[]>{
 return (await tx.query("SELECT kind,key,version,id FROM configuration_versions WHERE organization_id=$1 AND application_id=$2 AND file_source->>'release_id'=$3 UNION ALL SELECT 'recipe',key,version,id FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND file_source->>'release_id'=$3 UNION ALL SELECT 'tariff',key,version,id FROM provider_tariff_versions WHERE organization_id=$1 AND application_id=$2 AND file_source->>'release_id'=$3",[scope.organization_id,scope.application_id,releaseId])).rows;
}
/** Must run inside transaction(). All dependencies and the release commit together. */
export async function publishConfiguration(tx:Tx,scope:CatalogScope,value:unknown,bindingsValue:unknown,provenanceValue:Provenance,clock:Clock=systemClock){
 const document=parseConfiguration(value),bindings=bindingsSchema.parse(bindingsValue),provenance=provenanceSchema.parse(provenanceValue);
 await lock(tx,scope);
 const digest=hash({document,bindings});
 const previous=(await tx.query('SELECT * FROM configuration_releases WHERE organization_id=$1 AND application_id=$2 AND bundle_key=$3 AND digest=$4',[scope.organization_id,scope.application_id,document.bundle_key,digest])).rows[0];
 if(previous)return {...previous,reused:true,resources:await releaseResources(tx,scope,previous.id)};
 const history=(await tx.query('SELECT document FROM configuration_releases WHERE organization_id=$1 AND application_id=$2 AND bundle_key=$3',[scope.organization_id,scope.application_id,document.bundle_key])).rows;
 // Removing/renaming owned keys requires a later explicit migration, never silent orphaning.
 const keys=document.resources.map(r=>`${r.kind}:${r.key}`).sort();
 if(history.some(r=>hash(r.document.resources.map((v:any)=>`${v.kind}:${v.key}`).sort())!==hash(keys)))throw new DomainError('configuration_resource_set_changed','Keep the existing resource keys; use a separate bundle for a new profile.',422);
 const releaseId=id('release');
 await tx.query('INSERT INTO configuration_releases(id,organization_id,application_id,bundle_key,digest,document,bindings,provenance,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[releaseId,scope.organization_id,scope.application_id,document.bundle_key,digest,document,bindings,provenance,clock.now()]);
 const resolved:Record<string,string>={},resources:ResourceVersion[]=[];
 const reference=(value:unknown,kind:string)=>{
  if(typeof value!=='string'||!value.startsWith(`@${kind}:`))throw new DomainError('invalid_configuration_reference',`Expected @${kind}:key reference.`,422);
  const name=value.slice(kind.length+2),result=kind==='connection'?bindings.connections[name]:kind==='budget'?bindings.budgets[name]:resolved[`${kind}:${name}`];
  if(!result)throw new DomainError('configuration_reference_missing',`${kind}:${name}`,422);return result;
 };
 for(const resource of [...document.resources].sort((a,b)=>priority[a.kind]-priority[b.kind])){
  const table=resource.kind==='recipe'?'recipe_versions':resource.kind==='tariff'?'provider_tariff_versions':'configuration_versions';
  const version=1+Number((await tx.query(`SELECT COALESCE(MAX(version),0) version FROM ${table} WHERE organization_id=$1 AND application_id=$2 AND key=$3 ${['recipe','tariff'].includes(resource.kind)?'':'AND kind=$4'}`,['recipe','tariff'].includes(resource.kind)?[scope.organization_id,scope.application_id,resource.key]:[scope.organization_id,scope.application_id,resource.key,resource.kind])).rows[0].version);
  const payload=structuredClone(resource.payload) as any;
  if(resource.kind==='catalog'){
   if(!Array.isArray(payload.models))throw new DomainError('invalid_catalog');
   for(const model of (payload as CatalogDefinition).models){
    if(!model.adapter_ref)throw new DomainError('adapter_reference_required');adapterDefinition(model.adapter_ref,model.provider,model.capabilities);
    if(model.rate_card_version_id)model.rate_card_version_id=reference(model.rate_card_version_id,'rate_card');
   }
  }
  if(resource.kind==='route'){
   if(payload.execution_policy_version_id)payload.execution_policy_version_id=reference(payload.execution_policy_version_id,'execution_policy');
   if(!payload.primary)throw new DomainError('invalid_route');
   for(const target of [payload.primary,...(payload.fallback?[payload.fallback]:[])] as RouteDefinition['primary'][]){
    target.catalog_version_id=reference(target.catalog_version_id,'catalog');target.connection_id=reference(target.connection_id,'connection');
    const connection=(await tx.query('SELECT provider FROM provider_connections WHERE id=$1 AND organization_id=$2 AND application_id=$3',[target.connection_id,scope.organization_id,scope.application_id])).rows[0];
    const catalog=await new CatalogService(tx,clock).get(scope,target.catalog_version_id);
    const model=(catalog.payload as CatalogDefinition).models.find(m=>m.id===target.model);
    if(!connection||connection.provider!==model?.provider)throw new DomainError('incompatible_connection','Connection must belong to this application and match the model provider.',422);
   }
  }
  if(resource.kind==='recipe'){
   if('key' in payload||'version' in payload||'actor_id' in payload)throw new DomainError('reserved_recipe_field');
   payload.period_budget_key=reference(payload.period_budget_key,'budget');
   if(!Array.isArray(payload.components))throw new DomainError('invalid_recipe');
   for(const c of payload.components){c.route_version_id=reference(c.route_version_id,'route');c.rate_card_version_id=reference(c.rate_card_version_id,'rate_card');}
  }
  const fileSource:FileSource={...provenance,schema_version:1,bundle_key:document.bundle_key,release_id:releaseId,dependencies:{...resolved}};
  let published:{id:string};
  if(resource.kind==='tariff'){
   validateTariff(payload);if(payload.key!==resource.key)throw new DomainError('tariff_key_mismatch');
   const owner=(await tx.query('SELECT file_source FROM provider_tariff_versions WHERE organization_id=$1 AND application_id=$2 AND key=$3 LIMIT 1',[scope.organization_id,scope.application_id,resource.key])).rows[0];
   if(owner&&owner.file_source.bundle_key!==document.bundle_key)throw new DomainError('file_managed_configuration');
   published=(await tx.query('INSERT INTO provider_tariff_versions(id,organization_id,application_id,key,version,definition,file_source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[id('tariff'),scope.organization_id,scope.application_id,resource.key,version,payload,fileSource,clock.now()])).rows[0];
  }else if(resource.kind==='recipe')published=await publishRecipe(tx,{...scope,account_id:'system'},clock,{...payload,key:resource.key,version,actor_id:provenance.publisher} as RecipeDefinition,fileSource);
  else{
   const catalog=new CatalogService(tx,clock,fileSource);
   const draft=await catalog.createDraft(scope,{kind:resource.kind as ConfigurationKind,key:resource.key,version,display_name:resource.display_name,payload:payload as ConfigurationPayload,author:provenance.publisher,comment:`Git: ${provenance.path} @ ${provenance.git_revision}`});
   published=await catalog.publish(scope,draft.id,draft.revision,('samples' in resource?resource.samples:[]) as unknown as PublishSample[]);
  }
  resolved[`${resource.kind}:${resource.key}`]=published.id;resources.push({kind:resource.kind,key:resource.key,version,id:published.id});
 }
 return {id:releaseId,bundle_key:document.bundle_key,digest,reused:false,resources};
}
export async function activateConfiguration(tx:Tx,scope:CatalogScope,releaseId:string,expectedRevision:number,actor:string){
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!actor.trim())throw new DomainError('invalid_activation');
 await lock(tx,scope);
 const release=(await tx.query('SELECT * FROM configuration_releases WHERE id=$1 AND organization_id=$2 AND application_id=$3',[releaseId,scope.organization_id,scope.application_id])).rows[0];
 if(!release)throw new DomainError('not_found','Configuration release not found',404);
 // Fail before switching if the deployed adapter registry no longer supports the snapshot.
 const models=(await tx.query("SELECT payload FROM configuration_versions WHERE organization_id=$1 AND application_id=$2 AND file_source->>'release_id'=$3 AND kind='catalog'",[scope.organization_id,scope.application_id,releaseId])).rows;
 for(const row of models)for(const model of row.payload.models)adapterDefinition(model.adapter_ref,model.provider,model.capabilities);
 const old=(await tx.query('SELECT * FROM configuration_activations WHERE organization_id=$1 AND application_id=$2 AND bundle_key=$3',[scope.organization_id,scope.application_id,release.bundle_key])).rows[0];
 if(old?.release_id===releaseId&&old.revision===expectedRevision+1&&old.actor_id===actor)return old;
 if((old?.revision??0)!==expectedRevision)throw new DomainError('revision_conflict','Activation changed; inspect the current revision.',409);
 if(old?.release_id===releaseId)return old;
 const values=[scope.organization_id,scope.application_id,release.bundle_key,releaseId,expectedRevision+1,actor];
 const result=(await tx.query('INSERT INTO configuration_activations(organization_id,application_id,bundle_key,release_id,revision,actor_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,application_id,bundle_key) DO UPDATE SET release_id=EXCLUDED.release_id,revision=EXCLUDED.revision,actor_id=EXCLUDED.actor_id,activated_at=now() RETURNING *',values)).rows[0];
 await tx.query('INSERT INTO configuration_activation_history(organization_id,application_id,bundle_key,release_id,revision,actor_id) VALUES($1,$2,$3,$4,$5,$6)',values);
 return result;
}
