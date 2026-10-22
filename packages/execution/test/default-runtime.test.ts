import {afterAll,describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPool,transaction} from '../../db/src/index.js';
import {ManualClock,id,type Scope} from '../../contracts/src/index.js';
import {CatalogService} from '../../catalog/src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {grant,getWallet} from '../../accounting/src/index.js';
import {publishRecipe,invoke,getOperation} from '../../quoting/src/index.js';
import {configureBudget} from '../src/index.js';
import {executeOne,schedulerTick} from '../src/runtime.js';
import {defaultRuntime} from '../src/default-runtime.js';
import {getDelivery,acknowledge,getAsset,leasePurge,purgeBlob,completePurge} from '../../storage/src/index.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>{await pool?.end();});
describe.skipIf(!pool)('Default worker on PostgreSQL',()=>{
 it('executes accepted text and image with actual factory, pricing, capture, blob and acknowledgement',async()=>{
  const s:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};const clock=new ManualClock(new Date('2026-09-18T12:00:00Z'));const folder=await mkdtemp(join(tmpdir(),'uai-worker-'));const oldRoot=process.env.UAI_BLOB_ROOT;process.env.UAI_BLOB_ROOT=folder;
  try{
   await transaction(pool!,async t=>{
    await t.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[s.application_id,s.organization_id,'worker fixture']);await t.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[s.account_id,s.organization_id,s.application_id,id('ext')]);
    const c=await new ConnectionService(t,clock).create(s,{provider:'fake',name:'worker fixture',account_scope:{fixture:'local'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{max_input_tokens:'2000'},risk_policy:{}},{actor_id:'test',reason:'Integration fixture'});
    await configureBudget(t,s,'provider',c.id,'1000000');await configureBudget(t,s,'period','period','1000000');
    const catalog=new CatalogService(t,clock);const models=await catalog.createDraft(s,{kind:'catalog',key:'models',version:1,payload:{models:[{id:'text-fixture',provider:'fake',capabilities:['text.generate'],allowed_parameters:['max_output_tokens'],status:'active'},{id:'image-fixture',provider:'fake',capabilities:['image.generate'],allowed_parameters:['count','size','quality'],status:'active'}]},author:'test',comment:'Synthetic fixtures'});await catalog.publish(s,models.id,models.revision);
    const rates=await catalog.createDraft(s,{kind:'rate_card',key:'prices',version:1,payload:{id:'test-rates',currency:'USD',source:'synthetic test rates',checked_at:clock.now().toISOString(),rates:[{id:'in',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'},{id:'out',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01T00:00:00Z'},{id:'image',dimension:'output.image',unit:'images',unit_size:'1',amount:'0.00000001',effective_from:'2026-01-01T00:00:00Z'}]},author:'test',comment:'Synthetic fixture'});await catalog.publish(s,rates.id,rates.revision,[{usage:{state:'known',items:[{dimension:'output.text',quantity:'10',unit:'tokens'}]},context:{at:clock.now().toISOString()}}]);
    for(const kind of ['text.generate','image.generate'] as const){const key=kind==='text.generate'?'text':'image';const route=await catalog.createDraft(s,{kind:'route',key,version:1,payload:{capability:kind,primary:{catalog_version_id:models.id,model:`${key}-fixture`,connection_id:c.id,max_cost_units:'3000'},deadline_seconds:3600,platform_risk_budget_units:'100000'},author:'test',comment:'Synthetic fixture'});await catalog.publish(s,route.id,route.revision);await publishRecipe(t,s,clock,{key,version:1,period_budget_key:'period',components:[{key:'result',capability:kind,route_version_id:route.id,rate_card_version_id:rates.id,count:{constant:1},limits:kind==='text.generate'?{input_tokens:2000,output_tokens:100}:{image_count:1,image_sizes:['1024x1024'],image_qualities:['standard']}}]});}
    await grant(t,s,clock,{idempotency_key:'grant',source:'purchase',external_reference:id('receipt'),amount_units:'100000',expires_at:null,terms_version:'test'});
   });
   const deps=defaultRuntime(pool!,clock);deps.limits={scope:s};
   for(const profile of ['text','image']){
    const invocation=await transaction(pool!,t=>invoke(t,s,clock,{idempotency_key:id('call'),profile,budget:{max_units:'3000'},input:profile==='text'?{text:'private worker input'}:{prompt:'private image input'},parameters:profile==='text'?{max_output_tokens:100}:{count:1,size:'1024x1024',quality:'standard'}}));
    const result=await executeOne(pool!,deps,clock);expect(result.state).toBe('succeeded');const delivery=await getDelivery(pool!,s,clock,invocation.request_id);expect(delivery?.status).toBe('available');expect((await getOperation(pool!,s,clock,invocation.operation_id)).settlement_status).toBe('settled');
    if(profile==='image'){const asset=await getAsset(pool!,s,clock,delivery!.result!.assets[0].id);const bytes=await deps.blobStore.get(asset.blob_key);expect(Buffer.from(bytes).toString()).toContain('width="1024"');}
    await transaction(pool!,t=>acknowledge(t,s,clock,{request_id:invocation.request_id,version:delivery!.version,manifest_hash:delivery!.manifest_hash}));
    expect((await getDelivery(pool!,s,clock,invocation.request_id))?.result).toBeNull();
   }
   const job=await transaction(pool!,t=>leasePurge(t,clock,'test-purger',s));expect(job).not.toBeNull();await purgeBlob(deps.blobStore,job);await transaction(pool!,t=>completePurge(t,clock,job.id,'test-purger'));await expect(deps.blobStore.get(job.blob_key)).rejects.toMatchObject({code:'ENOENT'});
   const wallet=await transaction(pool!,t=>getWallet(t,s,clock));expect(wallet.reserved_units).toBe('0');expect(wallet.balance_units).toBe('99980');
   const plaintext=(await pool!.query('SELECT content FROM storage_inputs WHERE organization_id=$1 AND content IS NOT NULL',[s.organization_id])).rows;expect(plaintext).toHaveLength(0);
  }finally{if(oldRoot===undefined)delete process.env.UAI_BLOB_ROOT;else process.env.UAI_BLOB_ROOT=oldRoot;await rm(folder,{recursive:true,force:true});}
 });
});
