// @vitest-environment jsdom
import {createElement,useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {StructuredEditor} from '../../../packages/admin-module/src/components/structured-editor';
import {editorSchemas,scopeSchema} from '../../../packages/admin-module/src/components/editor-schema';
import {CommandDialog,type CommandForm} from '../../../packages/admin-module/src/components/command-dialog';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()});
function Editor({initial,schema=scopeSchema}:any){const [value,setValue]=useState(JSON.stringify(initial));return createElement('form',{},createElement(StructuredEditor,{value,onChange:setValue,schema}),createElement('output',{'data-testid':'value'},value));}
it('keeps arbitrary provider scope fields when editing fields and switching to JSON',()=>{
 render(createElement(Editor,{initial:{organization_id:'org-a',custom:{x:1}}}));
 fireEvent.change(screen.getByLabelText('Organization ID'),{target:{value:'org-b'}});
 fireEvent.click(screen.getByRole('button',{name:'Edit JSON'}));
 expect(JSON.parse((screen.getByLabelText('Account scope JSON') as HTMLTextAreaElement).value)).toEqual({organization_id:'org-b',custom:{x:1}});
 fireEvent.change(screen.getByLabelText('Account scope JSON'),{target:{value:'{"organization_id":"org-c","custom":{"x":2}}'}});
 fireEvent.click(screen.getByRole('button',{name:'Use fields'}));
 expect((screen.getByLabelText('Organization ID') as HTMLInputElement).value).toBe('org-c');
 expect(JSON.parse(screen.getByTestId('value').textContent!).custom).toEqual({x:2});
});
it('retains invalid JSON instead of silently saving the previous valid value',()=>{
 render(createElement(Editor,{initial:{organization_id:'org-a'}}));
 fireEvent.click(screen.getByRole('button',{name:'Edit JSON'}));
 fireEvent.change(screen.getByLabelText('Account scope JSON'),{target:{value:'{"broken":'}});
 expect(screen.getByTestId('value').textContent).toBe('{"broken":');
 fireEvent.click(screen.getByRole('button',{name:'Use fields'}));
 expect(screen.getByRole('alert').textContent).toContain('Invalid JSON');
});
it('edits a route USD cap without losing optional fallback or policy data',()=>{
 const primary={connection_id:'c',catalog_version_id:'m',model:'gpt',max_cost_units:'1000000001'};
 render(createElement(Editor,{initial:{primary,capability:'text.generate',deadline_seconds:1800,platform_risk_budget_units:'9000000000',extra:{preserve:true}},schema:editorSchemas.routes}));
 fireEvent.change(screen.getByLabelText('Maximum cost, USD'),{target:{value:'2.000000001'}});
 const result=JSON.parse(screen.getByTestId('value').textContent!);
 expect(result.primary.max_cost_units).toBe('2000000001');expect(result.extra).toEqual({preserve:true});
 fireEvent.click(screen.getByRole('button',{name:'Add fallback provider'}));
 expect(JSON.parse(screen.getByTestId('value').textContent!).fallback).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Remove fallback provider'}));
 expect(JSON.parse(screen.getByTestId('value').textContent!).fallback).toBeUndefined();
});
it('submits exact USD units with the original optimistic concurrency guard',async()=>{
 HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};HTMLDialogElement.prototype.close=function(){};
 const fetchMock=vi.fn(async(_:any,init:any)=>({ok:true,json:async()=>init?{ok:true}:{data:[]}}));vi.stubGlobal('fetch',fetchMock);
 const done=vi.fn();const form:CommandForm={title:'Edit budget',description:'Budget',action:'budget_update',fields:[{key:'limit_units',label:'Limit',value:'1000000001'},{key:'reason',label:'Reason',value:'Update'}],map:v=>({...v,expected_limit_units:'1000000001'})};
 render(createElement(CommandDialog,{form,onClose:()=>{},onDone:done}));
 fireEvent.change(screen.getByLabelText('Budget limit, USD'),{target:{value:'900719925474.099999999'}});
 fireEvent.submit(screen.getByRole('button',{name:'Save'}).closest('form')!);
 await vi.waitFor(()=>expect(done).toHaveBeenCalled());
 const post=fetchMock.mock.calls.find(([,init])=>init?.method==='POST')!;
 expect(JSON.parse(post[1].body).data).toEqual({limit_units:'900719925474099999999',reason:'Update',expected_limit_units:'1000000001'});
});
it('preserves nested pricing conditions when changing a displayed rate',()=>{
 const rate={id:'input',dimension:'input.uncached',unit:'tokens',unit_size:'1000',amount:'0.001',effective_from:'2026-01-01T00:00:00Z',conditions:{tier:'priority',cached:false},custom:{x:1}};
 render(createElement(Editor,{schema:editorSchemas.rates,initial:{id:'card',currency:'USD',source:'fixture',checked_at:'2026-01-01T00:00:00Z',rates:[rate]}}));
 fireEvent.change(screen.getByLabelText('Price, USD'),{target:{value:'0.00000000001'}});
 const result=JSON.parse(screen.getByTestId('value').textContent!);
 expect(result.rates[0]).toEqual({...rate,amount:'0.00000000001'});
});
it('does not leave fields mode and discard an invalid USD draft',()=>{
 render(createElement(Editor,{initial:{primary:{connection_id:'c',catalog_version_id:'m',model:'gpt',max_cost_units:'1'},capability:'text.generate',deadline_seconds:1800,platform_risk_budget_units:'1'},schema:editorSchemas.routes}));
 fireEvent.change(screen.getByLabelText('Maximum cost, USD'),{target:{value:'wrong'}});
 fireEvent.click(screen.getByRole('button',{name:'Edit JSON'}));
 expect((screen.getByLabelText('Maximum cost, USD') as HTMLInputElement).value).toBe('wrong');
 expect(screen.queryByLabelText('Route JSON')).toBeNull();
});

it('edits fixed credits without losing ledger precision',()=>{
 render(createElement(Editor,{initial:{price:'1234567'},schema:{label:'Price',type:'object',fields:{price:{label:'Fixed credits',type:'credits'}}}}));
 expect((screen.getByLabelText('Fixed credits') as HTMLInputElement).value).toBe('1.234567');fireEvent.change(screen.getByLabelText('Fixed credits'),{target:{value:'9.876543'}});expect(JSON.parse(screen.getByTestId('value').textContent!).price).toBe('9876543');
});
it('shows published settings without permitting a mutation or implicit submit',async()=>{
 HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};HTMLDialogElement.prototype.close=function(){};
 const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({data:[]})}));vi.stubGlobal('fetch',fetchMock);
 const close=vi.fn(),done=vi.fn();
 render(createElement(CommandDialog,{form:{readOnly:true,title:'Current pricing',description:'Version 1',action:'rates_update',fields:[{key:'payload',label:'Settings',type:'json',value:{id:'price',currency:'USD',source:'test',checked_at:'2026-09-19T00:00:00Z',rates:[]}}]},onClose:close,onDone:done}));
 expect(screen.queryByRole('button',{name:'Save'})).toBeNull();
 expect(screen.getByRole('dialog').querySelector('fieldset')?.disabled).toBe(true);
 fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
 await vi.waitFor(()=>expect(fetchMock).toHaveBeenCalled());
 expect(fetchMock.mock.calls.every(call=>(call as unknown as [unknown,RequestInit?])[1]?.method!=='POST')).toBe(true);expect(done).not.toHaveBeenCalled();
 fireEvent.click(screen.getAllByRole('button',{name:'Close'}).at(-1)!);expect(close).toHaveBeenCalledOnce();
});
it('switches catalog models without losing edits or custom configuration',()=>{
 const initial={extra:'keep',models:[{id:'gpt-4.1',provider:'openai',status:'active',capabilities:['text.generate'],allowed_parameters:[],custom:{keep:1}},{id:'gpt-4.1-nano',provider:'openai',status:'active',capabilities:['text.generate'],allowed_parameters:[]}]};
 render(createElement(Editor,{initial,schema:editorSchemas.models}));
 const picker=screen.getByRole('combobox',{name:'Model 2 in catalog'});
 fireEvent.change(screen.getByRole('textbox',{name:'Model ID'}),{target:{value:'gpt-4.1-custom'}});
 fireEvent.change(picker,{target:{value:'1'}});
 expect((screen.getByRole('textbox',{name:'Model ID'}) as HTMLInputElement).value).toBe('gpt-4.1-nano');
 fireEvent.change(picker,{target:{value:'0'}});
 expect((screen.getByRole('textbox',{name:'Model ID'}) as HTMLInputElement).value).toBe('gpt-4.1-custom');
 const result=JSON.parse(screen.getByTestId('value').textContent!);
 expect(result.extra).toBe('keep');expect(result.models[0].custom).toEqual({keep:1});expect(result.models[1]).toEqual(initial.models[1]);
 fireEvent.click(screen.getByRole('button',{name:'Add model'}));
 expect((picker as HTMLSelectElement).value).toBe('2');
 fireEvent.click(screen.getByRole('button',{name:'Remove model'}));
 expect(JSON.parse(screen.getByTestId('value').textContent!).models).toHaveLength(2);
});
it('allows selecting a different published model while keeping settings disabled',async()=>{
 HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};HTMLDialogElement.prototype.close=function(){};
 const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({data:[]})}));vi.stubGlobal('fetch',fetchMock);
 const models=['gpt-4.1','gpt-4.1-nano'].map(id=>({id,provider:'openai',status:'active',capabilities:['text.generate'],allowed_parameters:[]}));
 render(createElement(CommandDialog,{form:{readOnly:true,title:'Models',description:'Published',action:'models_update',fields:[{key:'payload',label:'Settings',type:'json',value:{models}}]},onClose:()=>{},onDone:vi.fn()}));
 const picker=screen.getByRole('combobox',{name:'Model 2 in catalog'});
 expect(picker.matches(':disabled')).toBe(false);
 fireEvent.change(picker,{target:{value:'1'}});
 const input=screen.getByRole('textbox',{name:'Model ID'}) as HTMLInputElement;
 expect(input.value).toBe('gpt-4.1-nano');expect(input.matches(':disabled')).toBe(true);
 expect(screen.queryByRole('button',{name:'Save'})).toBeNull();expect(screen.queryByRole('button',{name:'Add model'})).toBeNull();
 await vi.waitFor(()=>expect(fetchMock).toHaveBeenCalled());
 expect(fetchMock.mock.calls.every(call=>(call as unknown as [unknown,RequestInit?])[1]?.method!=='POST')).toBe(true);
});
