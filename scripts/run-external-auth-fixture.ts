import {fixtureUsers,productActionResponse} from '../apps/admin/test/fixtures/external-host/product-access.js';
/** Loopback-only synthetic parent host. Never use this session source in production. */
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {isolatedTestDatabase} from '../packages/db/test/isolated-database.js';
import {transaction} from '../packages/db/src/index.js';
import {issueToken} from '../packages/auth/src/index.js';
import {createApi} from '../apps/api/src/server.js';
import {UaiClient,UaiError} from '../packages/sdk/src/index.js';
import {SessionError} from '../packages/web-session/src/index.js';
import {createAdminBackend} from '../packages/admin-module/src/server/backend.js';
if(process.env.UAI_ENV!=='test')throw new Error('UAI_ENV=test is required');
process.env.UAI_ALLOW_REAL_PROVIDERS='false';
const source=process.env.DATABASE_URL;if(!source)throw new Error('DATABASE_URL is required');
const database=isolatedTestDatabase(source);await database.initialize();
try {
const pool=database.pool!;
const appId=`app_${randomUUID()}`,orgId=`org_${randomUUID()}`;
await pool.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[appId,orgId,'Synthetic external identity fixture']);
const token=(await transaction(pool,tx=>issueToken(tx,{organization_id:orgId,application_id:appId,account_ids:null,scopes:['identity:assert','accounts:write','accounts:spending','credits:grant','credits:refund','credits:revoke','wallets:read','ai:read','ai:quote','ai:execute','content:write','operations:admin','config:write'],max_grant_units:'1000000',expires_at:null}))).token;
const api=createApi(pool);const apiUrl=await api.listen({host:'127.0.0.1',port:0});
const sdk=new UaiClient({baseUrl:apiUrl,token});await sdk.assertExternalIdentitySupport();
const teams:Record<string,{id:string;wallet:{id:string}}>= {};
for(const team of ['alpha','beta']){
 const account=await sdk.accounts.create({external_account_id:team,create_wallet:{credit_unit_id:'ai-credit-usd-v1'}},`fixture-${team}`);teams[team]=account as typeof teams[string];
 await sdk.wallets.grant(teams[team].wallet.id,{amount_units:team==='alpha'?'100000':'200000',source:'internal',external_reference:`synthetic-${team}`,terms_version:'fixture-v1',expires_at:null,reason:'Synthetic fixture balance'},`fixture-grant-${team}`);
}
const users=fixtureUsers();
const sessions=new Map<string,{user:string;expires:number}>();
const sessionId=(request:Request)=>(request.headers.get('cookie')??'').split(';').map(part=>part.trim()).find(part=>part.startsWith('fixture_session='))?.slice('fixture_session='.length);
const current=(request:Request)=>{const session=sessions.get(sessionId(request)??'');return session&&session.expires>Date.now()?session:null};
const origin='http://127.0.0.1:4327';
const cookie=(value:string)=>`fixture_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value?3600:0}`;
const admin=createAdminBackend({
 loadConfig:async()=>({api_url:apiUrl,admin_token:token,account_id:teams.alpha.id,wallet_id:teams.alpha.wallet.id}),
 auth:{mode:'external',publicOrigin:origin,loginUrl:'/',adapter:{
  async authenticate(request){const session=current(request);const role=session&&users[session.user]?.role;if(session&&!role)throw new SessionError(403,'Staff access is required.');return session&&role?{version:1,kind:'staff',user_id:session.user,role}:null;},
  async logout(request){sessions.delete(sessionId(request)??'');return Response.json({ok:true},{headers:{'set-cookie':cookie('')}});},
 }},
});
async function parent(request:Request):Promise<Response>{
 const path=new URL(request.url).pathname;
 if(request.method!=='GET'&&(request.method!=='POST'||request.headers.get('origin')!==origin||!request.headers.get('content-type')?.startsWith('application/json')))return Response.json({error:'Invalid request origin or method'},{status:403});
 const body=request.method==='POST'?await request.json():{};
 if(path==='/fixture/login'&&request.method==='POST'){
  if(!Object.hasOwn(users,body.user))return Response.json({error:'Unknown fixture user'},{status:422});
  const id=randomUUID();sessions.set(id,{user:body.user,expires:Date.now()+3600000});return Response.json({ok:true},{headers:{'set-cookie':cookie(id)}});
 }
 const session=current(request);if(!session)return Response.json({error:'Fixture session expired'},{status:401});
 if(path==='/fixture/session')return Response.json({user:session.user,teams:[...users[session.user].teams],role:users[session.user].role??null,product_roles:users[session.user].productRoles});
 if(path==='/fixture/product-action')return productActionResponse(new Request(request.url,{method:request.method,headers:request.headers,...(request.method==='POST'?{body:JSON.stringify(body)}:{})}),session.user,users,teams,async(identity,action)=>{
  // Synthetic authorization demonstration only; never submits a model request.
  const team=Object.values(teams).find(account=>account.id===identity.account_id)!;
  await sdk.forIdentity(identity).wallets.get(team.wallet.id);
  return {authorized:true,action,account_id:identity.account_id,execution:'synthetic_access_check_only'};
 });
 if(path==='/fixture/control'&&request.method==='POST'){
  if(body.action==='revoke-session')sessions.delete(sessionId(request)!);
  else if(body.action==='remove-alice-alpha')users.alice.teams.delete('alpha');
  else if(body.action==='downgrade-admin')users.admin.role='viewer';
  else if(body.action==='reset'){users.alice.teams.add('alpha');users.admin.role='admin';}
  else return Response.json({error:'Unknown fixture control'},{status:422});
  return Response.json({ok:true});
 }
 if(path==='/fixture/events'&&request.method==='GET'){
  const team=new URL(request.url).searchParams.get('team')??'';
  if(!users[session.user].teams.has(team)||!Object.hasOwn(teams,team))return Response.json({error:'Current membership does not allow this team'},{status:403});
  const abort=new AbortController();let stop=()=>{};
  const stream=new ReadableStream<Uint8Array>({start(controller){
   let closed=false;const encoder=new TextEncoder();
   const valid=()=>current(request)?.user===session.user&&users[session.user].teams.has(team);
   const close=()=>{if(closed)return;closed=true;clearInterval(timer);abort.abort();controller.close();request.signal.removeEventListener('abort',close)};
   stop=close;
   const send=(value:unknown)=>{if(!closed)controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))};
   const timer=setInterval(()=>{if(!valid())close()},500);
   request.signal.addEventListener('abort',close,{once:true});
   send({status:'connected',team});
   const client=sdk.forIdentity({version:1,kind:'user',user_id:session.user,account_id:teams[team].id});
   void(async()=>{try{for await(const event of client.events({account_id:teams[team].id,signal:abort.signal})){if(!valid()){close();break}send(event)}}catch{close()}})();
  },cancel(){stop()}});
  return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'}});
 }
 if(path==='/fixture/balance'&&request.method==='GET'){
  const team=new URL(request.url).searchParams.get('team')??'';
  if(!users[session.user].teams.has(team)||!Object.hasOwn(teams,team))return Response.json({error:'Current membership does not allow this team'},{status:403});
  const account=teams[team];const client=sdk.forIdentity({version:1,kind:'user',user_id:session.user,account_id:account.id});
  return Response.json({team,account_id:account.id,wallet:await client.wallets.get(account.wallet.id)});
 }
 return Response.json({error:'Unknown fixture endpoint'},{status:404});
}
const require=createRequire(resolve('apps/admin/package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
const {default:tailwind}=await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
// The host owns database cleanup; Vite's default SIGTERM listener exits too early.
const previousSigtermListeners=new Set(process.listeners('SIGTERM'));
const vite=await createServer({configFile:false,root:resolve('apps/admin/test/fixtures/external-host'),plugins:[react(),tailwind(),{name:'synthetic-parent-backend',configureServer(server:any){server.middlewares.use(async(incoming:IncomingMessage,outgoing:ServerResponse,next:()=>void)=>{
 if(!incoming.url?.startsWith('/fixture/')&&!incoming.url?.startsWith('/api/uai-admin')){next();return;}
 try{const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));const abort=new AbortController();outgoing.on('close',()=>abort.abort());const request=new Request(new URL(incoming.url,origin),{signal:abort.signal,method:incoming.method,headers:incoming.headers as Record<string,string>,...(chunks.length?{body:Buffer.concat(chunks)}:{})});const response=await(incoming.url.startsWith('/api/uai-admin')?admin(request):parent(request));outgoing.statusCode=response.status;response.headers.forEach((value,key)=>outgoing.setHeader(key,value));outgoing.setHeader('cache-control','no-store');if(response.headers.get('content-type')?.startsWith('text/event-stream')&&response.body){outgoing.flushHeaders();const reader=response.body.getReader();try{while(!abort.signal.aborted){const next=await reader.read();if(next.done)break;outgoing.write(Buffer.from(next.value));}}finally{await reader.cancel();outgoing.end();}}else outgoing.end(Buffer.from(await response.arrayBuffer()));}catch(error){outgoing.statusCode=error instanceof UaiError?error.status:500;outgoing.setHeader('content-type','application/json');outgoing.end(JSON.stringify({error:error instanceof UaiError?error.message:'Fixture request failed'}));}
 });}}],server:{host:'127.0.0.1',port:4327,strictPort:true,fs:{allow:[resolve('.')]}}});
await vite.listen();
for(const listener of process.listeners('SIGTERM'))if(!previousSigtermListeners.has(listener))process.removeListener('SIGTERM',listener);
console.log(JSON.stringify({parent:origin,admin:`${origin}/admin`,users:Object.keys(users),teams:Object.keys(teams),synthetic:true,real_providers:false}));
let closing=false;async function close(){if(closing)return;closing=true;await vite.close();await api.close();await database.close();process.exit(0)}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());

} catch(error) {await database.close();throw error;}
