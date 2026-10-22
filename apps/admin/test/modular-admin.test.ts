// @vitest-environment jsdom
import {createElement} from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {UaiAdmin,type AdminApplication} from '@uai/admin-module';
import {pageKey,registerModules} from '@uai/admin-shell/registry';
afterEach(()=>{cleanup();vi.unstubAllGlobals();window.history.replaceState(null,'','#overview')});
test('does not render connection records as quota groups during navigation',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>{
  const view=new URL(String(input),'http://localhost').searchParams.get('view');
  if(view==='session')return Response.json({authenticated:true,account_id:'account',wallet_id:'wallet'});
  if(view==='providers')return Response.json({data:[{id:'connection',name:'Quiver fixture',provider:'quiver',enabled:true,credential_status:'missing'}]});
  return Response.json({data:[]});
 }));
 window.history.replaceState(null,'','#providers');render(createElement(UaiAdmin));
 expect(await screen.findByText('Quiver fixture')).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'Provider quotas'}));
 expect(await screen.findByText('No quota groups configured.')).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'Connections'}));
 expect(await screen.findByText('Quiver fixture')).toBeTruthy();
 window.location.hash='#provider_quotas';fireEvent(window,new HashChangeEvent('hashchange'));
 expect(await screen.findByText('No quota groups configured.')).toBeTruthy();
});
test('rejects duplicate routes and invalid namespaces before rendering',()=>{
 expect(()=>registerModules([{id:'one',label:'One',pages:[{id:'settings',label:'Settings'},{id:'settings',label:'Again'}]}])).toThrow();
 expect(()=>pageKey('../uai','settings')).toThrow();
 expect(()=>registerModules([{id:'one',label:'One',pages:[{id:'home',label:'Home'}]},{id:'one',label:'Again',pages:[{id:'other',label:'Other'}]}])).toThrow();
});
test('composes a product page and UAI with one session, refresh, and hash navigation',async()=>{
 const fetcher=vi.fn(async(input:unknown)=>{
  const view=new URL(String(input),'http://localhost').searchParams.get('view');
  return Response.json(view==='session'?{authenticated:true,account_id:'account',wallet_id:'wallet'}:{data:[]});
 });vi.stubGlobal('fetch',fetcher);
 const application:AdminApplication={brand:{name:'Example product',tagline:'Product administration'},modules:[{id:'product',label:'Product',pages:[{id:'settings',label:'Application settings',component:({session,refresh})=>createElement('p',null,`Settings for ${session.account_id}, refresh ${refresh}`)}]}]};
 window.history.replaceState(null,'','#app.product.settings');
 render(createElement(UaiAdmin,{application}));
 expect(await screen.findByText('Settings for account, refresh 0')).toBeTruthy();
 expect(fetcher).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'Refresh data'}));
 expect(await screen.findByText('Settings for account, refresh 1')).toBeTruthy();
 fireEvent.click(screen.getByRole('link',{name:'Wallets'}));
 await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).includes('view=wallets'))).toBe(true));
 fireEvent.click(screen.getByRole('link',{name:'Application settings'}));
 expect(await screen.findByText('Settings for account, refresh 1')).toBeTruthy();
 expect(screen.getAllByRole('navigation')).toHaveLength(1);
 expect(window.location.hash).toBe('#app.product.settings');
 fireEvent.click(screen.getByRole('button',{name:'Sign out'}));
 expect(await screen.findByRole('heading',{name:'Sign in to administration'})).toBeTruthy();
 expect(screen.queryByText('Settings for account, refresh 1')).toBeNull();
});

test('retains the selected quota group across save and the parent loading remount',async()=>{
 const first={id:'quota-a',name:'First',provider:'fake',source:'Synthetic',checked_at:null,settings_revision:1,rules_revision:1,concurrency_limit:4,held_slots:0,blocked_until:null,rules:[{key:'rpm',metric:'requests',capacity:'60',window_ms:60000}],bindings:[]};
 let second={...first,id:'quota-b',name:'Second'};
 let quotaReads=0;
 vi.stubGlobal('fetch',vi.fn(async(input:unknown,options?:RequestInit)=>{
  if(options?.method==='POST'){
   const body=JSON.parse(String(options.body));expect(body.action).toBe('quota_settings_update');expect(body.id).toBe('quota-b');
   second={...second,...body.data.settings,settings_revision:2};return Response.json(second);
  }
  const view=new URL(String(input),'http://localhost').searchParams.get('view');
  if(view==='session')return Response.json({authenticated:true,account_id:'account',wallet_id:'wallet'});
  if(view==='provider_quotas'){quotaReads++;return Response.json({data:[first,second]})}
  return Response.json({status:'not_configured',rules:[]});
 }));
 window.history.replaceState(null,'','#provider_quotas');render(createElement(UaiAdmin));
 fireEvent.change(await screen.findByLabelText('Quota group'),{target:{value:'quota-b'}});
 fireEvent.click(screen.getByRole('button',{name:'Edit group settings'}));
 fireEvent.change(screen.getByLabelText('Group name'),{target:{value:'Second updated'}});
 fireEvent.change(screen.getByLabelText('Quota change reason'),{target:{value:'Verify preserved selection'}});
 fireEvent.click(screen.getByRole('button',{name:'Save group settings'}));
 await waitFor(()=>expect(quotaReads).toBe(2));
 await waitFor(()=>expect((screen.getByLabelText('Quota group') as HTMLSelectElement).value).toBe('quota-b'));
 expect(screen.getByRole('option',{name:'Second updated · fake'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Refresh data'}));
 await waitFor(()=>expect(quotaReads).toBe(3));
 await waitFor(()=>expect((screen.getByLabelText('Quota group') as HTMLSelectElement).value).toBe('quota-b'));
});

test('external sign-in uses host link and never shows a local password form',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({mode:'external',login_url:'https://admin.fixture/signin',error:{message:'Sign in to continue.'}},{status:401})));
 render(createElement(UaiAdmin));
 expect((await screen.findByRole('link',{name:'Sign in with your application'})).getAttribute('href')).toBe('https://admin.fixture/signin');
 expect(screen.queryByLabelText('Administrator password')).toBeNull();
});

test('viewer can navigate and inspect wallets while mutation controls are disabled',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>{
  const view=new URL(String(input),'http://localhost').searchParams.get('view');
  if(view==='session')return Response.json({authenticated:true,account_id:'account',wallet_id:'wallet',mode:'external',role:'viewer',identity:{version:1,kind:'staff',user_id:'reader',role:'viewer'},capabilities:{readViews:['overview','wallets','wallet','lots','journal'],actions:[]}});
  if(view==='wallet')return Response.json({id:'wallet',account_id:'account',available_units:'0',reserved_units:'0',balance_units:'0'});
  return Response.json({data:[]});
 }));
 window.history.replaceState(null,'','#wallet/wallet');render(createElement(UaiAdmin));
 const grant=await screen.findByRole('button',{name:'Grant credits'});expect((grant as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByRole('button',{name:'All wallets'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'All wallets'}));expect(await screen.findByRole('heading',{name:'Wallets'})).toBeTruthy();
});

test('explicit external refresh revalidates staff role before updating mutation controls',async()=>{
 let role='admin';let sessionReads=0;
 const fetcher=vi.fn(async(input:unknown)=>{
  const view=new URL(String(input),'http://localhost').searchParams.get('view');
  if(view==='session'){sessionReads++;return Response.json({authenticated:true,account_id:'account',wallet_id:'wallet',mode:'external',role,identity:{version:1,kind:'staff',user_id:'operator',role},capabilities:{readViews:['providers'],actions:role==='admin'?['connection_create']:[]}})}
  return Response.json({data:[]});
 });vi.stubGlobal('fetch',fetcher);
 window.history.replaceState(null,'','#providers');render(createElement(UaiAdmin));
 expect(await screen.findByRole('button',{name:'Add provider'})).toBeTruthy();
 role='viewer';fireEvent.click(screen.getByRole('button',{name:'Refresh data'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Add provider'})).toBeNull());
 expect(sessionReads).toBe(2);expect(fetcher.mock.calls.every(([url])=>typeof url==='string')).toBe(true);
 expect(screen.getByRole('link',{name:'Wallets'})).toBeTruthy();
});
