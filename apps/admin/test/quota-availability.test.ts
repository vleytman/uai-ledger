// @vitest-environment jsdom
import {createElement} from 'react';
import {afterEach,test,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor,act} from '@testing-library/react';
import {QuotaAvailability} from '../../../packages/admin-module/src/components/quota-availability';
import type {QuotaGroup} from '../../../packages/admin-module/src/components/provider-quotas';
import * as client from '../../../packages/admin-module/src/client';
const group={id:'quota-a',rules_revision:1,rules:[{key:'rpm',metric:'requests'}]} as QuotaGroup;
const ready={group_id:'quota-a',rules_revision:1,status:'ready',sampled_at:'2026-09-19T12:00:00Z',rules:[{key:'rpm',used:'30',local_remaining:'70',available:'40',blocked_until:null,provider:null}]};
afterEach(()=>{cleanup();vi.restoreAllMocks()});
test('keeps failed refresh visibly outdated, recovers, and refuses mismatched revisions',async()=>{
 const api=vi.spyOn(client,'api').mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({...ready,rules_revision:2});
 render(createElement(QuotaAvailability,{group}));
 expect(await screen.findByRole('table',{name:'Quota availability values'})).toBeTruthy();expect(screen.getByText('70')).toBeTruthy();expect(screen.getByText('40')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Refresh availability'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('may be outdated'));expect(screen.getByText(/Outdated/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Refresh availability'}));
 await waitFor(()=>expect(screen.queryByRole('table')).toBeNull());expect(screen.getByRole('alert').textContent).toContain('settings changed');
 expect(api.mock.calls.every(([view,id])=>view==='quota_snapshot'&&id===group.id)).toBe(true);
});
test('does not display a late snapshot from a previously selected group',async()=>{
 let complete!:(value:unknown)=>void;
 vi.spyOn(client,'api').mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve})).mockResolvedValueOnce({group_id:'quota-b',rules_revision:1,status:'not_ready',sampled_at:null,rules:[]});
 const view=render(createElement(QuotaAvailability,{group}));
 view.rerender(createElement(QuotaAvailability,{group:{...group,id:'quota-b'}}));
 expect(await screen.findByText('Quota state is being restored.')).toBeTruthy();
 await act(async()=>{complete(ready)});
 expect(screen.queryByRole('table')).toBeNull();expect(screen.getByText('Quota state is being restored.')).toBeTruthy();
});
