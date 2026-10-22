import {authenticateRequest,requestTransaction} from './request-principal.js';
import {viewerRequest,viewerAttempt,viewerCost} from './viewer-operation.js';
import {getAdminOverview} from './overview.js';
import { apiSchemas,apiEndpoints } from '../../../packages/contracts/api.js';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { transaction,type Tx } from '../../../packages/db/src/index.js';
import { requireScopes,accountScope,command,type Principal } from '../../../packages/auth/src/index.js';
import { type Clock,DomainError } from '../../../packages/contracts/src/index.js';
import { ConnectionService,CredentialVault,ReconciliationService,ReportingCredentialService,fetchProviderCostReport,reportToReconcileInput } from '../../../packages/reconciliation/src/index.js';
import { NotificationService } from '../../../packages/notifications/src/index.js';
import * as accounting from '../../../packages/accounting/src/index.js';
import * as execution from '../../../packages/execution/src/index.js';
import * as quoting from '../../../packages/quoting/src/index.js';
import * as storage from '../../../packages/storage/src/index.js';
const str=z.string().min(1).max(2000),object=z.record(z.string(),z.unknown());
const creditSummaryQuery=apiSchemas.AdminCreditSummaryQuery.refine(q=>!q.period_start||!q.period_end||Date.parse(q.period_start)<Date.parse(q.period_end),{message:'period_start must precede period_end'});
export function registerAdmin(app:FastifyInstance,pool:pg.Pool,clock:Clock){
 const principal=async(tx:Tx,request:FastifyRequest)=>{const p=await authenticateRequest(tx,request);requireScopes(p,'operations:admin');if(p.account_ids)throw new DomainError('scope_denied','Installation administrator required',403);return p};
 const run=(request:FastifyRequest,fn:(tx:Tx,p:Principal)=>Promise<unknown>)=>requestTransaction(pool,request,async tx=>{
  const p=await principal(tx,request);
  if(request.method==='GET')return fn(tx,p);
  const route=request.routeOptions.url?.replace(/:([^/]+)/g,'{$1}');const schema=apiEndpoints.find(v=>v.method.toUpperCase()===request.method&&v.path===route)?.body;if(schema)apiSchemas[schema].parse(request.body);
  const resource=request.url.split('/')[3]?.split('?')[0];
  const tables:Record<string,string>={connections:'provider_connections',snapshots:'provider_snapshots','reconciliation-runs':'reconciliation_runs',corrections:'pricing_correction_runs','notification-rules':'notification_rules',incidents:'notification_incidents',deliveries:'notification_deliveries',recipes:'recipe_versions','webhook-destinations':'webhook_destinations','recovery-incidents':'execution_incidents',requests:'execution_requests'};
  const table=request.routeOptions.url?.endsWith('/import-cost-report')?'reconciliation_runs':tables[resource];if(!table)throw new DomainError('invalid_input','Unsupported administrative command',422);
  if(['connections','recipes','notification-rules','webhook-destinations'].includes(resource))requireScopes(p,'config:write');
  let result:unknown;
  const refs=await command(tx,p,`${request.method}:${request.routeOptions.url}`,z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).parse(request.headers['idempotency-key']),{params:request.params,body:request.body},async()=>{
   result=await fn(tx,p);const row=result as {id?:string};return {resource_id:row?.id??String((request.params as {id?:string}).id??'')};
  });
  if(result!==undefined)return result;
  const rows=await tx.query(`SELECT * FROM ${table} WHERE id=$1 AND organization_id=$2 ${table==='execution_incidents'?'':'AND application_id=$3'}`,table==='execution_incidents'?[refs.resource_id,p.organization_id]:[refs.resource_id,p.organization_id,p.application_id]);
  const current=rows.rows[0];if(!current)throw new DomainError('not_found','Command resource not found',404);
  if(table==='webhook_destinations')delete current.secret_reference;return current;
 });
 const pid=(r:FastifyRequest)=>str.parse((r.params as {id:string}).id);
 const input=(r:FastifyRequest)=>object.parse(r.body);
 const actor=(r:FastifyRequest,p:Principal)=>({actor_id:p.id,reason:str.parse(input(r).reason)});
 const revision=(r:FastifyRequest)=>z.number().int().positive().parse(input(r).revision);
 const vault=()=>process.env.UAI_VAULT_KEY?new CredentialVault(Buffer.from(process.env.UAI_VAULT_KEY,'base64')):undefined;
 const conn=(tx:Tx)=>new ConnectionService(tx,clock,vault());
 app.get('/v1/admin/overview',async r=>run(r,(tx,p)=>getAdminOverview(tx,p,clock,r.query)));
 app.get('/v1/admin/credit-summary',async r=>run(r,async(tx,p)=>{const filters=creditSummaryQuery.parse(r.query);if(filters.account_id)await accountScope(tx,p,filters.account_id);return accounting.getCreditSummary(tx,p,clock,filters)}));
 app.get('/v1/admin/revocation-incidents',async r=>run(r,async(tx,p)=>({data:await accounting.listRevocationIncidents(tx,p)})));
 // Lists are ordered selections, followed by individually consistent account reads.
 // Do not hold one account's financial locks while waiting for another account.
 app.get('/v1/admin/wallets',async request=>{
  const {p,rows}=await transaction(pool,async tx=>{const p=await principal(tx,request);const rows=(await tx.query('SELECT id,account_id FROM wallets WHERE organization_id=$1 AND application_id=$2 ORDER BY id LIMIT 100',[p.organization_id,p.application_id])).rows;return {p,rows}});
  const data=[];
  for(const row of rows)data.push(await transaction(pool,async tx=>{
   const scope={...p,account_id:row.account_id},wallet=await accounting.getWallet(tx,scope,clock);
   const account=(await tx.query('SELECT spending_suspended FROM accounts WHERE id=$1 AND organization_id=$2 AND application_id=$3',[scope.account_id,p.organization_id,p.application_id])).rows[0];
   return {...wallet,account_id:row.account_id,spending_suspended:account.spending_suspended};
  }));
  return {data};
 });
 app.get('/v1/admin/operations',async request=>{
  const {p,rows}=await transaction(pool,async tx=>{const p=await principal(tx,request);const rows=(await tx.query('SELECT id,account_id FROM operations WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC,id LIMIT 100',[p.organization_id,p.application_id])).rows;return {p,rows}});
  const data=[];
  for(const row of rows)data.push(await transaction(pool,async tx=>({...await quoting.getOperation(tx,{...p,account_id:row.account_id},clock,row.id),account_id:row.account_id})));
  return {data};
 });
 app.get('/v1/admin/operations/:id',async r=>run(r,async(tx,p)=>{
  const row=(await tx.query('SELECT account_id FROM operations WHERE id=$1 AND organization_id=$2 AND application_id=$3',[pid(r),p.organization_id,p.application_id])).rows[0];if(!row)throw new DomainError('not_found','Operation not found',404);
  const scope={...p,account_id:row.account_id};const operation=await quoting.getOperation(tx,scope,clock,pid(r));
  const requests=await execution.getOperationRequests(tx,scope,pid(r));const ids=requests.map(v=>v.id);
  const attempts=(await tx.query('SELECT * FROM execution_attempts WHERE request_id=ANY($1::text[]) ORDER BY created_at',[ids])).rows;
  const costs=(await tx.query('SELECT * FROM provider_cost_entries WHERE attempt_id=ANY($1::text[]) ORDER BY priced_at',[attempts.map(v=>v.id)])).rows;
  const financials=await getAdminOverview(tx,p,clock,{},pid(r));
  const usdOnly=financials.provider_cost_totals.every((total:{currency:string})=>total.currency==='USD');
  const providerCost=usdOnly&&financials.cost_precision==='known'?financials.known_units:null;
  const platformCost=providerCost!==null&&financials.platform_funded_precision==='known'?financials.platform_funded_units:null;
  const withDelivery=[];
  for(const request of requests){const delivery=await storage.getDelivery(tx,scope,clock,request.id);withDelivery.push({...request,delivery:delivery?{status:delivery.status,ready_at:delivery.ready_at,content_expires_at:delivery.content_expires_at,acknowledged_at:delivery.acknowledged_at}:null});}
  const viewer=p.identity?.kind==='staff'&&p.identity.role==='viewer';
  return {...operation,requests:viewer?withDelivery.map(viewerRequest):withDelivery,attempts:viewer?attempts.map(viewerAttempt):attempts,costs:viewer?costs.map(viewerCost):costs,provider_cost_units:providerCost,platform_funded_units:platformCost};
 }));
 app.get('/v1/admin/attempts',async r=>run(r,async(tx,p)=>({data:(await tx.query('SELECT a.* FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id WHERE r.organization_id=$1 AND r.application_id=$2 ORDER BY a.created_at DESC LIMIT 100',[p.organization_id,p.application_id])).rows})));
 app.get('/v1/admin/recovery-incidents',async r=>run(r,async(tx,p)=>({data:(await tx.query('SELECT i.* FROM execution_incidents i WHERE i.organization_id=$1 AND EXISTS(SELECT 1 FROM execution_requests r WHERE r.incident_id=i.id AND r.application_id=$2) ORDER BY i.created_at DESC LIMIT 100',[p.organization_id,p.application_id])).rows})));
 for(const [name,table] of [['requests','execution_requests'],['audit-events','audit_events']] as const)app.get(`/v1/admin/${name}`,async r=>run(r,async(tx,p)=>({data:(await tx.query(`SELECT * FROM ${table} WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC LIMIT 100`,[p.organization_id,p.application_id])).rows})));
 app.get('/v1/admin/queue',async r=>run(r,async(tx,p)=>({data:(await tx.query("SELECT id,operation_id,account_id,execution_status,reason,quota_wait,priority,enqueued_at,not_before,deadline_at,attempt_count FROM execution_requests WHERE organization_id=$1 AND application_id=$2 AND execution_status NOT IN ('succeeded','failed','canceled','refused') ORDER BY priority DESC,enqueued_at LIMIT 100",[p.organization_id,p.application_id])).rows})));
 app.get('/v1/admin/recipes',async r=>run(r,async(tx,p)=>({data:await quoting.listRecipes(tx,{...p,account_id:'system'})})));
 app.post('/v1/admin/recipes',async r=>run(r,async(tx,p)=>{requireScopes(p,'config:write');const a=actor(r,p);return quoting.publishRecipe(tx,{...p,account_id:'system'},clock,{...object.parse(input(r).definition),actor_id:a.actor_id} as unknown as quoting.RecipeDefinition)}));
 app.get('/v1/admin/webhook-destinations',async r=>run(r,async(tx,p)=>({data:await new NotificationService(tx,clock).listDestinations(p)})));
 app.post('/v1/admin/webhook-destinations',async r=>run(r,async(tx,p)=>new NotificationService(tx,clock).addDestination(p,z.object({url:str,secret_reference:str}).parse(input(r).destination),actor(r,p))));
 app.patch('/v1/admin/webhook-destinations/:id',async r=>run(r,async(tx,p)=>new NotificationService(tx,clock).setDestinationEnabled(p,pid(r),revision(r),z.boolean().parse(input(r).enabled),actor(r,p))));
 app.get('/v1/admin/connections',async r=>run(r,async(tx,p)=>({data:await conn(tx).list(p)})));
 app.post('/v1/admin/connections',async r=>run(r,async(tx,p)=>{requireScopes(p,'config:write');const b=input(r);return conn(tx).create(p,object.parse(b.settings) as any,actor(r,p))}));
 app.patch('/v1/admin/connections/:id',async r=>run(r,async(tx,p)=>{requireScopes(p,'config:write');return conn(tx).update(p,pid(r),revision(r),object.parse(input(r).settings) as any,actor(r,p))}));
 app.post('/v1/admin/connections/:id/status',async r=>run(r,async(tx,p)=>conn(tx).setStatus(p,pid(r),revision(r),z.enum(['enabled','disabled','locked']).parse(input(r).status),actor(r,p))));
 app.post('/v1/admin/connections/:id/credential',async r=>run(r,async(tx,p)=>{requireScopes(p,'config:write');return conn(tx).rotateCredential(p,pid(r),revision(r),str.parse(input(r).secret),actor(r,p))}));
 app.get('/v1/admin/connections/:id/report-credential',async r=>run(r,async(tx,p)=>new ReportingCredentialService(tx,clock).metadata(p,pid(r))));
 app.post('/v1/admin/connections/:id/report-credential',async r=>run(r,async(tx,p)=>new ReportingCredentialService(tx,clock,vault()).rotate(p,pid(r),revision(r),z.string().min(1).max(16384).parse(input(r).secret),z.record(z.string(),z.string()).parse(input(r).credential_scope),actor(r,p))));
 app.post('/v1/admin/connections/:id/import-cost-report',async r=>{
  const body=z.object({period_start:z.iso.datetime(),period_end:z.iso.datetime(),identity:str,reason:str}).strict().parse(r.body);
  const context=await transaction(pool,async tx=>{const p=await authenticateRequest(tx,r);requireScopes(p,'operations:admin','config:write');if(p.account_ids)throw new DomainError('scope_denied','Installation administrator required',403);const connection=await conn(tx).get(p,pid(r));const credential=await new ReportingCredentialService(tx,clock,vault()).resolve(p,pid(r));return {connection,credential};});
  if(process.env.UAI_ALLOW_REPORTING_API!=='true')throw new DomainError('report_network_disabled','Real reporting APIs require explicit local configuration',503);
  const report=await fetchProviderCostReport({provider:context.connection.provider,account_scope:context.connection.account_scope,credential_scope:context.credential.credential_scope,period_start:body.period_start,period_end:body.period_end,reporting_lag_seconds:context.connection.capabilities.reporting_lag_seconds},{credential:context.credential.credential,clock,allow_network:true});
  return run(r,async(tx,p)=>new ReconciliationService(tx,clock).reconcile(p,reportToReconcileInput(report,pid(r),body.identity),actor(r,p)));
 });
 app.post('/v1/admin/connections/:id/health',async r=>run(r,async(tx,p)=>{const c=await conn(tx).get(p,pid(r));if(c.provider!=='fake')return {status:'unavailable',reason:'Non-paid health contract is not configured for this connection'};return conn(tx).recordHealth(p,pid(r),revision(r),'healthy',actor(r,p))}));
 // Resolves an unknown outcome from provider evidence; the customer is not charged for it.
 app.post('/v1/admin/requests/:id/resolve-unknown',async r=>run(r,async(tx,p)=>{
  const body=apiSchemas.AdminResolveUnknownBody.parse(r.body);
  const target=(await tx.query('SELECT account_id FROM execution_requests WHERE id=$1 AND organization_id=$2 AND application_id=$3',[pid(r),p.organization_id,p.application_id])).rows[0];
  if(!target)throw new DomainError('not_found','Request not found',404);
  return execution.resolveUnknownAttempt(tx,{organization_id:p.organization_id,application_id:p.application_id,account_id:target.account_id},clock,{request_id:pid(r),attempt_id:body.attempt_id,actor_id:p.id,reason:body.reason,provider_charged:body.provider_charged,...(body.cost_units===undefined?{}:{cost_units:body.cost_units})},(t,s,input)=>quoting.settleRequest(t,s,clock,input));
 }));
 app.post('/v1/admin/recovery-incidents/:id/enable',async r=>run(r,async(tx,p)=>execution.enableIncident(tx,{...p,account_id:'system'},clock,pid(r),actor(r,p).reason)));
 for(const route of ['snapshots','provider-snapshots'])app.get(`/v1/admin/${route}`,async r=>run(r,async(tx,p)=>({data:await new ReconciliationService(tx,clock).listSnapshots(p)})));
 app.post('/v1/admin/snapshots',async r=>run(r,async(tx,p)=>new ReconciliationService(tx,clock).addSnapshot(p,object.parse(input(r).snapshot) as any,actor(r,p))));
 app.get('/v1/admin/reconciliation-runs',async r=>run(r,async(tx,p)=>({data:await new ReconciliationService(tx,clock).listRuns(p)})));
 app.post('/v1/admin/reconciliation-runs',async r=>run(r,async(tx,p)=>new ReconciliationService(tx,clock).reconcile(p,object.parse(input(r).report) as any,actor(r,p))));
 app.get('/v1/admin/corrections',async r=>run(r,async(tx,p)=>({data:await new ReconciliationService(tx,clock).listCorrections(p)})));
 app.post('/v1/admin/corrections',async r=>run(r,async(tx,p)=>new ReconciliationService(tx,clock).correctCustomerOvercharges(await accountScope(tx,p,str.parse(input(r).account_id)),object.parse(input(r).correction) as any,actor(r,p))));
 app.get('/v1/admin/notification-rules',async r=>run(r,async(tx,p)=>({data:await new NotificationService(tx,clock).listRules(p)})));
 app.post('/v1/admin/notification-rules',async r=>run(r,async(tx,p)=>new NotificationService(tx,clock).saveRule(p,object.parse(input(r).rule) as any,actor(r,p))));
 app.patch('/v1/admin/notification-rules/:id',async r=>run(r,async(tx,p)=>new NotificationService(tx,clock).saveRule(p,object.parse(input(r).rule) as any,actor(r,p),{id:pid(r),revision:revision(r)})));
 app.get('/v1/admin/incidents',async r=>run(r,async(tx,p)=>({data:await new NotificationService(tx,clock).listIncidents(p)})));
 for(const action of ['acknowledge','resolve'] as const)app.post(`/v1/admin/incidents/:id/${action}`,async r=>run(r,async(tx,p)=>new NotificationService(tx,clock)[action](p,pid(r),revision(r),actor(r,p))));
 app.get('/v1/admin/deliveries',async r=>run(r,async(tx,p)=>({data:await new NotificationService(tx,clock).listDeliveries(p)})));
 app.post('/v1/admin/deliveries/:id/retry',async r=>run(r,async(tx,p)=>new NotificationService(tx,clock).retryDelivery(p,pid(r),actor(r,p))));
}
