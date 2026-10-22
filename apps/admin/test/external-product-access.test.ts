import {expect,test,vi} from 'vitest';
import {allowsProductAction,fixtureUsers,productActionResponse} from './fixtures/external-host/product-access.js';
const accounts={alpha:{id:'account-alpha'},beta:{id:'account-beta'}};
const request=(team:string,action:string,extra:Record<string,unknown>={})=>new Request('http://127.0.0.1/fixture/product-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({team,action,...extra})});
test('parent permission matrix is cumulative, independent of staff role',()=>{
 expect(['view','chat','generate'].map(action=>allowsProductAction('generate',action as 'view'|'chat'|'generate'))).toEqual([true,true,true]);
 expect(allowsProductAction('chat','view')).toBe(true);expect(allowsProductAction('view','chat')).toBe(false);expect(allowsProductAction(undefined,'view')).toBe(false);
});
test('Alice cannot generate in Alpha even with forged role, but can in Beta; transport gets no product roles',async()=>{
 const users=fixtureUsers(),run=vi.fn(async(identity,action)=>({identity,action}));
 expect((await productActionResponse(request('alpha','generate',{role:'generate',staff_role:'admin'}),'alice',users,accounts,run)).status).toBe(403);expect(run).not.toHaveBeenCalled();
 expect((await productActionResponse(request('alpha','chat'),'alice',users,accounts,run)).status).toBe(200);
 expect((await productActionResponse(request('beta','generate'),'alice',users,accounts,run)).status).toBe(200);
 expect(run).toHaveBeenLastCalledWith({version:1,kind:'user',user_id:'alice',account_id:'account-beta'},'generate');
 users.alice.teams.delete('beta');run.mockClear();expect((await productActionResponse(request('beta','generate'),'alice',users,accounts,run)).status).toBe(403);expect(run).not.toHaveBeenCalled();
});
test('view-only Bob and staff with no membership cannot generate; team-admin gets only user identity',async()=>{
 const users=fixtureUsers(),run=vi.fn(async identity=>({identity}));
 for(const user of ['bob','admin','viewer'])expect((await productActionResponse(request('alpha','generate'),user,users,accounts,run)).status).toBe(403);
 expect(run).not.toHaveBeenCalled();expect((await productActionResponse(request('alpha','generate'),'team-admin',users,accounts,run)).status).toBe(200);
 expect(run.mock.calls[0][0]).toEqual({version:1,kind:'user',user_id:'team-admin',account_id:'account-alpha'});
 expect((await productActionResponse(request('alpha','generate'),null,users,accounts,run)).status).toBe(401);
});
