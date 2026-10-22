import {isAlternativeProvider,alternativeModel,alternativeFeatures} from '../../providers/src/alternative-models.js';
import {RECRAFT_STYLES,RECRAFT_VECTORIZE,QUIVER_MODELS} from '../../providers/src/svg-input.js';
import {embeddingModel,embeddingInstallationLimits} from '../../providers/src/embeddings.js';
import {TextFeatures} from '../../contracts/invocation.js';
import type {z} from 'zod';
import {resolveExecutionPolicy,type ExecutionPolicy,type ExecutionOverrides} from '../../contracts/invocation.js';
import {validateServiceOperation,validateApiSamples,type ServiceOperation} from '../../api-services/src/index.js';
import {assertDatabaseManaged,activeFileReleases,type FileSource} from '../../configuration/src/ownership.js';
import {adapterDefinition} from '../../providers/src/registry.js';
import {validateModelCalculation,validateModelRateCoverage,validateModelPriceSamples,priceModel,normalizeParameters,type ModelCalculation,type CalculationInput} from '../../model-pricing/src/index.js';
import {verifyPublicationCoverage} from './coverage.js';
import { DomainError, id, systemClock, type Clock } from '../../contracts/src/index.js';
import type { SqlExecutor } from '../../db/src/index.js';
import { rateUsage, getAttemptUsage, validateRateCard, type RateCard, type RatingContext } from '../../pricing/src/index.js';
import type { Capability, NormalizedUsage } from '../../providers/src/contracts.js';
import {providerParameters,registeredHttpProvider} from '../../providers/src/parameters.js';
export type CatalogScope={organization_id:string;application_id:string};
export interface ModelDefinition { preview?:boolean; live_validation?:'not_run'|'passed'|'failed';  text_features?:z.infer<typeof TextFeatures>; api?:ServiceOperation; id:string; provider:string; adapter_ref?:string; capabilities:Capability[]; allowed_parameters:string[]; status:'active'|'disabled'; identity_kind?:'snapshot'|'alias'; calculation?:ModelCalculation; rate_card_version_id?:string }
export interface CatalogDefinition { models:ModelDefinition[] }
export interface RouteTarget { service_mode?:'standard';  catalog_version_id:string; model:string; connection_id:string; max_cost_units:string; limiter_key?:string }
export interface RouteDefinition { execution_policy_version_id?:string; capability:Capability; primary:RouteTarget; fallback?:RouteTarget; execution?:ExecutionOverrides; deadline_seconds?:number; platform_risk_budget_units:string }
export type ConfigurationKind='catalog'|'route'|'rate_card'|'execution_policy';
export type ConfigurationPayload=CatalogDefinition|RouteDefinition|RateCard|ExecutionPolicy;
export interface ConfigurationVersion { file_source?:FileSource|null; file_active?:boolean; id:string;organization_id:string;application_id:string;kind:ConfigurationKind;key:string;display_name:string|null;version:number;revision:number;status:'draft'|'published';payload:ConfigurationPayload;author:string;comment:string;created_at:Date;published_at:Date|null }
export interface PublishSample { usage:NormalizedUsage; context:RatingContext }
function displayName(value:string) {
  const name=value.trim();
  if(!name || [...name].length>200) throw new DomainError('invalid_display_name','Name must contain 1 to 200 characters.',422);
  return name;
}
const validUnits=(v:string)=>typeof v==='string' && /^(0|[1-9]\d*)$/.test(v);
export function validateCatalog(catalog:CatalogDefinition) {
  if(!Array.isArray(catalog.models) || !catalog.models.length) throw new DomainError('invalid_catalog');
  const ids=new Set<string>();
  for(const m of catalog.models) {
    if(!m||!Array.isArray(m.capabilities))throw new DomainError('invalid_model');
    if(m.provider==='quiver'&&(!QUIVER_MODELS.includes(m.id)||m.capabilities.some(c=>!['image.generate','image.vectorize'].includes(c))))throw new DomainError('unsupported_svg_model');
    if(m.provider==='replicate'&&(![...RECRAFT_STYLES,RECRAFT_VECTORIZE].includes(m.id)||m.capabilities.some(c=>c!==(m.id===RECRAFT_VECTORIZE?'image.vectorize':'image.generate'))))throw new DomainError('unsupported_svg_model');
    if(isAlternativeProvider(m.provider)){const registered=alternativeModel(m.provider,m.id);if(m.adapter_ref!==`${m.provider}@1`||m.capabilities.length!==1||m.capabilities[0]!=='text.generate'||m.preview!==registered.preview||JSON.stringify(Object.entries(m.text_features??{}).sort())!==JSON.stringify(Object.entries(alternativeFeatures(m.provider,m.id)).sort()))throw new DomainError('invalid_model_capabilities');}
    if(m.text_features)TextFeatures.parse(m.text_features);
    if(m.capabilities.includes('embeddings.generate')&&embeddingModel(m.id).provider!==m.provider)throw new DomainError('unsupported_embedding_model');
    if(!m.id || ids.has(m.id) || !m.provider || !m.capabilities.length || m.capabilities.some(c=>!['embeddings.generate','text.generate','image.generate','image.vectorize','speech.synthesize','search','api.call'].includes(c)) || !Array.isArray(m.allowed_parameters) || !['active','disabled'].includes(m.status)) throw new DomainError('invalid_model');
    if(m.identity_kind!==undefined&&!['snapshot','alias'].includes(m.identity_kind))throw new DomainError('invalid_model_identity');
    if(m.adapter_ref)adapterDefinition(m.adapter_ref,m.provider,m.capabilities);
    if(m.api){validateServiceOperation(m.api);if(m.calculation||!m.rate_card_version_id||m.api.key!==m.id||m.api.provider!==m.provider||m.api.adapter_ref!==m.adapter_ref||m.capabilities.length!==1||m.capabilities[0]!=='api.call')throw new DomainError('invalid_api_operation');}
    if(m.capabilities.includes('api.call')&&!m.api)throw new DomainError('api_operation_required');
    if(m.calculation){
      validateModelCalculation(m.calculation);
      if(!m.rate_card_version_id)throw new DomainError('model_rate_card_required');
      if(Object.keys(m.calculation.parameters).some(key=>!m.allowed_parameters.includes(key)))throw new DomainError('unsupported_calculation_parameter');
      if(registeredHttpProvider(m.provider))for(const capability of m.capabilities){
        const allowed=providerParameters(m.provider,capability);
        if(!allowed)throw new DomainError('unsupported_calculation_capability','The provider adapter does not support this capability.',422);
        for(const key of m.allowed_parameters){
          if((key==='max_output_tokens'||key==='expected_output_tokens')&&capability==='text.generate')continue;
          // Execution currently requests one image and strips its internal count field.
          if(key==='count'&&capability==='image.generate'){
            const count=m.calculation.parameters.count;
            if(count?.type==='number'&&(count.values?.length===1&&count.values[0]===1||count.minimum===1&&count.maximum===1))continue;
          }
          if(!allowed.includes(key))throw new DomainError('unsupported_calculation_parameter',`The ${m.provider} ${capability} adapter does not support parameter ${key}. Paid tools need an adapter, usage rules and enforced limits before publication.`,422);
        }
      }
    }
    ids.add(m.id);
  }
}
/** Public clients receive execution settings only; cost rules and markup stay administrative. */
export function publicCatalog(version:ConfigurationVersion) {
 const catalog=version.payload as CatalogDefinition;
 return {id:version.id,key:version.key,version:version.version,status:version.status,payload:{models:catalog.models.map(model=>({id:model.id,provider:model.provider,preview:model.preview,live_validation:model.live_validation,...(model.capabilities.includes('embeddings.generate')?{embedding_features:{...embeddingModel(model.id),installation_limits:embeddingInstallationLimits}}:{}),text_features:model.text_features,capabilities:model.capabilities,allowed_parameters:model.allowed_parameters,status:model.status,...(model.calculation?{parameters:model.calculation.parameters,preparation:model.calculation.preparation}:{})}))}};
}
export function validateRoute(route:RouteDefinition) {
  if([route.primary,route.fallback].some(t=>t?.service_mode!==undefined&&t.service_mode!=='standard'))throw new DomainError('unsupported_service_mode');
  if(!route.primary || !validUnits(route.platform_risk_budget_units)) throw new DomainError('invalid_route');
  resolveExecutionPolicy(route.execution,route.deadline_seconds===undefined?undefined:{deadline_seconds:route.deadline_seconds});
  for(const t of [route.primary,...(route.fallback?[route.fallback]:[])]) if(!t.catalog_version_id || !t.model || !t.connection_id || !validUnits(t.max_cost_units) || (t.limiter_key!==undefined && !/^[a-zA-Z0-9_.:-]{1,200}$/.test(t.limiter_key))) throw new DomainError('invalid_route_target');
}
export class CatalogService {
  constructor(private db:SqlExecutor,private clock:Clock=systemClock,private fileSource:FileSource|null=null) {}
  async createDraft(scope:CatalogScope,input:{kind:ConfigurationKind;key:string;version:number;payload:ConfigurationPayload;author:string;comment:string;display_name?:string}) {
    if(!input.key || !input.author || !Number.isSafeInteger(input.version) || input.version<1) throw new DomainError('invalid_configuration');
    if(!this.fileSource)await assertDatabaseManaged(this.db,scope,input.kind,input.key);
    const result=await this.db.query<ConfigurationVersion>('INSERT INTO configuration_versions(id,organization_id,application_id,kind,key,version,payload,author,comment,created_at,display_name,file_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[id('cfg'),scope.organization_id,scope.application_id,input.kind,input.key,input.version,JSON.stringify(input.payload),input.author,input.comment,this.clock.now(),input.display_name===undefined?null:displayName(input.display_name),this.fileSource]);
    return result.rows[0];
  }
  async get(scope:CatalogScope,versionId:string) { const result=await this.db.query<ConfigurationVersion>('SELECT * FROM configuration_versions WHERE id=$1 AND organization_id=$2 AND application_id=$3',[versionId,scope.organization_id,scope.application_id]); if(!result.rows[0]) throw new DomainError('not_found','Configuration not found',404);return result.rows[0]; }
  async list(scope:CatalogScope,kind?:ConfigurationKind) {
    const rows=(await this.db.query<ConfigurationVersion>('SELECT * FROM configuration_versions WHERE organization_id=$1 AND application_id=$2 AND ($3::text IS NULL OR kind=$3) ORDER BY key,version DESC',[scope.organization_id,scope.application_id,kind??null])).rows;
    const active=await activeFileReleases(this.db,scope);
    return rows.map(row=>row.file_source?{...row,file_active:active.has(row.file_source.release_id)}:row);
  }
  async updateDraft(scope:CatalogScope,versionId:string,revision:number,payload:ConfigurationPayload,comment:string,display_name?:string) {
    const managed=await this.db.query('SELECT 1 FROM configuration_versions WHERE id=$1 AND organization_id=$2 AND application_id=$3 AND file_source IS NOT NULL',[versionId,scope.organization_id,scope.application_id]);
    if(managed.rowCount)throw new DomainError('file_managed_configuration','Edit the Git definition and publish a new release.',409);
    const result=await this.db.query<ConfigurationVersion>("UPDATE configuration_versions SET payload=$1,comment=$2,display_name=COALESCE($7,display_name),revision=revision+1 WHERE id=$3 AND organization_id=$4 AND application_id=$5 AND revision=$6 AND status='draft' RETURNING *",[JSON.stringify(payload),comment,versionId,scope.organization_id,scope.application_id,revision,display_name===undefined?null:displayName(display_name)]);
    if(!result.rows[0]) throw new DomainError('revision_conflict');return result.rows[0];
  }
  async renameRateCard(scope:CatalogScope,versionId:string,revision:number,name:string) {
    const managed=await this.db.query('SELECT 1 FROM configuration_versions WHERE id=$1 AND organization_id=$2 AND application_id=$3 AND file_source IS NOT NULL',[versionId,scope.organization_id,scope.application_id]);
    if(managed.rowCount)throw new DomainError('file_managed_configuration','Edit the Git definition and publish a new release.',409);
    const result=await this.db.query<ConfigurationVersion>("UPDATE configuration_versions SET display_name=$1,revision=revision+1 WHERE id=$2 AND organization_id=$3 AND application_id=$4 AND revision=$5 AND kind='rate_card' RETURNING *",[displayName(name),versionId,scope.organization_id,scope.application_id,revision]);
    if(!result.rows[0]) throw new DomainError('revision_conflict','Pricing changed. Refresh and try again.');
    return result.rows[0];
  }
  async previewModel(scope:CatalogScope,input:({catalog_version_id:string;model:string}|{calculation:ModelCalculation;rate_card_version_id:string;model:string})&{input:CalculationInput}) {
    let calculation:ModelCalculation,rateId:string;
    if('catalog_version_id' in input){
      const version=await this.get(scope,input.catalog_version_id);
      if(version.kind!=='catalog')throw new DomainError('invalid_catalog');
      const model=(version.payload as CatalogDefinition).models.find(m=>m.id===input.model);
      if(!model?.calculation||!model.rate_card_version_id)throw new DomainError('model_calculation_missing');
      calculation=model.calculation;rateId=model.rate_card_version_id;
    }else{calculation=input.calculation;rateId=input.rate_card_version_id}
    const rates=await this.get(scope,rateId);
    if(rates.kind!=='rate_card')throw new DomainError('invalid_rate_card');
    const price=priceModel(calculation,input.input,rates.payload as RateCard,{at:this.clock.now().toISOString(),conditions:{model:input.model}},{checkSamples:false});
    return {model:input.model,rate_card_version_id:rates.id,...price,normalized_input:{input:input.input.input,parameters:normalizeParameters(calculation,input.input.parameters),assets:input.input.assets}};
  }
  async compareRates(scope:CatalogScope,input:{before_version_id:string;after_version_id:string;effective_at:string;baseline_at?:string;attempt_ids?:string[]}) {
    const baseline=input.baseline_at??this.clock.now().toISOString();if(!Number.isFinite(Date.parse(input.effective_at))||!Number.isFinite(Date.parse(baseline)))throw new DomainError('invalid_rating_time');
    if(input.attempt_ids&&(!Array.isArray(input.attempt_ids)||input.attempt_ids.length<1||input.attempt_ids.length>100||input.attempt_ids.some(v=>typeof v!=='string'||!v)))throw new DomainError('invalid_samples');
    const before=await this.get(scope,input.before_version_id),after=await this.get(scope,input.after_version_id);if(before.kind!=='rate_card'||after.kind!=='rate_card')throw new DomainError('invalid_rate_card');validateRateCard(before.payload as RateCard);validateRateCard(after.payload as RateCard);
    const samples=(await this.db.query('SELECT * FROM (SELECT DISTINCT ON(account_id,attempt_id) account_id,attempt_id,connection_id,model,observed_at FROM provider_usage_observations WHERE organization_id=$1 AND application_id=$2 AND ($3::text[] IS NULL OR attempt_id=ANY($3)) ORDER BY account_id,attempt_id,observed_at DESC) samples ORDER BY observed_at DESC LIMIT 100',[scope.organization_id,scope.application_id,input.attempt_ids??null])).rows;
    if(input.attempt_ids&&new Set(samples.map(s=>s.attempt_id)).size!==new Set(input.attempt_ids).size)throw new DomainError('not_found','Saved usage sample not found',404);
    let oldTotal=0n,newTotal=0n;let unknown=0;const data=[];
    const safe=(r:ReturnType<typeof rateUsage>)=>r.state==='calculated'?{state:r.state,exact_usd:r.exact_amount,units:r.rounded_units.toString(),items:r.items}:{state:r.state,reason:r.reason};
    for(const sample of samples){const usage=await getAttemptUsage(this.db,{...scope,account_id:sample.account_id},sample.attempt_id);const context={connection_id:sample.connection_id,conditions:{model:sample.model}};const a=rateUsage(usage,before.payload as RateCard,{...context,at:baseline});const b=rateUsage(usage,after.payload as RateCard,{...context,at:input.effective_at});const known=a.state==='calculated'&&b.state==='calculated';if(known){oldTotal+=a.rounded_units;newTotal+=b.rounded_units}else unknown++;data.push({attempt_id:sample.attempt_id,model:sample.model,connection_id:sample.connection_id,before:safe(a),after:safe(b),delta_units:known?(b.rounded_units-a.rounded_units).toString():null});}
    return {before_version_id:before.id,after_version_id:after.id,baseline_at:baseline,effective_at:input.effective_at,sample_count:data.length,unknown_count:unknown,before_units:oldTotal.toString(),after_units:newTotal.toString(),delta_units:(newTotal-oldTotal).toString(),totals_scope:'samples_known_in_both_versions',data};
  }
  async publish(scope:CatalogScope,versionId:string,revision:number,samples:PublishSample[] = []) {
    const version=await this.get(scope,versionId);
    if(version.status!=='draft'||version.revision!==revision) throw new DomainError('revision_conflict');
    if(version.kind==='execution_policy'){if(!version.file_source)throw new DomainError('file_configuration_required');resolveExecutionPolicy(undefined,undefined,undefined,version.payload);}
    if(version.kind==='catalog') {
      validateCatalog(version.payload as CatalogDefinition);
      for(const model of (version.payload as CatalogDefinition).models)if(model.api){const rates=await this.get(scope,model.rate_card_version_id!);if(rates.kind!=='rate_card'||rates.status!=='published')throw new DomainError('model_rate_card_required');validateApiSamples(model.api,rates.payload as RateCard,{at:this.clock.now().toISOString()});}
      for(const model of (version.payload as CatalogDefinition).models)if(model.calculation){
        const rates=await this.get(scope,model.rate_card_version_id!);
        if(rates.kind!=='rate_card'||rates.status!=='published')throw new DomainError('unpublished_rate_card');
        validateModelRateCoverage(model.calculation,rates.payload as RateCard,{at:this.clock.now().toISOString(),conditions:{model:model.id}});
        validateModelPriceSamples(model.calculation,rates.payload as RateCard,{at:this.clock.now().toISOString(),conditions:{model:model.id}});
      }
    }
    if(version.kind==='route') {
      const route=version.payload as RouteDefinition; validateRoute(route);
      if(route.execution_policy_version_id){const policy=await this.get(scope,route.execution_policy_version_id);if(policy.kind!=='execution_policy'||policy.status!=='published')throw new DomainError('unpublished_execution_policy');resolveExecutionPolicy(route.execution,undefined,undefined,policy.payload);}
      for(const target of [route.primary,...(route.fallback?[route.fallback]:[])]) {
        const catalog=await this.get(scope,target.catalog_version_id);
        if(catalog.kind!=='catalog'||catalog.status!=='published') throw new DomainError('unpublished_catalog');
        const model=(catalog.payload as CatalogDefinition).models.find(m=>m.id===target.model);
        if(model?.provider==='google_cloud'&&target.service_mode!=='standard'||model?.provider!=='google_cloud'&&target.service_mode!==undefined)throw new DomainError('unsupported_service_mode');
        if(!model || model.status!=='active' || !model.capabilities.includes(route.capability)) throw new DomainError('incompatible_route');
      }
    }
    if(version.kind==='rate_card') {
      const card=version.payload as RateCard;validateRateCard(card);
      if(!samples.length) throw new DomainError('pricing_samples_required');
      for(const sample of samples) if(rateUsage(sample.usage,card,sample.context).state!=='calculated') throw new DomainError('rate_coverage_missing');
      await verifyPublicationCoverage(this.db,scope,version,this.clock);
    }
    const result=await this.db.query<ConfigurationVersion>("UPDATE configuration_versions SET status='published',published_at=$1,revision=revision+1 WHERE id=$2 AND organization_id=$3 AND application_id=$4 AND revision=$5 AND status='draft' RETURNING *",[this.clock.now(),versionId,scope.organization_id,scope.application_id,revision]);
    if(!result.rows[0]) throw new DomainError('revision_conflict');return result.rows[0];
  }
}
