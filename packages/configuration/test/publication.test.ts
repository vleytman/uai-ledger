import {exportLegacyConfiguration} from '../src/export.js';
import {adoptConfiguration} from '../src/adoption.js';
import {readFile} from 'node:fs/promises';
import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction,type Tx} from '../../db/src/index.js';
import {id,ManualClock,type Scope} from '../../contracts/src/index.js';
import {CatalogService} from '../../catalog/src/index.js';
import {ConnectionService,CredentialVault} from '../../reconciliation/src/connections.js';
import {demoModels} from '../../model-pricing/src/demo-models.js';
import {createRegisteredAdapter} from '../../providers/src/registry.js';
import {FakeAdapter} from '../../providers/src/index.js';
import {executeOne} from '../../execution/src/runtime.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import * as execution from '../../execution/src/index.js';
import * as quoting from '../../quoting/src/index.js';
import * as accounting from '../../accounting/src/index.js';
import {listPublicProfiles} from '../../../apps/api/src/profiles.js';
import {createApi} from '../../../apps/api/src/server.js';
import {issueToken} from '../../auth/src/index.js';
import {parseConfiguration,publishConfiguration,previewConfiguration,activateConfiguration,type FileConfiguration} from '../src/index.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const pool=process.env.DATABASE_URL?createPool():null;
const integration=pool?describe:describe.skip;
afterAll(async()=>{await pool?.end()});
const clock=new ManualClock(new Date('2026-09-22T12:00:00Z'));
const provenance={path:'configurations/ai/openai-nano.json',git_revision:'a'.repeat(40),git_dirty:false,content_hash:'b'.repeat(64),publisher:'fixture'};
async function fixture(){
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'File configuration tests']);
 await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
 const connection=await transaction(pool!,tx=>new ConnectionService(tx,clock).create(scope,{provider:'openai',name:'Synthetic connection; never dispatched to provider',account_scope:{fixture:scope.account_id},capabilities:{usage_reporting:true,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:['request'],reporting_lag_seconds:0},limits:{max_input_tokens:'16000'},risk_policy:{}},{actor_id:'fixture',reason:'Local testing only'}));
 await transaction(pool!,tx=>new ConnectionService(tx,clock,new CredentialVault(Buffer.alloc(32,1))).rotateCredential(scope,connection.id,connection.revision,'synthetic-not-a-real-key',{actor_id:'fixture',reason:'Synthetic adapter only'}));
 const document=parseConfiguration(JSON.parse(await readFile(new URL('../../../configurations/ai/openai-nano.json',import.meta.url),'utf8')));
 const bindings={connections:{primary:connection.id},budgets:{period:'fixture-period'}};
 const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
 const publish=(doc:FileConfiguration=document)=>run(tx=>publishConfiguration(tx,scope,doc,bindings,provenance,clock));
 const quote=(version?:number)=>run(tx=>quoting.createQuote(tx,scope,clock,{idempotency_key:id('quote'),kind:'single_call',...(version?{recipe:{key:document.bundle_key,version}}:{profile:document.bundle_key}),input:{text:'Hello'},parameters:{expected_output_tokens:128}}));
 await run(async tx=>{await execution.configureBudget(tx,scope,'provider',connection.id,'10000000000');await execution.configureBudget(tx,scope,'period','fixture-period','10000000000');await accounting.grant(tx,scope,clock,{idempotency_key:'fund',source:'internal',reason:'Synthetic test funding',external_reference:'fixture',amount_units:'10000000000',terms_version:'fixture',expires_at:null});});
 return {scope,connection,document,bindings,run,publish,quote};
}
integration('Git configuration publication',()=>{
 it('UI-A01 publishes default execution policy and pins accepted requests to that version',async()=>{
  const f=await fixture();const initial=await f.publish();await f.run(tx=>activateConfiguration(tx,f.scope,initial.id,0,'fixture'));
  const document=parseConfiguration(JSON.parse(await readFile(new URL('../../../configurations/execution/default.json',import.meta.url),'utf8')));
  const policy=await f.run(tx=>publishConfiguration(tx,f.scope,document,{connections:{},budgets:{}},{...provenance,path:'configurations/execution/default.json'},clock));
  await f.run(tx=>activateConfiguration(tx,f.scope,policy.id,0,'fixture'));
  const accepted=await f.run(tx=>quoting.invoke(tx,f.scope,clock,{idempotency_key:id('invoke'),profile:f.document.bundle_key,input:{text:'Hello'},parameters:{expected_output_tokens:128}}));
  const before=await execution.getRequest(pool!,f.scope,accepted.request_id);expect(before.route.execution.max_attempts).toBe(4);expect(before.route.execution_policy_version_id).toBe(policy.resources[0].id);
  (document.resources[0].payload as any).max_attempts=1;
  const changed=await f.run(tx=>publishConfiguration(tx,f.scope,document,{connections:{},budgets:{}},{...provenance,path:'configurations/execution/default.json'},clock));
  await f.run(tx=>activateConfiguration(tx,f.scope,changed.id,1,'fixture'));
  expect((await f.quote()).execution.max_attempts).toBe(1);
  expect((await execution.getRequest(pool!,f.scope,accepted.request_id)).route.execution).toEqual(before.route.execution);
 });
 it('exports and adopts legacy definitions atomically while retaining old versions and operational settings',async()=>{
  const f=await fixture(),ids:Record<string,string>={};
  await f.run(async tx=>{const service=new CatalogService(tx,clock);
   for(const resource of f.document.resources){const payload=JSON.parse(JSON.stringify(resource.payload).replace(/@(catalog|rate_card|route):([a-zA-Z0-9_.-]+)/g,(_m:string,kind:string,key:string)=>ids[`${kind}:${key}`]).replaceAll('@connection:primary',f.connection.id).replaceAll('@budget:period','fixture-period'));
    if(resource.kind==='recipe'){await quoting.publishRecipe(tx,f.scope,clock,{...payload,key:resource.key,version:1});continue;}
    const row=await service.createDraft(f.scope,{kind:resource.kind as any,key:resource.key,version:1,payload,author:'legacy',comment:'Legacy fixture'});const published=await service.publish(f.scope,row.id,row.revision,(resource as any).samples??[]);ids[`${resource.kind}:${resource.key}`]=published.id;
   }
  });
  const oldQuote=await f.quote(),exported=await f.run(tx=>exportLegacyConfiguration(tx,f.scope,'adopted-nano'));
  const bad=structuredClone(exported.baselines);bad[0].hash='changed';
  await expect(f.run(tx=>adoptConfiguration(tx,f.scope,exported.document,exported.bindings,provenance,bad,'Fixture adoption',clock))).rejects.toMatchObject({code:'adoption_baseline_changed'});
  expect((await pool!.query('SELECT 1 FROM configuration_file_adoptions WHERE organization_id=$1',[f.scope.organization_id])).rowCount).toBe(0);
  const release=await f.run(tx=>adoptConfiguration(tx,f.scope,exported.document,exported.bindings,provenance,exported.baselines,'Fixture adoption',clock));
  expect(await f.run(tx=>adoptConfiguration(tx,f.scope,exported.document,exported.bindings,provenance,exported.baselines,'Fixture adoption',clock))).toMatchObject({id:release.id,reused:true});
  await f.run(tx=>activateConfiguration(tx,f.scope,release.id,0,'fixture'));
  await expect(f.run(tx=>quoting.invoke(tx,f.scope,clock,{quote_id:oldQuote.id,idempotency_key:'old-accepted'}))).resolves.toHaveProperty('request_id');
  const legacy=await new CatalogService(pool!,clock).get(f.scope,ids[Object.keys(ids)[0]]);expect(legacy.file_source).toBeNull();
  await expect(pool!.query('UPDATE configuration_versions SET display_name=$1 WHERE id=$2',['Bypass',legacy.id])).rejects.toThrow('file_managed_configuration');
  expect((await new ConnectionService(pool!,clock).get(f.scope,f.connection.id)).limits).toEqual({max_input_tokens:'16000'});
 });
 it('publishes the exported twenty-profile catalog with scoped installation bindings',async()=>{
  const f=await fixture(),document=parseConfiguration(JSON.parse(await readFile(new URL('../../../configurations/ai/legacy-local.json',import.meta.url),'utf8'))),bindings={connections:{} as Record<string,string>,budgets:{} as Record<string,string>};
  const catalogs=new Map(document.resources.filter(r=>r.kind==='catalog').map(r=>[r.key,r.payload]));
  await f.run(async tx=>{
   for(const resource of document.resources){if(resource.kind==='route')for(const target of [resource.payload.primary,...(resource.payload.fallback?[resource.payload.fallback]:[])]){
    const symbol=target.connection_id.slice('@connection:'.length);if(bindings.connections[symbol])continue;
    const provider=catalogs.get(target.catalog_version_id.slice('@catalog:'.length))!.models.find(m=>m.id===target.model)!.provider;
    const c=await new ConnectionService(tx,clock).create(f.scope,{provider,name:'Export fixture',account_scope:{fixture:symbol},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:0},limits:{},risk_policy:{}},{actor_id:'fixture',reason:'Offline export test'});bindings.connections[symbol]=c.id;
   }else if(resource.kind==='recipe')bindings.budgets[resource.payload.period_budget_key.slice('@budget:'.length)]='fixture-period';}
   const release=await publishConfiguration(tx,f.scope,document,bindings,provenance,clock);expect(release.resources).toHaveLength(65);await activateConfiguration(tx,f.scope,release.id,0,'fixture');expect(await quoting.listRecipes(tx,f.scope,true)).toHaveLength(20);
   const updated=structuredClone(document);for(const resource of updated.resources)if(resource.kind==='rate_card')resource.payload.source+=' · unchanged rates republished';
   const second=await publishConfiguration(tx,f.scope,updated,bindings,provenance,clock);expect(second.resources).toHaveLength(65);expect(second.id).not.toBe(release.id);
  });
 });
 it('uses the existing nano calculation, validates preview without writes and publishes atomically/idempotently under concurrency',async()=>{
  const f=await fixture();const nano=demoModels().find(m=>m.key==='nano')!;
  const model=(f.document.resources.find(r=>r.kind==='catalog')!.payload as any).models[0];
  expect(model.calculation.components).toEqual(nano.method.components);expect(model.calculation.pricing).toEqual(nano.method.pricing);
  expect(await f.run(tx=>previewConfiguration(tx,f.scope,f.document,f.bindings,provenance,clock))).toMatchObject({unchanged:false,activation:'unchanged',resources:expect.any(Array)});
  expect((await pool!.query('SELECT id FROM configuration_releases WHERE organization_id=$1',[f.scope.organization_id])).rows).toHaveLength(0);
  expect((await new CatalogService(pool!,clock).list(f.scope))).toHaveLength(0);
  const [a,b]=await Promise.all([f.publish(),f.publish()]);expect(a.id).toBe(b.id);expect([a.reused,b.reused].sort()).toEqual([false,true]);
  expect(a.resources).toHaveLength(4);expect(await f.publish()).toMatchObject({id:a.id,reused:true});
  await expect(f.quote()).rejects.toMatchObject({code:'not_found'});
  expect(await f.run(tx=>quoting.listRecipes(tx,f.scope,true))).toHaveLength(0);expect(await listPublicProfiles(pool!,f.scope,clock)).toHaveLength(0);
  expect((await new CatalogService(pool!,clock).list(f.scope)).every(r=>r.file_active===false)).toBe(true);
  const activated=await f.run(tx=>activateConfiguration(tx,f.scope,a.id,0,'fixture'));
  expect(activated.revision).toBe(1);expect(await f.run(tx=>activateConfiguration(tx,f.scope,a.id,0,'fixture'))).toEqual(activated);
  expect(await f.quote()).toHaveProperty('id');expect(await listPublicProfiles(pool!,f.scope,clock)).toHaveLength(1);
  const publicRecipes=await f.run(tx=>quoting.listRecipes(tx,f.scope,true));expect(publicRecipes).toHaveLength(1);expect(JSON.stringify(publicRecipes)).not.toContain('git_revision');
 });
 it('rolls back the entire release for invalid samples, references, adapters and foreign connections',async()=>{
  const f=await fixture();
  for(const mutate of [
   (d:any)=>{d.resources[1].payload.models[0].calculation.samples[0].expected_price_units='0'},
   (d:any)=>{d.resources[2].payload.primary.catalog_version_id='@catalog:missing'},
   (d:any)=>{d.resources[1].payload.models[0].adapter_ref='openai@999'},
   (d:any)=>{d.resources[3].payload.components[0].route_version_id='arbitrary-database-id'},
  ]){const doc=structuredClone(f.document);mutate(doc);await expect(f.publish(doc)).rejects.toThrow();expect(await new CatalogService(pool!,clock).list(f.scope)).toHaveLength(0);}
  const foreign=await fixture();await expect(f.run(tx=>publishConfiguration(tx,f.scope,f.document,foreign.bindings,provenance,clock))).rejects.toMatchObject({code:'incompatible_connection'});
  expect((await pool!.query('SELECT id FROM configuration_releases WHERE organization_id=$1',[f.scope.organization_id])).rowCount).toBe(0);
 });
 it('blocks legacy creation, rename, recipe replacement and direct SQL edits; HTTP cannot inject ownership',async()=>{
  const f=await fixture(),release=await f.publish();const rates=release.resources.find((r:any)=>r.kind==='rate_card')!;
  const catalog=new CatalogService(pool!,clock),row=await catalog.get(f.scope,rates.id);
  await expect(catalog.renameRateCard(f.scope,row.id,row.revision,'Bypass')).rejects.toMatchObject({code:'file_managed_configuration'});
  await expect(catalog.createDraft(f.scope,{kind:'rate_card',key:row.key,version:2,payload:row.payload,author:'test',comment:'bypass'})).rejects.toMatchObject({code:'file_managed_configuration'});
  await expect(catalog.updateDraft(f.scope,row.id,row.revision,row.payload,'bypass')).rejects.toMatchObject({code:'file_managed_configuration'});
  const recipe=(await f.run(tx=>quoting.listRecipes(tx,f.scope)))[0];
  await expect(f.run(tx=>quoting.publishRecipe(tx,f.scope,clock,{...recipe.definition,version:2}))).rejects.toMatchObject({code:'file_managed_configuration'});
  await expect(pool!.query('UPDATE configuration_versions SET display_name=$1,revision=revision+1 WHERE id=$2',['Bypass',row.id])).rejects.toThrow('file_managed_configuration');
  await expect(pool!.query('UPDATE configuration_releases SET document=$1 WHERE id=$2',[{},release.id])).rejects.toThrow('immutable');
  const token=(await f.run(tx=>issueToken(tx,{...f.scope,account_ids:null,scopes:['operations:admin','config:write','ai:read'],max_grant_units:'1',expires_at:null}))).token;
  const api=createApi(pool!,clock);try{
   const response=await api.inject({method:'PATCH',url:`/v1/admin/rate-cards/${row.id}/display-name`,headers:{authorization:`Bearer ${token}`,'idempotency-key':id('key'),'if-match':String(row.revision)},payload:{display_name:'Bypass'}});
   expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('file_managed_configuration');
   const response2=await api.inject({method:'POST',url:'/v1/admin/rate-cards',headers:{authorization:`Bearer ${token}`,'idempotency-key':id('key')},payload:{key:row.key,version:2,payload:row.payload,comment:'Bypass',file_source:row.file_source}});
   expect([409,422]).toContain(response2.statusCode);
  }finally{await api.close()}
 });
 it('activates new terms separately, preserves accepted work and executes it using the saved adapter and rates',async()=>{
  const f=await fixture(),first=await f.publish();await f.run(tx=>activateConfiguration(tx,f.scope,first.id,0,'fixture'));
  const quote=await f.quote();
  const operation=await f.run(tx=>quoting.invoke(tx,f.scope,clock,{quote_id:quote.id,idempotency_key:'accepted-before-change'}));
  const before=await quoting.getExecutionContext(pool!,f.scope,clock,operation.request_id);
  expect(before.component.route.primary.adapter_ref).toBe('openai@1');
  const changed=structuredClone(f.document);const method=(changed.resources[1].payload as any).models[0].calculation;
  method.pricing.markup_percent='200';for(const sample of method.samples){delete sample.expected_price_units;delete sample.expected_cost_usd;}
  (changed.resources[0].payload as any).rates.find((r:any)=>r.dimension==='output.text').amount='0.8';
  const second=await f.publish(changed);expect(await f.run(tx=>previewConfiguration(tx,f.scope,changed,f.bindings,provenance,clock))).toMatchObject({unchanged:true,changes:[]});expect((await f.quote()).max_units).toBe(quote.max_units);
  await f.run(tx=>activateConfiguration(tx,f.scope,second.id,1,'fixture'));
  await expect(f.run(tx=>activateConfiguration(tx,f.scope,first.id,0,'other'))).rejects.toMatchObject({code:'revision_conflict'});
  await expect(f.quote(1)).rejects.toMatchObject({code:'not_found'});expect((await f.quote()).max_units).not.toBe(quote.max_units);
  const after=await quoting.getExecutionContext(pool!,f.scope,clock,operation.request_id);
  expect(after.component).toEqual(before.component);expect(after.accepted_rate_card).toEqual(before.accepted_rate_card);expect(after.current_rate_card).not.toEqual(before.current_rate_card);
  const deps=defaultRuntime(pool!,clock),seen:string[]=[];
  deps.blobStore={async put(){},async get(){throw new Error('No binary data')},async delete(){}};deps.limits={scope:f.scope};
  deps.adapter=async(_scope,variant)=>{seen.push(variant.adapter_ref!);return new FakeAdapter([{outcome:'success',text:'Deterministic response',usage:{state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:'25'},{dimension:'output.text',unit:'tokens',quantity:'20'}]}}])};
  const result=await executeOne(pool!,deps,clock,'file-publication-test');expect(result.state).toBe('succeeded');expect(seen).toEqual(['openai@1']);
  expect(await quoting.getOperation(pool!,f.scope,clock,operation.operation_id)).toMatchObject({execution_status:'completed',captured_units:'21000'});
  // Publication/activation never owns operational settings.
  expect((await new ConnectionService(pool!,clock).get(f.scope,f.connection.id)).limits).toEqual(f.connection.limits);
  expect((await pool!.query('SELECT limit_units FROM execution_budgets WHERE organization_id=$1 AND kind=$2 AND budget_key=$3',[f.scope.organization_id,'period','fixture-period'])).rows[0].limit_units).toBe('10000000000');
 });
 it('retains existing activation on a failed publication and prevents implicit adoption/key removal',async()=>{
  const f=await fixture(),release=await f.publish();await f.run(tx=>activateConfiguration(tx,f.scope,release.id,0,'fixture'));
  const removed=structuredClone(f.document);removed.resources.splice(0,1);await expect(f.publish(removed)).rejects.toMatchObject({code:'configuration_resource_set_changed'});
  const wrong=structuredClone(f.document);wrong.bundle_key='other-owner';await expect(f.publish(wrong)).rejects.toThrow('file_managed_configuration');
  const otherScope={...f.scope,application_id:id('other')};await expect(f.run(tx=>activateConfiguration(tx,otherScope,release.id,0,'fixture'))).rejects.toMatchObject({code:'not_found'});
  expect((await new CatalogService(pool!,clock).list(f.scope)).every(r=>r.file_active)).toBe(true);
 });
});
it('registry keeps adapter construction explicit and rejects arbitrary code/endpoints',()=>{
 expect(createRegisteredAdapter('openai',{apiKey:'synthetic',models:[]},'openai@1').id).toBe('openai');
 expect(()=>createRegisteredAdapter('openai',{apiKey:'synthetic',models:[]},'https://example.com')).toThrow();
 expect(()=>parseConfiguration({schema_version:1,bundle_key:'test',resources:[],script:'anything'})).toThrow();
});
