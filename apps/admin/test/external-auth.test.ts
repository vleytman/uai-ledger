import {afterEach,expect,test,vi} from 'vitest';
import {createAdminBackend,type ExternalAdminAuth} from '@uai/admin-module/server';
import {decodeExternalIdentity} from '../../../packages/contracts/external-identity.js';
import {isViewerApiRead,canRunAdminAction} from '../../../packages/contracts/admin-access.js';
const conf={api_url:'https://api.fixture',admin_token:'secret',account_id:'account',wallet_id:'wallet'};
const staff=(role:'admin'|'viewer'='viewer')=>({version:1 as const,kind:'staff' as const,user_id:'person',role});
const setup=()=>{
 const authenticate=vi.fn(async()=>staff() as ReturnType<typeof staff>|null);
 const logout=vi.fn(async()=>Response.json({ok:true},{headers:{'set-cookie':'parent=; Max-Age=0'}}));
 const auth:ExternalAdminAuth={mode:'external',publicOrigin:'https://admin.fixture',loginUrl:'/signin',adapter:{authenticate,logout}};
 const fetcher=vi.fn(async()=>Response.json({capabilities:{external_identity:1}}));vi.stubGlobal('fetch',fetcher);
 return {auth,authenticate,logout,fetcher};
};
const req=(action:string,origin='https://admin.fixture')=>new Request('http://internal/api',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action,key:'command-1',data:{}})});
afterEach(()=>vi.unstubAllGlobals());
test('external viewer context is safe, fresh, forwarded and never grants mutation access',async()=>{
 const {auth,authenticate,fetcher}=setup();const handle=createAdminBackend({auth,loadConfig:async()=>conf});
 const session=await (await handle(new Request('http://internal/api?view=session'))).json();expect(session.role).toBe('viewer');expect(session.identity).toEqual(staff());expect(session.capabilities.actions).toEqual([]);expect(JSON.stringify(session)).not.toContain('secret');
 expect((await handle(req('grant'))).status).toBe(403);expect((await handle(req('unknown'))).status).toBe(403);
 await handle(new Request('http://internal/api?view=overview'));
 const options=fetcher.mock.calls.at(-1) as unknown as [URL,RequestInit];expect(decodeExternalIdentity((options[1].headers as Record<string,string>)['x-uai-context'])).toEqual(staff());
 authenticate.mockResolvedValueOnce(null);expect((await handle(new Request('http://internal/api?view=overview'))).status).toBe(401);
 authenticate.mockResolvedValueOnce(staff('admin'));expect((await handle(req('grant'))).status).toBe(422); // Missing target, permission passed.
});
test('external extensions require explicit read permissions; viewer commands always denied',async()=>{
 const {auth}=setup();const read=vi.fn(async context=>context);const command=vi.fn(async()=>({ok:true}));
 const handle=createAdminBackend({auth,loadConfig:async()=>conf,reads:{'app.product.default':read,'app.product.shared':read},commands:{'app.product.save':command},permissions:{reads:{'app.product.shared':['viewer']},commands:{'app.product.save':['viewer']}}});
 expect((await handle(new Request('http://internal/api?view=app.product.default'))).status).toBe(403);
 expect((await handle(new Request('http://internal/api?view=app.product.shared'))).status).toBe(200);
 expect(read).toHaveBeenCalledWith({account_id:'account',wallet_id:'wallet',identity:staff(),role:'viewer'});
 expect((await handle(req('app.product.save'))).status).toBe(403);expect(command).not.toHaveBeenCalled();
});
test('resolver failure, invalid roles, old APIs and forged origin fail closed; expired logout clears parent cookie',async()=>{
 const {auth,authenticate,logout,fetcher}=setup();const handle=createAdminBackend({auth,loadConfig:async()=>conf});
 expect((await handle(req('logout','https://evil.fixture'))).status).toBe(403);expect(logout).not.toHaveBeenCalled();
 authenticate.mockResolvedValue(null);const out=await handle(req('logout'));expect(out.headers.get('set-cookie')).toContain('parent=');
 const missing=await handle(req('login'));expect(missing.status).toBe(401);expect((await missing.json()).login_url).toBe('https://admin.fixture/signin');
 authenticate.mockRejectedValueOnce(new Error('session DB failed'));expect((await handle(req('login'))).status).toBe(503);
 authenticate.mockResolvedValue(staff());fetcher.mockResolvedValue(Response.json({status:'ok'}));expect((await handle(new Request('http://internal/api?view=session'))).status).toBe(503);
 authenticate.mockResolvedValue({...staff(),role:'owner'} as never);expect((await handle(new Request('http://internal/api?view=session'))).status).toBe(403);
 expect((await handle(new Request('http://internal/api',{method:'DELETE'}))).status).toBe(405);
 expect(()=>createAdminBackend({auth:{...auth,loginUrl:'https://evil.fixture/'}})).toThrow();
});
test('viewer API allowlist denies content and unknown routes and every mutation method',()=>{
 expect(isViewerApiRead('GET','/v1/admin/overview')).toBe(true);
 for(const route of ['/v1/assets/:id','/v1/requests/:id/result','/v1/admin/new-command'])expect(isViewerApiRead('GET',route)).toBe(false);
 expect(isViewerApiRead('POST','/v1/admin/overview')).toBe(false);expect(canRunAdminAction('unknown','admin')).toBe(false);
});
