import {forecastCalls} from '../../../packages/quoting/src/forecast.js';
import {TransientHub} from './transient-hub.js';
import {registerInvocationStreams,requestSnapshot} from './invocation-stream.js';
import {registerAllowance} from './admin-allowance.js';
import {activeFileReleases} from '../../../packages/configuration/src/ownership.js';
import {authenticateRequest,requestTransaction} from './request-principal.js';
import {lockExecutionAccount} from '../../../packages/db/src/execution-lock.js';
import {registerQuotaSettings} from './quota-settings.js';
import {registerNativeWebhooks} from './native-webhooks.js';
import {defaultRuntime} from '../../../packages/execution/src/default-runtime.js';
import {receiveNativeWebhook,type WorkerDependencies} from '../../../packages/execution/src/runtime.js';
import {providerAdmission} from '../../../packages/queue/src/provider-admission.js';
import {registerExecutionMetrics} from './execution-metrics.js';
import {registerAdmissionPolicy} from './admission-policy.js';
import {createBlobStore} from '../../../packages/storage/src/blob-store.js';
import {registerDispatchPolicies} from './dispatch-policies.js';
import {listPublicProfiles} from './profiles.js';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { apiSchemas } from '../../../packages/contracts/api.js';
import { validateOutput } from '../../../packages/execution/src/runtime.js';
import { registerPriceComparison } from './price-comparison.js';
import { registerExecutionControls } from './execution-controls.js';
import { registerAdmin } from './admin.js';
import Fastify, { type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { DomainError, id, systemClock, units, type Clock, type Scope } from '../../../packages/contracts/src/index.js';
import { type Tx } from '../../../packages/db/src/index.js';
import { accountScope, command, requireScopes, requireServiceScopes, type Principal } from '../../../packages/auth/src/index.js';
import * as accounting from '../../../packages/accounting/src/index.js';
import * as execution from '../../../packages/execution/src/index.js';
import * as quoting from '../../../packages/quoting/src/index.js';
import * as storage from '../../../packages/storage/src/index.js';
import { publicCatalog, CatalogService } from '../../../packages/catalog/src/index.js';
const {Identifier:text,GrantBody:grantBody,RefundBody:refundBody,RevocationBody:revokeBody}=apiSchemas;
export function createApi(pool:pg.Pool,clock:Clock=systemClock){
 const streams=new Set<ServerResponse>();
 const hub=new TransientHub(pool);
 const app=Fastify({logger:false,bodyLimit:20*1024*1024,requestTimeout:30000});
 let webhookRuntime:WorkerDependencies|undefined,webhookQuota:ReturnType<typeof providerAdmission>|undefined;
 registerNativeWebhooks(app,pool,async(scope,requestId,body,headers)=>{
  if(!webhookRuntime){
   webhookRuntime=defaultRuntime(pool,clock);
   webhookRuntime.onProviderResult=async(...args)=>{
    if(!args[2].quota_admission_id)return;
    if(!webhookQuota){
     const url=process.env.REDIS_URL,installation=process.env.UAI_INSTALLATION_ID;
     if(!url||!installation)throw new Error('quota_feedback_not_configured');
     webhookQuota=providerAdmission(pool,url,installation);
    }
    await webhookQuota.onProviderResult(...args);
   };
  }
  return receiveNativeWebhook(pool,webhookRuntime,scope,clock,requestId,body,headers);
 });
 app.addHook('onClose',async()=>{await webhookQuota?.close();await hub.close()});
 app.addHook('preClose',async()=>{for(const stream of streams)stream.end();streams.clear()});
 app.setErrorHandler((error,request,reply)=>{
  if(error instanceof z.ZodError)return reply.code(422).send({error:{code:'invalid_input',message:'Проверьте поля запроса.',retryable:false,correlation_id:request.id,details:{issues:error.issues.map(i=>({path:i.path,message:i.message}))}}});
  if(error instanceof DomainError)return reply.code(error.status).send({error:{code:error.code,message:error.message,retryable:false,correlation_id:request.id,details:error.details}});
  const infrastructureCode=typeof error==='object'&&error!==null&&'code' in error?String(error.code):'';
  const infrastructureUnavailable=/^08[A-Z0-9]{3}$/.test(infrastructureCode)||['57P01','57P02','57P03','53300','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH'].includes(infrastructureCode);
  if(infrastructureUnavailable)return reply.code(503).send({error:{code:'platform_unavailable',message:'Сервис временно недоступен. Повторите запрос с тем же ключом идемпотентности.',retryable:true,correlation_id:request.id}});
  const status=typeof error==='object'&&error!==null&&'statusCode' in error?Number(error.statusCode):500;
  return reply.code(status>=400&&status<500?status:500).send({error:{code:status<500?'invalid_input':'platform_unavailable',message:status<500?'Некорректный запрос.':'Не удалось выполнить команду.',retryable:false,correlation_id:request.id}});
 });
 const blobs=createBlobStore();
 app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
 const authorized=async<T>(request:FastifyRequest,scopes:string[],fn:(tx:Tx,p:Principal)=>Promise<T>)=>requestTransaction(pool,request,async tx=>{const p=await authenticateRequest(tx,request);requireScopes(p,...scopes);return fn(tx,p)});
 const key=(r:FastifyRequest)=>apiSchemas.IdempotencyKey.parse(r.headers['idempotency-key']);
 const parameter=(r:FastifyRequest,name='id')=>text.parse((r.params as Record<string,string>)[name]);
 const walletScope=async(tx:Tx,p:Principal,walletId:string)=>{const row=(await tx.query('SELECT account_id FROM wallets WHERE id=$1 AND organization_id=$2 AND application_id=$3',[walletId,p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Resource not found',404);return accountScope(tx,p,row.account_id)};
 const requestScope=async(tx:Tx,p:Principal,requestId:string)=>{const row=(await tx.query('SELECT account_id FROM execution_requests WHERE id=$1 AND organization_id=$2 AND application_id=$3',[requestId,p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Resource not found',404);return accountScope(tx,p,row.account_id)};
 const settle:execution.Settlement=(tx,scope,input)=>quoting.settleRequest(tx,scope,clock,input);
 app.get('/openapi.json',async()=>JSON.parse(await readFile(new URL('../../../docs/openapi.json',import.meta.url),'utf8')));
 app.get('/health',async()=>({status:'ok',api_version:'v1',capabilities:{external_identity:1,universal_invocation:1,streaming_invocation:true,reusable_input_assets:true}}));
 app.post('/v1/accounts',async request=>authorized(request,['accounts:write'],async(tx,p)=>{
  if(p.account_ids)throw new DomainError('scope_denied','Account-scoped token cannot create accounts',403);
  const body=apiSchemas.AccountBody.parse(request.body);
  const refs=await command(tx,p,'accounts:create',key(request),body,async()=>{
   const accountId=id('account');
   const row=(await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4) ON CONFLICT(application_id,external_account_id) DO UPDATE SET external_account_id=EXCLUDED.external_account_id RETURNING id',[accountId,p.organization_id,p.application_id,body.external_account_id])).rows[0];
   return {account_id:row.id};
  });
  const scope=await accountScope(tx,p,refs.account_id);
  return {id:refs.account_id,...(body.create_wallet?{wallet:await accounting.getWallet(tx,scope,clock)}:{})};
 }));
 app.get('/v1/wallets/:id',async request=>authorized(request,['wallets:read'],async(tx,p)=>{const scope=await walletScope(tx,p,parameter(request));const account=(await tx.query('SELECT spending_suspended FROM accounts WHERE id=$1',[scope.account_id])).rows[0];return {...await accounting.getWallet(tx,scope,clock),account_id:scope.account_id,spending_suspended:account.spending_suspended}}));
 app.get('/v1/wallets/:id/lots',async request=>authorized(request,['wallets:read'],async(tx,p)=>({data:await accounting.getLots(tx,await walletScope(tx,p,parameter(request)),clock)})));
 app.get('/v1/wallets/:id/transactions',async request=>authorized(request,['wallets:read'],async(tx,p)=>{
  const q=apiSchemas.JournalQuery.parse(request.query);
  const data=await accounting.getJournal(tx,await walletScope(tx,p,parameter(request)),{limit:q.limit,before:q.cursor});return {data,next_cursor:data.length===q.limit?data.at(-1)?.cursor:null};
 }));
 app.post('/v1/wallets/:id/grants',async request=>authorized(request,['credits:grant'],async(tx,p)=>{
  const body=grantBody.parse(request.body),scope=await walletScope(tx,p,parameter(request));
  if(p.max_grant_units===null||units(body.amount_units)>units(p.max_grant_units))throw new DomainError('scope_denied','Grant exceeds token limit',403);
  await command(tx,p,'wallets:grant',key(request),{wallet_id:parameter(request),...body},async()=>({wallet_id:parameter(request)}));
  const result=await accounting.grant(tx,scope,clock,{...body,idempotency_key:key(request),actor_id:p.id});
  return {...result,wallet:await accounting.getWallet(tx,scope,clock)};
 }));
 app.post('/v1/wallets/:id/test-balance',async request=>{
  if(process.env.UAI_ENV!=='test')throw new DomainError('not_found','Resource not found',404);
  return authorized(request,['credits:test-balance'],async(tx,p)=>{
   const body=apiSchemas.TestBalanceBody.parse(request.body),scope=await walletScope(tx,p,parameter(request));
   if(p.max_grant_units===null||units(body.available_units)>units(p.max_grant_units))throw new DomainError('scope_denied','Остаток превышает тестовый предел.',403);
   await command(tx,p,'wallets:test-balance',key(request),{wallet_id:parameter(request),...body},async()=>{
    await accounting.setTestAvailableBalance(tx,scope,clock,{...body,idempotency_key:key(request),actor_id:p.id,reason:'Установка доступного остатка в demo'});
    return {wallet_id:parameter(request)};
   });
   return {wallet:await accounting.getWallet(tx,scope,clock)};
  });
 });
 app.post('/v1/wallets/:id/refunds',async request=>authorized(request,['credits:refund'],async(tx,p)=>{const scope=await walletScope(tx,p,parameter(request)),body=refundBody.parse(request.body);await command(tx,p,'wallets:refund',key(request),{wallet_id:parameter(request),...body},async()=>({wallet_id:parameter(request)}));return accounting.refund(tx,scope,clock,{...body,idempotency_key:key(request),actor_id:p.id})}));
 app.post('/v1/wallets/:id/grant-revocations',async request=>authorized(request,['credits:revoke'],async(tx,p)=>{const scope=await walletScope(tx,p,parameter(request)),body=revokeBody.parse(request.body);await command(tx,p,'wallets:revoke',key(request),{wallet_id:parameter(request),...body},async()=>({wallet_id:parameter(request)}));return accounting.prepareRevocation(tx,scope,clock,{...body,idempotency_key:key(request),actor_id:p.id})}));
 for(const action of ['commit','cancel'] as const)app.post(`/v1/grant-revocations/:id/${action}`,async request=>authorized(request,['credits:revoke'],async(tx,p)=>{
  const row=(await tx.query('SELECT wallet_id FROM grant_revocations WHERE id=$1',[parameter(request)])).rows[0];
  if(!row)throw new DomainError('not_found','Resource not found',404);
  const scope=await walletScope(tx,p,row.wallet_id),body=apiSchemas.ReasonBody.parse(request.body);
  await command(tx,p,`revocations:${action}`,key(request),{id:parameter(request),...body},async()=>({revocation_id:parameter(request)}));
  return accounting[action==='commit'?'commitRevocation':'cancelRevocation'](tx,scope,clock,{revocation_id:parameter(request),reason:body.reason,idempotency_key:key(request),actor_id:p.id});
 }));
 for(const action of ['suspend','resume'] as const)app.post(`/v1/accounts/:id/spending/${action}`,async request=>authorized(request,['accounts:spending'],async(tx,p)=>{
  const scope=await accountScope(tx,p,parameter(request));await lockExecutionAccount(tx,scope);const body=apiSchemas.SpendingBody.parse(request.body);
  const refs=await command(tx,p,`spending:${action}`,key(request),{...body,account_id:scope.account_id},async()=>{
   await accounting.setSpendingSuspended(tx,scope,clock,{suspended:action==='suspend',reason:body.reason,idempotency_key:key(request),actor_id:p.id});
   if(action==='suspend'){const rows=(await tx.query('SELECT id FROM execution_requests WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND execution_status NOT IN (\'succeeded\',\'failed\',\'canceled\',\'refused\')',[scope.organization_id,scope.application_id,scope.account_id])).rows;for(const row of rows)await execution.cancelRequest(tx,scope,clock,row.id,settle);}
   return {account_id:scope.account_id};
  });return {...refs,spending_suspended:action==='suspend'};
 }));
 app.get('/v1/requests/:id',async request=>authorized(request,['ai:read'],async(tx,p)=>{
  const scope=await requestScope(tx,p,parameter(request));return requestSnapshot(tx,scope,clock,parameter(request));
 }));
 app.get('/v1/requests/:id/diagnostics',async request=>authorized(request,['ai:read'],async(tx,p)=>{
  const scope=await requestScope(tx,p,parameter(request));const r=await execution.getRequest(tx,scope,parameter(request));
  const attempts=(await tx.query("SELECT id,number,status,variant->>'model' model,cost_units,charged_units,created_at,finished_at FROM execution_attempts WHERE request_id=$1 ORDER BY number",[r.id])).rows;
  const costs=(await tx.query('SELECT id,attempt_id,state,currency,exact_amount,rounded_units,rated_items,entry_type,reason FROM provider_cost_entries WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND attempt_id=ANY($4::text[]) ORDER BY priced_at',[scope.organization_id,scope.application_id,scope.account_id,attempts.map(a=>a.id)])).rows;
  const usage=(await tx.query('SELECT attempt_id,model,kind,revision,usage FROM provider_usage_observations WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND attempt_id=ANY($4::text[]) ORDER BY observed_at',[scope.organization_id,scope.application_id,scope.account_id,attempts.map(a=>a.id)])).rows;
  return {request_id:r.id,reason:r.reason,next_retry_at:r.not_before,attempts,costs,usage,settlement_status:r.settlement_status,customer_charge_units:r.financial_closed_at?attempts.reduce((total,a)=>total+BigInt(a.charged_units??0),0n).toString():null,platform_funded_cost_units:attempts.some(a=>a.cost_units===null)?null:attempts.reduce((total,a)=>total+(a.charged_units==='0'?BigInt(a.cost_units):0n),0n).toString()};
 }));
 app.post('/v1/requests/:id/cancel',async request=>authorized(request,['ai:execute'],async(tx,p)=>{
  const scope=await requestScope(tx,p,parameter(request));
  await command(tx,p,'request:cancel',key(request),{request_id:parameter(request)},async()=>{await execution.cancelRequest(tx,scope,clock,parameter(request),settle);return {request_id:parameter(request)}});
  return {request_id:parameter(request),status:'cancel_requested'};
 }));
 app.post('/v1/requests/:id/acknowledge',async request=>authorized(request,['content:write'],async(tx,p)=>{
  const scope=await requestScope(tx,p,parameter(request)),body=apiSchemas.AcknowledgeBody.parse(request.body);
  key(request);return storage.acknowledge(tx,scope,clock,{request_id:parameter(request),version:body.result_version,manifest_hash:body.manifest_hash});
 }));
 app.post('/v1/admin/model-versions/preview',async request=>authorized(request,['config:write'],async(tx,p)=>new CatalogService(tx,clock).previewModel(p,apiSchemas.ModelCalculationPreviewBody.parse(request.body) as Parameters<CatalogService['previewModel']>[1])));
 app.get('/v1/models',async request=>authorized(request,['ai:read'],async(tx,p)=>{const active=await activeFileReleases(tx,p);return {data:(await new CatalogService(tx,clock).list(p,'catalog')).filter(v=>v.status==='published'&&(!v.file_source||active.has(v.file_source.release_id))).map(publicCatalog)}}));
 app.get('/v1/profiles',async request=>authorized(request,['ai:read'],async(tx,p)=>({data:await listPublicProfiles(tx,p,clock)})));
 app.patch('/v1/admin/rate-cards/:id/display-name',async request=>authorized(request,['config:write'],async(tx,p)=>{
  if(p.account_ids)throw new DomainError('scope_denied','Installation administrator required',403);
  const revision=z.coerce.number().int().positive().parse(request.headers['if-match']);
  const body=apiSchemas.ConfigDisplayNameBody.parse(request.body);
  const refs=await command(tx,p,'config:rate_card:rename',key(request),{...body,id:parameter(request),revision},async()=>{
   const v=await new CatalogService(tx,clock).renameRateCard(p,parameter(request),revision,body.display_name);
   return {version_id:v.id};
  });
  return new CatalogService(tx,clock).get(p,refs.version_id);
 }));
 for(const [path,kind] of [['model-versions','catalog'],['routes','route'],['rate-cards','rate_card']] as const){
  app.get(`/v1/admin/${path}`,async request=>authorized(request,[],async(tx,p)=>{requireServiceScopes(p,'config:write');return {data:await new CatalogService(tx,clock).list(p,kind)}}));
  app.post(`/v1/admin/${path}`,async request=>authorized(request,['config:write'],async(tx,p)=>{
   const body=apiSchemas.ConfigCreateBody.parse(request.body);
   const refs=await command(tx,p,`config:${kind}:create`,key(request),body,async()=>{const v=await new CatalogService(tx,clock).createDraft(p,{...body,kind,author:p.id,payload:body.payload as any});return {version_id:v.id}});
   return new CatalogService(tx,clock).get(p,refs.version_id);
  }));
  app.patch(`/v1/admin/${path}/:id`,async request=>authorized(request,['config:write'],async(tx,p)=>{
   const revision=z.coerce.number().int().positive().parse(request.headers['if-match']);
   const body=apiSchemas.ConfigUpdateBody.parse(request.body);
   return new CatalogService(tx,clock).updateDraft(p,parameter(request),revision,body.payload as any,body.comment,body.display_name);
  }));
  app.post(`/v1/admin/${path}/:id/publish`,async request=>authorized(request,['config:write'],async(tx,p)=>{
   const body=apiSchemas.ConfigPublishBody.parse(request.body);
   const refs=await command(tx,p,`config:${kind}:publish`,key(request),{...body,id:parameter(request)},async()=>{await new CatalogService(tx,clock).publish(p,parameter(request),body.revision,body.samples);return {version_id:parameter(request)}});
   return new CatalogService(tx,clock).get(p,refs.version_id);
  }));
 }
 const resourceScope=async(tx:Tx,p:Principal,table:'quotes'|'operations',resourceId:string)=>{const row=(await tx.query(`SELECT account_id FROM ${table} WHERE id=$1 AND organization_id=$2 AND application_id=$3`,[resourceId,p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Resource not found',404);return accountScope(tx,p,row.account_id)};
 registerInvocationStreams(app,pool,clock,hub,streams);
 const quoteSchema=apiSchemas.QuoteBody;
 app.post('/v1/quotes',async request=>authorized(request,['ai:quote'],async(tx,p)=>{
  const body=quoteSchema.parse(request.body),scope=await accountScope(tx,p,body.account_id);
  return quoting.createQuote(tx,scope,clock,{...body,kind:body.kind==='pool'?'pool':body.kind==='recipe'||(!body.kind&&body.recipe)?'recipe':'single_call',capability:body.capability??(body.kind&&!['single_call','recipe','pool'].includes(body.kind)?body.kind as Exclude<typeof body.kind,'single_call'|'recipe'|'pool'>:undefined),idempotency_key:key(request)});
 }));
 app.get('/v1/quotes/:id',async request=>authorized(request,['ai:quote'],async(tx,p)=>quoting.getQuote(tx,await resourceScope(tx,p,'quotes',parameter(request)),parameter(request))));
 app.post('/v1/forecasts',async request=>authorized(request,['ai:quote'],async(tx,p)=>{const body=apiSchemas.ForecastBody.parse(request.body);return forecastCalls(tx,await accountScope(tx,p,body.account_id),clock,body)}));
 app.post('/v1/invocations',async(request,reply)=>{const result=await authorized(request,['ai:quote','ai:execute'],async(tx,p)=>{const body=quoteSchema.parse(request.body),scope=await accountScope(tx,p,body.account_id);return quoting.invoke(tx,scope,clock,{...body,kind:'single_call',capability:body.capability??(body.kind&&!['single_call','recipe','pool'].includes(body.kind)?body.kind as Exclude<typeof body.kind,'single_call'|'recipe'|'pool'>:undefined),idempotency_key:key(request)});});return reply.code(202).send(result)});
 app.post('/v1/operations',async(request,reply)=>{const result=await authorized(request,['ai:execute'],async(tx,p)=>{const body=apiSchemas.AcceptOperationBody.parse(request.body);return quoting.acceptQuote(tx,await resourceScope(tx,p,'quotes',body.quote_id),clock,{...body,idempotency_key:key(request)})});return reply.code(202).send(result)});
 app.get('/v1/operations/:id',async request=>authorized(request,['ai:read'],async(tx,p)=>quoting.getOperation(tx,await resourceScope(tx,p,'operations',parameter(request)),clock,parameter(request))));
 for(const [action,fn] of [['complete',quoting.complete],['cancel',quoting.cancel],['finish-partial',quoting.finishPartial]] as const)app.post(`/v1/operations/:id/${action}`,async request=>authorized(request,['ai:execute'],async(tx,p)=>fn(tx,await resourceScope(tx,p,'operations',parameter(request)),clock,{operation_id:parameter(request),idempotency_key:key(request)})));
 app.post('/v1/operations/:id/amend',async request=>authorized(request,['ai:execute'],async(tx,p)=>{const body=apiSchemas.AmendOperationBody.parse(request.body);return quoting.amend(tx,await resourceScope(tx,p,'operations',parameter(request)),clock,{...body,operation_id:parameter(request),idempotency_key:key(request)})}));
 app.post('/v1/operations/:id/requests',async(request,reply)=>{const result=await authorized(request,['ai:execute'],async(tx,p)=>{const body=apiSchemas.RequestBody.parse(request.body);const r=await quoting.createRequest(tx,await resourceScope(tx,p,'operations',parameter(request)),clock,{...body,operation_id:parameter(request),idempotency_key:key(request)});return {id:r.id,operation_id:r.operation_id,execution_status:r.execution_status,settlement_status:r.settlement_status}});return reply.code(202).send(result)});
 app.get('/v1/recipes',async request=>authorized(request,['ai:read'],async(tx,p)=>{const query=apiSchemas.AccountQuery.parse(request.query);return {data:await quoting.listRecipes(tx,await accountScope(tx,p,query.account_id),true)}}));
 app.post('/v1/content-deletions',async(request,reply)=>{const result=await authorized(request,['content:write'],async(tx,p)=>{
  const body=apiSchemas.DeleteContentBody.parse(request.body);
  const scope=body.scope.operation_id?await resourceScope(tx,p,'operations',body.scope.operation_id):await accountScope(tx,p,text.parse(body.account_id));
  await lockExecutionAccount(tx,scope);
  const refs=await command(tx,p,'content:delete',key(request),body,async()=>{const result=await storage.deleteContent(tx,scope,clock,{...body.scope,reason:body.reason});for(const r of result.requests)if(['queued','leased','waiting_retry','waiting_recovery','paused'].includes(r.execution_status))await execution.cancelRequest(tx,scope,clock,r.id,settle);return {deletion_id:result.id}});return refs;
 });return reply.code(202).send(result)});
 app.get('/v1/content-deletions/:id',async request=>authorized(request,['content:write'],async(tx,p)=>{const row=(await tx.query('SELECT account_id FROM storage_tombstones WHERE id=$1 AND organization_id=$2 AND application_id=$3',[parameter(request),p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Resource not found',404);return storage.getDeletion(tx,await accountScope(tx,p,row.account_id),parameter(request))}));
 app.post('/v1/assets/uploads',async request=>authorized(request,['content:write'],async(tx,p)=>{
  const body=apiSchemas.UploadBody.parse(request.body),scope=await accountScope(tx,p,body.account_id);
  const refs=await command(tx,p,'assets:upload',key(request),body,async()=>{const assetId=id('asset');await storage.assertContentAllowed(tx,scope,body.metadata??{});await tx.query('INSERT INTO asset_uploads(id,organization_id,application_id,account_id,blob_key,media_type,expected_size,expected_hash,expires_at,retention_seconds,external_project_id,project_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[assetId,scope.organization_id,scope.application_id,scope.account_id,assetId,body.media_type,body.size_bytes,body.content_hash,new Date(clock.now().getTime()+3600000),body.retention_seconds??604800,body.metadata?.external_project_id??null,body.metadata?.project_generation??null]);return {asset_id:assetId}});return {...refs,upload_url:`/v1/assets/${refs.asset_id}/upload`};
 }));
 app.put('/v1/assets/:id/upload',async request=>authorized(request,['content:write'],async(tx,p)=>{
  const row=(await tx.query('SELECT * FROM asset_uploads WHERE id=$1 AND organization_id=$2 AND application_id=$3 FOR UPDATE',[parameter(request),p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Upload not found',404);await accountScope(tx,p,row.account_id);
  if(row.expires_at<=clock.now())throw new DomainError('content_unavailable','Upload expired',410);const body=request.body;if(!Buffer.isBuffer(body)||body.length!==row.expected_size||storage.contentHash(body)!==row.expected_hash)throw new DomainError('invalid_input','Upload hash or length mismatch',422);
  if(row.status==='pending'){try{await blobs.put(row.blob_key,body)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||storage.contentHash(await blobs.get(row.blob_key))!==row.expected_hash)throw error;}await tx.query("UPDATE asset_uploads SET status='uploaded' WHERE id=$1",[row.id]);}
  return {asset_id:row.id,status:'uploaded'};
 }));
 app.post('/v1/assets/:id/complete',async request=>authorized(request,['content:write'],async(tx,p)=>{
  key(request);const row=(await tx.query('SELECT * FROM asset_uploads WHERE id=$1 AND organization_id=$2 AND application_id=$3 FOR UPDATE',[parameter(request),p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Upload not found',404);const scope=await accountScope(tx,p,row.account_id);if(row.status==='pending')throw new DomainError('upload_incomplete');if(row.status==='completed')return storage.getAsset(tx,scope,clock,row.id,true);
  if(row.expires_at<=clock.now())throw new DomainError('content_unavailable','Upload expired',410);
  const bytes=await blobs.get(row.blob_key);if(storage.contentHash(bytes)!==row.expected_hash)throw new DomainError('invalid_input','Upload corrupted',422);
  const uploadBytes=bytes;try{await validateOutput({content_type:row.media_type,bytes:row.media_type.startsWith('image/')||row.media_type.startsWith('audio/')?uploadBytes:undefined,text:!row.media_type.startsWith('image/')&&!row.media_type.startsWith('audio/')?Buffer.from(uploadBytes).toString('utf8'):undefined})}catch{throw new DomainError('invalid_asset','Uploaded content failed validation',422)}
  const asset=await storage.registerAsset(tx,scope,clock,{id:row.id,kind:'input',blob_key:row.blob_key,content_hash:row.expected_hash,media_type:row.media_type,size_bytes:row.expected_size,external_project_id:row.external_project_id??undefined,project_generation:row.project_generation??undefined,expires_at:new Date(clock.now().getTime()+row.retention_seconds*1000)});await tx.query('UPDATE storage_assets SET retention_seconds=$2 WHERE id=$1',[asset.id,row.retention_seconds]);await tx.query("UPDATE asset_uploads SET status='completed' WHERE id=$1",[row.id]);return {id:asset.id,content_hash:asset.content_hash,media_type:asset.media_type,size_bytes:asset.size_bytes,expires_at:asset.expires_at};
 }));
 const assetRead=async(request:FastifyRequest)=>authorized(request,['ai:read'],async(tx,p)=>{const row=(await tx.query('SELECT account_id FROM storage_assets WHERE id=$1 AND organization_id=$2 AND application_id=$3',[parameter(request),p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Asset not found',404);return storage.getAsset(tx,await accountScope(tx,p,row.account_id),clock,parameter(request))});
 app.post('/v1/assets/:id/renew',async request=>authorized(request,['content:write'],async(tx,p)=>{const row=(await tx.query('SELECT account_id FROM storage_assets WHERE id=$1 AND organization_id=$2 AND application_id=$3',[parameter(request),p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Asset not found',404);const scope=await accountScope(tx,p,row.account_id);return command(tx,p,'assets:renew',key(request),{asset_id:parameter(request)},()=>storage.renewInputAsset(tx,scope,clock,parameter(request)));}));
 app.get('/v1/assets/:id',async request=>{const a=await assetRead(request);return {id:a.id,media_type:a.media_type,size_bytes:a.size_bytes,content_hash:a.content_hash,expires_at:a.expires_at,download_url:`/v1/assets/${a.id}/content`}});
 app.get('/v1/assets/:id/content',async(request,reply)=>{const a=await assetRead(request),bytes=await blobs.get(a.blob_key);return reply.header('cache-control','no-store').header('x-content-type-options','nosniff').type(a.media_type).send(Buffer.from(bytes))});
 app.get('/v1/events',async(request,reply)=>{
  const query=apiSchemas.EventQuery.parse(request.query);
  const p=await authenticateRequest(pool,request,{audit:false}); requireScopes(p,'ai:read');
  let scope:Scope|undefined;
  if(query.account_id)scope=await accountScope(pool,p,query.account_id);
  if(query.wallet_id)scope=await walletScope(pool,p,query.wallet_id);
  if(query.operation_id){const row=(await pool.query('SELECT account_id FROM operations WHERE id=$1 AND organization_id=$2 AND application_id=$3',[query.operation_id,p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Operation not found',404);scope=await accountScope(pool,p,row.account_id);}
  if(!scope && p.account_ids?.length===1)scope=await accountScope(pool,p,p.account_ids[0]);
  const accountIds=scope?[scope.account_id]:p.account_ids;
  let sequence='0';
  const last=request.headers['last-event-id'];
  if(last){const row=(await pool.query('SELECT sequence::text FROM outbox_events WHERE id=$1 AND organization_id=$2 AND application_id=$3 AND ($4::text[] IS NULL OR account_id=ANY($4))',[last,p.organization_id,p.application_id,accountIds])).rows[0];if(!row)throw new DomainError('event_cursor_expired','Read current snapshots and reconnect',409);sequence=row.sequence;}
  await hub.start();
  reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});reply.raw.write(': connected\n\n');
  streams.add(reply.raw);
  let closed=false,busy=false;
  const subscription=hub.subscribe(event=>['delta','outbox_wakeup'].includes(event.type)&&event.organization_id===p.organization_id&&event.application_id===p.application_id&&(!accountIds||accountIds.includes(event.account_id))&&(event.type==='outbox_wakeup'||!query.wallet_id),async event=>{
   if(closed)return;
   if(event.type==='outbox_wakeup'){await poll();return;}
   const fresh=await authenticateRequest(pool,request,{audit:false});requireScopes(fresh,'ai:read');const s=await accountScope(pool,fresh,event.account_id);const r=await execution.getRequest(pool,s,event.request_id);
   if(query.operation_id&&r.operation_id!==query.operation_id||String(r.fencing_token)!==String(event.generation)||['succeeded','failed','canceled','refused'].includes(r.execution_status))return;
   await storage.assertContentAllowed(pool,s,r);const delivery=await storage.getDelivery(pool,s,clock,r.id);if(closed||(delivery&&delivery.status!=='available'))return;
   if(!reply.raw.write(`event: request.output_delta\ndata: ${JSON.stringify({type:'request.output_delta',resource:{type:'request',id:r.id},data:{delta:event.text,attempt_id:event.attempt_id,attempt_number:event.attempt_number,generation:event.generation,sequence:event.sequence,field_path:event.field_path}})}\n\n`)){closed=true;reply.raw.end();}
  },()=>{closed=true;reply.raw.end()});
  const poll=async()=>{
   if(closed||busy)return;busy=true;
   try {
    const stillAuthorized=await authenticateRequest(pool,request,{audit:false});
    requireScopes(stillAuthorized,'ai:read');
    if(stillAuthorized.id!==p.id)throw new Error('Token changed');
    if(stillAuthorized.account_ids && (!accountIds||accountIds.some(account=>!stillAuthorized.account_ids!.includes(account))))throw new Error('Account access changed');
    const rows=(await pool.query(`SELECT id,sequence::text,type,occurred_at,application_id,account_id,resource,data FROM outbox_events WHERE organization_id=$1 AND application_id=$2 AND ($3::text[] IS NULL OR account_id=ANY($3)) AND sequence>$4::bigint ORDER BY sequence LIMIT 100`,[p.organization_id,p.application_id,accountIds,sequence])).rows;
    for(const event of rows){sequence=event.sequence;
     if(query.wallet_id && !(event.resource.type==='wallet'&&event.resource.id===query.wallet_id))continue;
     if(query.operation_id && !(event.resource.type==='operation'&&event.resource.id===query.operation_id)){
      if(event.resource.type!=='request')continue;
      const related=await pool.query('SELECT 1 FROM execution_requests WHERE id=$1 AND operation_id=$2',[event.resource.id,query.operation_id]);if(!related.rowCount)continue;
     }
     if(!reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)){reply.raw.end();closed=true;break;}
    }
   }catch{closed=true;reply.raw.end();}finally{busy=false;}
  };
  const timer=setInterval(()=>{void poll()},500),heartbeat=setInterval(()=>{if(!closed)reply.raw.write(': heartbeat\n\n')},15000);
  reply.raw.on('close',()=>{closed=true;streams.delete(reply.raw);subscription.close();clearInterval(timer);clearInterval(heartbeat)});
  await poll();
 });
 registerQuotaSettings(app,pool,clock);registerDispatchPolicies(app,pool,clock);registerAdmissionPolicy(app,pool,clock);registerExecutionMetrics(app,pool,clock);registerAdmin(app,pool,clock);registerAllowance(app,pool,clock);registerExecutionControls(app,pool,clock);registerPriceComparison(app,pool,clock);
 return app;
}
