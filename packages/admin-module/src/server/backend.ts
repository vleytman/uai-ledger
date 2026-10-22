import {canReadAdminView,canRunAdminAction,ADMIN_READ_VIEWS,ADMIN_ACTIONS} from '../../../contracts/admin-access.js';
import {encodeExternalIdentity,parseExternalIdentity,EXTERNAL_IDENTITY_HEADER,type ExternalIdentity,type StaffRole} from '../../../contracts/external-identity.js';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {sessions,SessionError} from '../../../web-session/src/index.js';
export {SessionError} from '../../../web-session/src/index.js';
export interface AdminConfig{api_url:string;admin_token:string;account_id:string;wallet_id:string;session_secret?:string;login_password?:string}
const readConfig=async():Promise<AdminConfig>=>{const candidates=process.env.UAI_ADMIN_CONFIG?[process.env.UAI_ADMIN_CONFIG]:[resolve('.data/admin-config.json'),resolve('../../.data/admin-config.json')];for(const filename of candidates){try{return JSON.parse(await readFile(filename,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}throw new Error('admin_configuration_missing');};
const identifier=(value:unknown)=>{if(typeof value!=='string'||!/^[-a-zA-Z0-9_]{1,200}$/.test(value))throw new SessionError(422,'Invalid identifier.');return encodeURIComponent(value);};
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
function englishError(data:unknown){
 if(!record(data)||!data.error)return data;
 const fallback='The request could not be completed.';
 if(typeof data.error==='string')return {...data,error:/\p{Script=Cyrillic}/u.test(data.error)?fallback:data.error};
 if(!record(data.error))return data;
 const error={...data.error};const messages:Record<string,string>={invalid_input:'Check the request fields and try again.',platform_unavailable:'Unable to complete the action. Please try again.'};
 if(typeof error.message!=='string'||/\p{Script=Cyrillic}/u.test(error.message))error.message=messages[String(error.code)]??fallback;
 if(record(error.details)&&Array.isArray(error.details.issues))error.details={...error.details,issues:error.details.issues.map(issue=>record(issue)&&typeof issue.message==='string'&&/\p{Script=Cyrillic}/u.test(issue.message)?{...issue,message:'Invalid value.'}:issue)};
 return {...data,error};
}
export function readPath(view:string,id:string|null,conf:Pick<AdminConfig,'account_id'|'wallet_id'>){const paths:Record<string,string>={provider_accounts:'/v1/admin/provider-accounts',provider_subscriptions:'/v1/admin/provider-subscriptions',provider_tariffs:'/v1/admin/provider-tariffs',allowance_bindings:'/v1/admin/provider-allowance-bindings',quota_bindings:'/v1/admin/provider-quota-bindings',provider_quotas:'/v1/admin/provider-quotas',execution_metrics:'/v1/admin/execution-metrics',admission_policy:'/v1/admin/admission-policy',dispatch_policies:'/v1/admin/dispatch-policies',overview:'/v1/admin/overview',credit_summary:'/v1/admin/credit-summary',operations:'/v1/admin/operations',wallets:'/v1/admin/wallets',providers:'/v1/admin/connections',budgets:'/v1/admin/execution-budgets',limiters:'/v1/admin/execution-limiters',models:'/v1/admin/model-versions',rates:'/v1/admin/rate-cards',routes:'/v1/admin/routes',recipes:'/v1/admin/recipes',queue:'/v1/admin/queue',recovery:'/v1/admin/recovery-incidents',reconciliation:'/v1/admin/reconciliation-runs',snapshots:'/v1/admin/snapshots',corrections:'/v1/admin/corrections',incidents:'/v1/admin/incidents',revocation_incidents:'/v1/admin/revocation-incidents',rules:'/v1/admin/notification-rules',destinations:'/v1/admin/webhook-destinations',deliveries:'/v1/admin/deliveries'};
 if(view==='allowance')return `/v1/admin/provider-subscriptions/${identifier(id)}/allowance`;
 if(view==='operation')return `/v1/admin/operations/${identifier(id)}`;
 if(view==='quota_snapshot')return `/v1/admin/provider-quotas/${identifier(id)}/snapshot`;
 if(view==='wallet')return `/v1/wallets/${identifier(id??conf.wallet_id)}`;
 if(view==='lots')return `/v1/wallets/${identifier(id??conf.wallet_id)}/lots`;
 if(view==='journal')return `/v1/wallets/${identifier(id??conf.wallet_id)}/transactions`;
 if(!paths[view])throw new SessionError(400,'Unknown page.');return paths[view];
}
export function commandPath(action:string,id:unknown){const simple:Record<string,[string,string]>={api_preview:['POST','/v1/admin/api-operations/preview'],provider_account_create:['POST','/v1/admin/provider-accounts'],subscription_create:['POST','/v1/admin/provider-subscriptions'],allowance_adjust:['POST','/v1/admin/allowance-adjustments'],allowance_snapshot:['POST','/v1/admin/allowance-snapshots'],quota_bindings_update:['PUT','/v1/admin/provider-quota-bindings'],quota_group_create:['POST','/v1/admin/provider-quotas'],admission_policy_update:['PATCH','/v1/admin/admission-policy'],model_preview:['POST','/v1/admin/model-versions/preview'],limiter_update:['POST','/v1/admin/execution-limiters'],budget_update:['POST','/v1/admin/execution-budgets'],recipe_quote:['POST','/v1/quotes'],price_compare:['POST','/v1/admin/rate-cards/compare'],connection_create:['POST','/v1/admin/connections'],snapshot_create:['POST','/v1/admin/snapshots'],reconcile:['POST','/v1/admin/reconciliation-runs'],correction:['POST','/v1/admin/corrections'],rule_create:['POST','/v1/admin/notification-rules'],destination_create:['POST','/v1/admin/webhook-destinations']};if(simple[action])return simple[action];
 const instance:Record<string,[string,string,string]>={allowance_refresh:['POST','/v1/admin/connections','/allowance-refresh'],allowance_bind:['PUT','/v1/admin/connections','/provider-account'],quota_rules_replace:['PUT','/v1/admin/provider-quotas','/rules'],quota_rule_limits_update:['PATCH','/v1/admin/provider-quotas','/rules'],quota_settings_update:['PATCH','/v1/admin/provider-quotas',''],dispatch_policy_update:['PATCH','/v1/admin/dispatch-policies',''],rates_rename:['PATCH','/v1/admin/rate-cards','/display-name'],connection_update:['PATCH','/v1/admin/connections',''],connection_status:['POST','/v1/admin/connections','/status'],connection_credential:['POST','/v1/admin/connections','/credential'],report_credential:['POST','/v1/admin/connections','/report-credential'],report_import:['POST','/v1/admin/connections','/import-cost-report'],connection_health:['POST','/v1/admin/connections','/health'],incident_ack:['POST','/v1/admin/incidents','/acknowledge'],incident_resolve:['POST','/v1/admin/incidents','/resolve'],incident_enable:['POST','/v1/admin/recovery-incidents','/enable'],rule_update:['PATCH','/v1/admin/notification-rules',''],destination_status:['PATCH','/v1/admin/webhook-destinations',''],delivery_retry:['POST','/v1/admin/deliveries','/retry'],grant:['POST','/v1/wallets','/grants'],refund:['POST','/v1/wallets','/refunds'],revoke:['POST','/v1/wallets','/grant-revocations'],revoke_commit:['POST','/v1/grant-revocations','/commit'],revoke_cancel:['POST','/v1/grant-revocations','/cancel'],spending_suspend:['POST','/v1/accounts','/spending/suspend'],spending_resume:['POST','/v1/accounts','/spending/resume'],operation_cancel:['POST','/v1/operations','/cancel'],request_cancel:['POST','/v1/requests','/cancel']};
 if(instance[action]){const [method,prefix,suffix]=instance[action];return [method,`${prefix}/${identifier(id)}${suffix}`];}
 const match=/^(models|rates|routes|recipes)_(create|update|publish)$/.exec(action);if(match){const resource={models:'model-versions',rates:'rate-cards',routes:'routes',recipes:'recipes'}[match[1]];return [match[2]==='update'?'PATCH':'POST',`/v1/admin/${resource}${match[2]==='create'?'':`/${identifier(id)}${match[2]==='publish'?'/publish':''}`}`];}
 throw new SessionError(400,'This action is unavailable.');
}
export interface AdminModuleContext {
 account_id:string; wallet_id:string;
 identity?:Extract<ExternalIdentity,{kind:'staff'}>; role?:StaffRole;
}
export interface AdminModuleCommand extends AdminModuleContext {
 key:string; data:unknown; id:unknown;
}
export interface ExternalAdminAuth {
 mode:'external'; publicOrigin:string; loginUrl:string;
 adapter:{authenticate(request:Request):Promise<Extract<ExternalIdentity,{kind:'staff'}>|null>;logout(request:Request):Promise<Response>};
}
export interface AdminBackendOptions {
 auth?:{mode:'standalone'}|ExternalAdminAuth;
 permissions?:{reads?:Record<string,readonly StaffRole[]>;commands?:Record<string,readonly StaffRole[]>};
 loadConfig?:()=>Promise<AdminConfig>;
 /** Trusted owner-only handlers. Keys must match app.<module>.<operation>. */
 reads?:Record<string,(context:AdminModuleContext)=>Promise<unknown>>;
 commands?:Record<string,(context:AdminModuleCommand)=>Promise<unknown>>;
}
export function createAdminBackend(options:AdminBackendOptions={}) {
 for(const registry of [options.reads,options.commands])for(const key of Object.keys(registry??{}))if(!/^app\.[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/.test(key))throw new Error('Invalid admin extension key');
 const external=options.auth?.mode==='external'?options.auth:undefined;
 let loginUrl:string|undefined;
 if(external){const origin=new URL(external.publicOrigin);if(origin.origin!==external.publicOrigin)throw new Error('publicOrigin must be an origin');const login=new URL(external.loginUrl,origin);if(login.origin!==origin.origin||login.username||login.password)throw new Error('loginUrl must use publicOrigin');loginUrl=login.href;}
 const loadConfig=options.loadConfig??readConfig;
 return async function handle(request:Request):Promise<Response>{
 try{
  if(!['GET','POST'].includes(request.method))throw new SessionError(405,'Method not allowed.');
  const conf=await loadConfig();
  const body=request.method==='POST'?await request.json():{};
  let identity:Extract<ExternalIdentity,{kind:'staff'}>|undefined;
  if(external){
   if(request.method!=='GET'){
    if(request.headers.get('origin')!==external.publicOrigin)throw new SessionError(403,'This request origin is not allowed.');
    if(!request.headers.get('content-type')?.startsWith('application/json'))throw new SessionError(415,'JSON is required.');
   }
   if(body.action==='logout'){const result=await external.adapter.logout(request);const headers=new Headers(result.headers);headers.set('cache-control','no-store');return new Response(result.body,{status:result.status,headers});}
   const resolved=await external.adapter.authenticate(request);
   if(!resolved)throw new SessionError(401,'Sign in to continue.');
   let checked:ExternalIdentity;try{checked=parseExternalIdentity(resolved)}catch{throw new SessionError(403,'Staff access is required.');}
   if(checked.kind!=='staff')throw new SessionError(403,'Staff access is required.');
   identity=checked;
  }
  if(!external){
   const auth=sessions('uai_admin',conf.session_secret??'',conf.login_password??'','en');auth.csrf(request);
   if(body.action==='login')return Response.json({ok:true},{headers:{'set-cookie':auth.login(request,String(body.password??'')),'cache-control':'no-store'}});
   auth.verify(request);
  }
  const role=identity?.role??'admin';
  if(body.action==='logout'){
   if(external){const result=await external.adapter.logout(request);const headers=new Headers(result.headers);headers.set('cache-control','no-store');return new Response(result.body,{status:result.status,headers});}
   return Response.json({ok:true},{headers:{'set-cookie':'uai_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0','cache-control':'no-store'}});
  }
  if(external){
   const probe=await fetch(new URL('/health',conf.api_url),{redirect:'error',signal:AbortSignal.timeout(5000)});
   const health=await probe.json();
   if(!probe.ok||health?.capabilities?.external_identity!==1)throw new SessionError(503,'The API does not support external identity version 1.');
  }
  const context:AdminModuleContext={account_id:conf.account_id,wallet_id:conf.wallet_id,...(identity?{identity,role}: {})};
  const extension=request.method==='GET'?new URL(request.url).searchParams.get('view'):body.action;
  if(typeof extension==='string'&&extension.startsWith('app.')){
   const allowed=(request.method==='GET'?options.permissions?.reads:options.permissions?.commands)?.[extension]??['admin'];
   if(!allowed.includes(role)||(request.method!=='GET'&&role==='viewer'))throw new SessionError(403,'This role cannot access this application action.');
   let result:unknown;
   if(request.method==='GET'){
    const read=Object.hasOwn(options.reads??{},extension)?options.reads![extension]:undefined;
    if(!read)throw new SessionError(404,'Unknown application page.');
    result=await read(context);
   }else{
    const command=Object.hasOwn(options.commands??{},extension)?options.commands![extension]:undefined;
    if(!command)throw new SessionError(404,'Unknown application action.');
    if(typeof body.key!=='string'||!/^[-a-zA-Z0-9_:.]{1,200}$/.test(body.key))throw new SessionError(422,'A command identifier is required.');
    result=await command({...context,key:body.key,data:body.data,id:body.id});
   }
   return Response.json(result,{headers:{'cache-control':'no-store'}});
  }
  const headers:Record<string,string>={...(identity?{[EXTERNAL_IDENTITY_HEADER]:encodeExternalIdentity(identity)}:{}),authorization:`Bearer ${conf.admin_token}`,'content-type':'application/json'};let path:string;let method='GET';let payload:unknown;
  if(request.method==='GET'){const url=new URL(request.url);if(url.searchParams.get('view')==='session')return Response.json({authenticated:true,account_id:conf.account_id,wallet_id:conf.wallet_id,mode:external?'external':'standalone',identity:identity??null,role,login_url:loginUrl,capabilities:{readViews:[...ADMIN_READ_VIEWS.filter(view=>canReadAdminView(view,role)),...Object.keys(options.reads??{}).filter(key=>(options.permissions?.reads?.[key]??['admin']).includes(role))],actions:[...ADMIN_ACTIONS.filter(action=>canRunAdminAction(action,role)),...Object.keys(options.commands??{}).filter(key=>role==='admin'&&(options.permissions?.commands?.[key]??['admin']).includes(role))]}},{headers:{'cache-control':'no-store'}});if(!canReadAdminView(url.searchParams.get('view')??'overview',role))throw new SessionError(403,'This role cannot read this page.');path=readPath(url.searchParams.get('view')??'overview',url.searchParams.get('id'),conf);}
  else{if(!canRunAdminAction(String(body.action??''),role))throw new SessionError(403,'This role cannot run this action.');if(typeof body.key!=='string'||!/^[-a-zA-Z0-9_:.]{1,200}$/.test(body.key))throw new SessionError(422,'A command identifier is required.');[method,path]=commandPath(String(body.action??''),body.id);payload=body.data??{};
   const flat=body.data??{};const {reason,revision,...settings}=flat;
   if(body.action==='connection_create'||body.action==='connection_update')payload={settings,reason,...(revision!==undefined?{revision}:{})};
   if(body.action==='snapshot_create')payload={snapshot:settings,reason};
   if(body.action==='reconcile')payload={report:settings,reason};
   if(body.action==='rule_create'||body.action==='rule_update')payload={rule:settings,reason,...(revision!==undefined?{revision}:{})};
   if(body.action==='destination_create')payload={destination:settings,reason};
   if(body.action==='recipes_create')payload={definition:{...flat.payload,key:flat.key,version:flat.version},reason:flat.comment};
   headers['idempotency-key']=body.key;if(body.revision!==undefined){if(!Number.isSafeInteger(body.revision)||body.revision<(body.action==='allowance_bind'?0:1))throw new SessionError(422,'Invalid revision.');headers['if-match']=String(body.revision);}}
  if(method==='GET'&&path==='/v1/admin/provider-quota-bindings'){
   const incoming=new URL(request.url),connection=identifier(incoming.searchParams.get('connection_id')),model=incoming.searchParams.get('model');
   if(!model||model.length>300)throw new SessionError(422,'Choose a model.');
   path+=`?${new URLSearchParams({connection_id:connection,model})}`;
  }
  if(method==='GET'&&(path==='/v1/admin/overview'||path==='/v1/admin/credit-summary')){
   const incoming=new URL(request.url);const query=new URLSearchParams();for(const key of path==='/v1/admin/overview'?['application_id','account_id','model','provider','period_start','period_end']:['account_id','period_start','period_end','expiring_before']){const value=incoming.searchParams.get(key);if(value){if(value.length>200)throw new SessionError(422,'The filter is too long.');query.set(key,value)}}path+=`?${query}`;
  }
  const response=await fetch(new URL(path,conf.api_url),{method,headers,body:method==='GET'?undefined:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(30000)});const text=await response.text();let data:unknown;try{data=JSON.parse(text);}catch{throw new SessionError(503,'The API returned an incomplete response. Please try again.');}return Response.json(response.ok?data:englishError(data),{status:response.status,headers:{'cache-control':'no-store'}});
 }catch(error){if(error instanceof SessionError)return Response.json({error:{message:error.message},...(external?{mode:'external',login_url:loginUrl}:{})},{status:error.status,headers:{'cache-control':'no-store'}});return Response.json({error:{message:'Unable to reach UAI. Check the API connection and server configuration.'},...(external?{mode:'external',login_url:loginUrl}:{})},{status:503,headers:{'cache-control':'no-store'}});}
}

}
export const handle=createAdminBackend();
