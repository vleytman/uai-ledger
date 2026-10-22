import {expect,test,vi} from 'vitest';
import {createAdminBackend} from '@uai/admin-module/server';
import {sessions} from '../../../packages/web-session/src/index.js';
const conf={api_url:'https://uai.invalid',admin_token:'server-only',account_id:'account',wallet_id:'wallet',session_secret:'x'.repeat(32),login_password:'test-owner-password'};
const cookie=sessions('uai_admin',conf.session_secret,conf.login_password,'en').login(new Request('https://admin.fixture/api'),conf.login_password).split(';')[0];
test('product reads require the same owner session and cannot receive service credentials',async()=>{
 const read=vi.fn(async context=>context);
 const handle=createAdminBackend({loadConfig:async()=>conf,reads:{'app.product.settings':read}});
 expect((await handle(new Request('https://admin.fixture/api?view=app.product.settings'))).status).toBe(401);
 expect(read).not.toHaveBeenCalled();
 const response=await handle(new Request('https://admin.fixture/api?view=app.product.settings',{headers:{cookie}}));
 expect(await response.json()).toEqual({account_id:'account',wallet_id:'wallet'});
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect((await handle(new Request('https://admin.fixture/api?view=app.unknown.settings',{headers:{cookie}}))).status).toBe(404);
});
test('commands require origin and command identity; extensions cannot override UAI commands',async()=>{
 expect(()=>createAdminBackend({commands:{grant:async()=>({})}})).toThrow();
 const command=vi.fn(async context=>({key:context.key}));
 const handle=createAdminBackend({loadConfig:async()=>conf,commands:{'app.product.save':command}});
 const send=(origin:string,key?:string)=>handle(new Request('https://admin.fixture/api',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({action:'app.product.save',key,data:{name:'New'}})}));
 expect((await send('https://evil.fixture','one')).status).toBe(403);
 expect((await send('https://admin.fixture')).status).toBe(422);
 expect(command).not.toHaveBeenCalled();
 expect(await (await send('https://admin.fixture','one')).json()).toEqual({key:'one'});
 expect(command).toHaveBeenCalledWith({account_id:'account',wallet_id:'wallet',key:'one',data:{name:'New'},id:undefined});
});
