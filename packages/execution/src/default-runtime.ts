import {rateUsage} from '../../pricing/src/index.js';
import {isAlternativeProvider,alternativeFeatures} from '../../providers/src/alternative-models.js';
import {validateTextFeatures} from '../../providers/src/text-input.js';
import {inputAssetIds} from '../../storage/src/index.js';
import {apiLimitUsage} from '../../providers/src/api-limit-usage.js';
import {createRegisteredAdapter,adapterDefinition} from '../../providers/src/registry.js';
import {imageQuotaEstimate} from './image-quota-estimate.js';
import {createBlobStore} from '../../storage/src/blob-store.js';
import type pg from 'pg';
import { transaction, emit } from '../../db/src/index.js';
import { hash, systemClock, DomainError, type Clock } from '../../contracts/src/index.js';
import { getExecutionContext, getSettlementContext, settleRequest } from '../../quoting/src/index.js';
import { FakeAdapter, type ProviderInput, type AdapterContext, type FakeScenario } from '../../providers/src/index.js';
import { ConnectionService, CredentialVault } from '../../reconciliation/src/connections.js';
import { getAsset } from '../../storage/src/index.js';
import type { WorkerDependencies, WorkContext } from './runtime.js';
class FixtureAdapter extends FakeAdapter {
 constructor(private scenario:FakeScenario){super([scenario]);}
 override async execute(input:ProviderInput,context:AdapterContext){if(this.scenario.text&&context.onDelta)for(const part of this.scenario.text.match(/.{1,28}/gu)??[])await context.onDelta(part);return super.execute(input,context);}
}
function fixture(input:ProviderInput):FakeScenario {
 if(input.capability.startsWith('image.')){const palette=['#596bd8','#ad653e','#358573','#825594'];const color=palette[parseInt(hash(input.input).slice(0,2),16)%palette.length];const dimensions=String(input.parameters?.size??'1024x1024').match(/^(\d+)x(\d+)$/);const width=dimensions?.[1]??'1024',height=dimensions?.[2]??'1024';const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 512 512"><rect width="512" height="512" fill="#f1eee8"/><circle cx="256" cy="220" r="132" fill="${color}"/><path d="M160 280L256 116L352 280Z" fill="#f1eee8"/><circle cx="256" cy="242" r="42" fill="${color}"/><text x="256" y="425" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#47443e">UAI · fixture image</text></svg>`;return {outcome:'success',bytes:Buffer.from(svg),content_type:'image/svg+xml',usage:{state:'known',items:[{dimension:'output.image',quantity:'1',unit:'images',conditions:{size:String(input.parameters?.size??'1024x1024'),quality:String(input.parameters?.quality??'standard')}}]}};}
 if(input.tools){const tool=input.tools.find(tool=>input.tool_choice?.type==='named'&&tool.name===input.tool_choice.name)??input.tools[0];const args=schemaFixture(tool.parameters) as Record<string,unknown>;return {outcome:'success',text:JSON.stringify(args),content_type:'application/json',tool_call:{id:'fixture-call',name:tool.name,arguments:args}};}
 if(input.response_schema)return {outcome:'success',text:JSON.stringify(schemaFixture(input.response_schema.schema)),content_type:'application/json'};
 return {outcome:'success',text:'Это детерминированный тестовый ответ UAI. Запрос прошёл очередь, сохранение usage и расчёт стоимости. Реальный провайдер не вызывался.'};
}
function schemaFixture(s:any):unknown {if(s.enum)return s.enum[0];switch(s.type){case 'object':return Object.fromEntries(Object.entries(s.properties??{}).map(([k,v])=>[k,schemaFixture(v)]));case 'array':return Array.from({length:s.minItems??0},()=>schemaFixture(s.items));case 'string':return 'fixture'.padEnd(s.minLength??0,'x').slice(0,s.maxLength??Infinity);case 'number':case 'integer':return s.minimum??0;case 'boolean':return true;default:return null;}}
export function defaultRuntime(pool:pg.Pool,clock:Clock=systemClock):WorkerDependencies {
 const blobStore=createBlobStore();
 const key=process.env.UAI_VAULT_KEY;const vault=key?new CredentialVault(Buffer.from(key,'base64')):undefined;
 const connections=new ConnectionService(pool,clock,vault);
 return {
  blobStore,
  async variantAvailable(tx,scope,variant){const connection=await new ConnectionService(tx,clock,vault).get(scope,variant.connection_id);return connection.status==='enabled'&&connection.credential_status!=='invalid';},
  async onConnectionFailure(scope,variant,kind){await transaction(pool,async tx=>{const service=new ConnectionService(tx,clock,vault);const c=await service.get(scope,variant.connection_id);if(kind==='auth')await service.recordHealth(scope,c.id,c.revision,'auth_failed',{actor_id:'worker',reason:'Provider rejected credentials'});else if(c.status!=='locked')await service.setStatus(scope,c.id,c.revision,'locked',{actor_id:'worker',reason:'Provider reported exhausted quota or billing budget'});await emit(tx,scope,kind==='auth'?'provider.auth_failed':'provider.budget_exhausted',{type:'connection',id:c.id},{reason:kind});});},
  settle:(tx,scope,input)=>settleRequest(tx,scope,clock,input),
  async context(scope,request,variant):Promise<WorkContext>{
   const c=await getExecutionContext(pool,scope,clock,request.id,variant);const p=c.payload;
   const provider=variant.adapter_ref?.split('@')[0]??'';
   if(isAlternativeProvider(provider)){const features=alternativeFeatures(provider,variant.model);const dimensions=['input.uncached','output.text',...(features.cache==='automatic'?['input.cache_read']:[])];const rating=rateUsage({state:'known',items:dimensions.map(dimension=>({dimension,quantity:'1',unit:'tokens'}))},c.current_rate_card,{at:clock.now().toISOString(),connection_id:variant.connection_id,conditions:{model:variant.model,...(variant.service_mode?{service_mode:variant.service_mode}:{})}});if(rating.state!=='calculated')throw new DomainError('pricing_unavailable','Current model rates are missing or expired',422);}
  const executionParameters=variant.execution_parameters??p.parameters??{};const params={...executionParameters};delete params.max_output_tokens;delete params.expected_output_tokens;delete params.count;
   const input:ProviderInput={...(p.input.tools&&variant.text_features&&(variant.text_features.forced_tool_choice===false||!variant.text_features.tools)?{tool_execution:'schema' as const}:{}),...(c.component.pricing_mode==='estimated_actual'?{output_limit_policy:'provider_default' as const}:{}),stream:request.route?.delivery?.stream??false,service_mode:variant.service_mode,parallel_tool_calls:p.input.parallel_tool_calls,capability:p.kind,model:variant.model,input:p.input.text??p.input.prompt??p.input.query??'',parameters:params,...(p.input.texts?{texts:p.input.texts}:{}),...(p.input.messages?{messages:p.input.messages}:{}),...(p.input.tools?{tools:p.input.tools,tool_choice:p.input.tool_choice}:{}),...(p.input.instructions?{instructions:p.input.instructions}:{}),...(executionParameters.max_output_tokens?{max_output_tokens:executionParameters.max_output_tokens}:{}),...(p.input.response_schema?{response_schema:{name:'result',schema:p.input.response_schema}}:{})};
   if(c.component.api_snapshot){input.api_operation=c.component.api_snapshot.definition;const {asset_ids,...structured}=p.input;input.structured=structured;}
   if(p.prepared_api_assets?.length)input.assets=p.prepared_api_assets.map((a:any)=>({content_type:a.content_type,bytes:Buffer.from(a.base64,'base64'),filename:a.id}));
   if(p.input.voice)input.parameters={...input.parameters,voice:p.input.voice};
   if(p.prepared_assets?.length){input.assets=p.prepared_assets.map((a:any)=>({content_type:a.content_type,bytes:Buffer.from(a.base64,'base64'),filename:a.id}));}
   else if(!input.assets&&inputAssetIds(p.input).length){input.assets=[];for(const assetId of inputAssetIds(p.input)){const a=await getAsset(pool,scope,clock,assetId,true,request.id);input.assets.push({content_type:a.media_type,bytes:await blobStore.get(a.blob_key),filename:a.id});}}
   const snapshot=c.component.calculation_snapshot;
   const limit_usage_estimate=c.component.api_snapshot?apiLimitUsage(c.component.api_snapshot.measurements):input.capability==='image.generate'&&snapshot?.model===variant.model
    ?imageQuotaEstimate(variant.model,snapshot.breakdown,c.accepted_rate_card,{at:new Date(c.accepted_at).toISOString(),connection_id:variant.connection_id,conditions:{...Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)])),...c.component.conditions,model:variant.model}}):undefined;
   return {input,api_snapshot:c.component.api_snapshot,limit_usage_estimate,expected_output_tokens:p.parameters?.expected_output_tokens,accepted_rate_card:c.accepted_rate_card,current_rate_card:c.current_rate_card,accepted_at:new Date(c.accepted_at).toISOString(),maximum_items:variant.maximum_items??c.component.maximum_items,price_increase_allowed:!!c.component.calculation_snapshot,conditions:c.component.calculation_snapshot?{...c.component.conditions,model:variant.model}:c.component.conditions};
  },
  async observationContext(scope,request,attempt):Promise<WorkContext>{
   const c=await getSettlementContext(pool,scope,clock,request.id,attempt.variant);
   return {api_snapshot:c.component.api_snapshot,input:{input:'',model:attempt.variant.model,capability:c.component.capability,...(c.component.api_snapshot?{api_operation:c.component.api_snapshot.definition}:{}),...(attempt.native_validation??{})},accepted_rate_card:c.accepted_rate_card,current_rate_card:c.current_rate_card,accepted_at:new Date(c.accepted_at).toISOString(),maximum_items:attempt.variant.maximum_items??c.component.maximum_items,price_increase_allowed:!!c.component.calculation_snapshot,conditions:c.component.calculation_snapshot?{...c.component.conditions,model:attempt.variant.model}:c.component.conditions};
  },
  async adapter(scope,variant,context){
   const c=await connections.get(scope,variant.connection_id);if(c.status!=='enabled')throw new DomainError('connection_disabled');
   if(variant.adapter_ref)adapterDefinition(variant.adapter_ref,c.provider,[context.input.capability]);
   if(c.provider==='fake')return new FixtureAdapter(fixture(context.input));
   if(context.input.capability==='text.generate')validateTextFeatures(variant.text_features,context.input);
   if(process.env.UAI_ALLOW_REAL_PROVIDERS!=='true')throw new DomainError('real_providers_disabled','Real providers require explicit server configuration',503);
   const apiKey=await connections.resolveCredential(scope,variant.connection_id);const options={apiKey,googleProject:c.account_scope.project,googleLocation:c.account_scope.location,models:[variant.model],maxInputTokens:Number(c.limits.max_input_tokens)||undefined,cartesiaVersion:process.env.CARTESIA_API_VERSION};
   return createRegisteredAdapter(c.provider,options,variant.adapter_ref);
  },
  async onAttempt(scope,event){await pool.query("SELECT pg_notify('uai_transient',$1)",[JSON.stringify({...scope,...event})]);},
  async onDelta(scope,requestId,_delta,event){
   await transaction(pool,async tx=>{
    const updated=await tx.query(`UPDATE execution_attempts a SET delta_sequence=$2 FROM execution_requests r WHERE a.id=$1 AND a.request_id=r.id AND r.id=$3 AND r.fencing_token=$4 AND r.execution_status IN ('submitting','running') AND a.delta_sequence<$2 RETURNING a.id`,[event.attempt_id,event.sequence,requestId,event.generation]);
    if(updated.rowCount)await tx.query("SELECT pg_notify('uai_transient',$1)",[JSON.stringify({...scope,...event})]);
   });
  },
 };
}
