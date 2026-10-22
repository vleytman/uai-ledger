import {ConnectionService,CredentialVault} from '../../../packages/reconciliation/src/connections.js';
import {FirecrawlAdapter} from '../../../packages/providers/src/firecrawl.js';
import {importFirecrawlAllowance} from '../../../packages/allowance/src/firecrawl.js';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';
import {validateApiInput,apiMeasurements,priceApi,type ServiceOperation} from '../../../packages/api-services/src/index.js';
import type {RateCard} from '../../../packages/pricing/src/index.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {authenticateRequest,requestTransaction} from './request-principal.js';
import {command,requireScopes,type Principal} from '../../../packages/auth/src/index.js';
import {type Clock,DomainError} from '../../../packages/contracts/src/index.js';
import {paidApiSchemas} from '../../../packages/contracts/paid-api.js';
import {AllowanceService} from '../../../packages/allowance/src/index.js';
import type {Tx} from '../../../packages/db/src/index.js';
export function registerAllowance(app:FastifyInstance,pool:pg.Pool,clock:Clock){
 app.post('/v1/admin/api-operations/preview',r=>requestTransaction(pool,r,async tx=>{
  const p=await authenticateRequest(tx,r);requireScopes(p,'config:write');if(p.account_ids)throw new DomainError('scope_denied','Installation administrator required',403);
  const body=apiSchemas.ApiOperationPreviewBody.parse(r.body),catalog=new CatalogService(tx,clock);const version=await catalog.get(p,body.catalog_version_id);
  const model=(version.payload as any).models?.find((m:any)=>m.id===body.model);if(!model?.api)throw new DomainError('not_found','API operation not found',404);
  const operation=model.api as ServiceOperation;validateApiInput(operation,body.input);if(body.assets.count>operation.files.max_count||BigInt(body.assets.bytes)>BigInt(operation.files.max_total_bytes))throw new DomainError('invalid_input','Files exceed profile bounds',422);
  const measurements=apiMeasurements(operation,body.input,body.assets)!;for(const metric of operation.measurements)if(metric.source==='provider_usage'&&body.measurements?.[metric.key]!==undefined)measurements[metric.key]=body.measurements[metric.key];
  const card=await catalog.get(p,model.rate_card_version_id);const price=priceApi(operation,measurements,card.payload as RateCard,{at:clock.now().toISOString(),conditions:{model:body.model}});
  return {measurements,price_units:price,maximum_units:operation.pricing.max_units,charge_units:(BigInt(price)>BigInt(operation.pricing.max_units)?operation.pricing.max_units:price)};
 }));
 const run=(request:FastifyRequest,fn:(tx:Tx,p:Principal)=>Promise<any>)=>requestTransaction(pool,request,async tx=>{
  const p=await authenticateRequest(tx,request);requireScopes(p,'operations:admin');if(p.account_ids)throw new DomainError('scope_denied','Installation administrator required',403);
  if(request.method==='GET')return fn(tx,p);requireScopes(p,'config:write');
  const key=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).parse(request.headers['idempotency-key']);
  const result=await command(tx,p,`${request.method}:${request.routeOptions.url}`,key,{params:request.params,body:request.body,revision:request.headers['if-match']??null},async()=>{
   const row=await fn(tx,p);return {id:row.id??row.connection_id,revision:String(row.revision??1)};
  });
  return {id:result.id,revision:Number(result.revision)};
 });
 const rid=(r:FastifyRequest)=>z.string().min(1).max(200).parse((r.params as any).id);
 const actor=(r:FastifyRequest,p:Principal)=>({actor_id:p.id,reason:z.string().min(1).max(1000).parse((r.body as any)?.reason)});
 for(const [path,table] of Object.entries({'provider-accounts':'provider_accounts','provider-subscriptions':'provider_subscriptions','provider-tariffs':'provider_tariff_versions','provider-allowance-bindings':'provider_allowance_bindings'})){
  app.get(`/v1/admin/${path}`,async r=>run(r,async(tx,p)=>({data:(await tx.query(`SELECT * FROM ${table} WHERE organization_id=$1 AND application_id=$2`,[p.organization_id,p.application_id])).rows})));
 }
 app.post('/v1/admin/connections/:id/allowance-refresh',r=>run(r,async(tx,p)=>{
  if(process.env.UAI_ALLOW_REAL_PROVIDERS!=='true')throw new DomainError('real_provider_disabled','Provider reads are disabled in this environment',409);
  const key=process.env.UAI_VAULT_KEY,connections=new ConnectionService(tx,clock,key?new CredentialVault(Buffer.from(key,'base64')):undefined),connection=await connections.get(p,rid(r));
  if(connection.provider!=='firecrawl')throw new DomainError('unsupported_provider');
  const adapter=new FirecrawlAdapter({apiKey:await connections.resolveCredential(p,connection.id),models:[]});
  const snapshot=await adapter.readCreditUsage();return importFirecrawlAllowance(tx,p,clock,connection.id,snapshot,String(r.headers['idempotency-key']),actor(r,p));
 }));
 app.post('/v1/admin/provider-accounts',async r=>run(r,(tx,p)=>new AllowanceService(tx,clock).createAccount(p,r.body,actor(r,p))));
 app.post('/v1/admin/provider-subscriptions',async r=>run(r,(tx,p)=>new AllowanceService(tx,clock).createSubscription(p,r.body,actor(r,p))));
 app.put('/v1/admin/connections/:id/provider-account',async r=>run(r,(tx,p)=>{
  const revision=Number(z.string().regex(/^(0|[1-9]\d*)$/).parse(r.headers['if-match']));if(!Number.isSafeInteger(revision))throw new DomainError('invalid_revision','Invalid revision',422);
  return new AllowanceService(tx,clock).bindConnection(p,rid(r),r.body,revision,actor(r,p));
 }));
 app.get('/v1/admin/provider-subscriptions/:id/allowance',async r=>run(r,(tx,p)=>new AllowanceService(tx,clock).state(p,rid(r))));
 const subscriptionForPeriod=async(tx:Tx,p:Principal,periodId:string)=>{
  const row=(await tx.query('SELECT s.id FROM provider_subscriptions s JOIN allowance_periods p ON p.subscription_id=s.id WHERE p.id=$1 AND s.organization_id=$2 AND s.application_id=$3',[periodId,p.organization_id,p.application_id])).rows[0];
  if(!row)throw new DomainError('not_found','Allowance period not found',404);return row.id;
 };
 app.post('/v1/admin/allowance-snapshots',async r=>run(r,async(tx,p)=>{
  const body=paidApiSchemas.ProviderSnapshot.parse(r.body);return new AllowanceService(tx,clock).snapshot(p,await subscriptionForPeriod(tx,p,body.period_id),body,actor(r,p));
 }));
 app.post('/v1/admin/allowance-adjustments',async r=>run(r,async(tx,p)=>{
  const body=paidApiSchemas.AllowanceAdjustment.parse(r.body);return new AllowanceService(tx,clock).adjust(p,await subscriptionForPeriod(tx,p,body.period_id),body,actor(r,p));
 }));
}
