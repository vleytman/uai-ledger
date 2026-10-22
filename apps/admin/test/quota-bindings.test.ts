// @vitest-environment jsdom
import {createElement} from 'react';
import {afterEach,beforeEach,test,expect,vi} from 'vitest';
import {act,cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {QuotaBindings} from '../../../packages/admin-module/src/components/quota-bindings';
import type {QuotaGroup} from '../../../packages/admin-module/src/components/provider-quotas';
import * as client from '../../../packages/admin-module/src/client';
const groups:QuotaGroup[]=['a','b'].map(id=>({id,name:`Group ${id}`,provider:'openai',coordination_domain:'account',source:'fixture',checked_at:null,settings_revision:1,rules_revision:1,concurrency_limit:8,held_slots:0,blocked_until:null,rules:[],bindings:[]}));
const snapshot=(model='gpt-4.1',selected=['a'],revision='first')=>({connection_id:'conn',model,bindings_revision:revision,groups:groups.filter(g=>selected.includes(g.id))});
function options(view:string){if(view==='providers')return {data:[{id:'conn',name:'Production account',provider:'openai'}]};if(view==='models')return {data:[{status:'published',payload:{models:[{id:'gpt-4.1',provider:'openai',status:'active'},{id:'gpt-4.1-nano',provider:'openai',status:'active'},{id:'draft-only',provider:'openai',status:'disabled'}]}}]}}
beforeEach(()=>{vi.spyOn(client,'api').mockImplementation(async view=>options(view)??snapshot())});
afterEach(()=>{cleanup();vi.restoreAllMocks()});
async function open(onSaved=vi.fn()){
 render(createElement(QuotaBindings,{groups,disabled:false,onSaved,onEditingChange:vi.fn()}));fireEvent.click(screen.getByRole('button',{name:'Assign models'}));
 await screen.findByRole('option',{name:'Production account · openai'});
 fireEvent.change(screen.getByLabelText('Quota connection'),{target:{value:'conn'}});
 fireEvent.change(screen.getByLabelText('Quota model'),{target:{value:'gpt-4.1'}});
 return onSaved;
}
test('loads readable choices and preserves the exact failed command for a retry',async()=>{
 const command=vi.spyOn(client,'command').mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(snapshot('gpt-4.1',['a','b'],'second'));
 const onSaved=await open();await screen.findByLabelText('Assign Group a');
 expect(screen.queryByRole('option',{name:'draft-only'})).toBeNull();
 expect((screen.getByLabelText('Assign Group a') as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByLabelText('Assign Group b'));
 fireEvent.change(screen.getByLabelText('Quota assignment reason'),{target:{value:'Add shared group'}});
 fireEvent.click(screen.getByRole('button',{name:'Save assignments'}));expect((await screen.findByRole('alert')).textContent).toContain('Connection lost');
 fireEvent.click(screen.getByRole('button',{name:'Save assignments'}));await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());
 expect(command.mock.calls[0]).toEqual(command.mock.calls[1]);
 expect(command.mock.calls[0]).toEqual(['quota_bindings_update',{connection_id:'conn',model:'gpt-4.1',bindings_revision:'first',group_ids:['a','b'],reason:'Add shared group'},expect.any(String)]);
 expect(screen.getByRole('status').textContent).toBe('Model quota groups saved.');
});
test('ignores a late binding response for the previously selected model',async()=>{
 let resolveOld!:(value:unknown)=>void;const old=new Promise(resolve=>{resolveOld=resolve});
 vi.mocked(client.api).mockImplementation(async(view,_id,query)=>options(view)??(query?.model==='gpt-4.1'?old:snapshot('gpt-4.1-nano',['b'],'nano')));
 const command=vi.spyOn(client,'command').mockResolvedValue(snapshot('gpt-4.1-nano',['b'],'nano'));
 await open();await waitFor(()=>expect(client.api).toHaveBeenCalledWith('quota_bindings',undefined,{connection_id:'conn',model:'gpt-4.1'}));
 fireEvent.change(screen.getByLabelText('Quota model'),{target:{value:'gpt-4.1-nano'}});
 await screen.findByLabelText('Assign Group b');await act(async()=>{resolveOld(snapshot());await old});
 expect((screen.getByLabelText('Assign Group b') as HTMLInputElement).checked).toBe(true);
 expect((screen.getByLabelText('Assign Group a') as HTMLInputElement).checked).toBe(false);
 fireEvent.change(screen.getByLabelText('Quota assignment reason'),{target:{value:'Verify latest selection'}});
 fireEvent.click(screen.getByRole('button',{name:'Save assignments'}));await waitFor(()=>expect(command).toHaveBeenCalledOnce());
 expect(command.mock.calls[0][1]).toMatchObject({model:'gpt-4.1-nano',bindings_revision:'nano',group_ids:['b']});
});
test('keeps conflict edits until explicit reload and shows the fresh server assignment',async()=>{
 vi.spyOn(client,'command').mockRejectedValue(new Error('Quota bindings changed; reload before saving'));
 await open();await screen.findByLabelText('Assign Group a');fireEvent.click(screen.getByLabelText('Assign Group b'));
 fireEvent.change(screen.getByLabelText('Quota assignment reason'),{target:{value:'Change groups'}});
 fireEvent.click(screen.getByRole('button',{name:'Save assignments'}));await screen.findByRole('alert');
 expect((screen.getByLabelText('Assign Group b') as HTMLInputElement).checked).toBe(true);
 vi.mocked(client.api).mockImplementation(async view=>options(view)??snapshot('gpt-4.1',['b'],'newer'));
 fireEvent.click(screen.getByRole('button',{name:'Reload assignments'}));
 await waitFor(()=>expect((screen.getByLabelText('Assign Group a') as HTMLInputElement).checked).toBe(false));
 expect((screen.getByLabelText('Assign Group b') as HTMLInputElement).checked).toBe(true);
 expect(screen.queryByRole('alert')).toBeNull();
});
