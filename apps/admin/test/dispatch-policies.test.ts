// @vitest-environment jsdom
import {createElement} from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {DispatchPolicies} from '../../../packages/admin-module/src/components/dispatch-policies';
import * as client from '../../../packages/admin-module/src/client';
afterEach(()=>{cleanup();vi.restoreAllMocks()});
const policies=[{queue_kind:'text',account_limit:2,application_limit:32,queue_limit:128,active_account_limit:2,active_application_limit:16,active_queue_limit:32,revision:3}];
test('saves typed limits with their revision and preserves the draft after a conflict',async()=>{
 const saved=vi.fn(),send=vi.spyOn(client,'command').mockRejectedValueOnce(new Error('Queue policy changed; reload it before saving')).mockResolvedValueOnce({revision:4});
 render(createElement(DispatchPolicies,{policies,onSaved:saved}));
 fireEvent.click(screen.getByRole('button',{name:'Edit Text queue'}));
 fireEvent.change(screen.getByRole('spinbutton',{name:'Published jobs: Per account'}),{target:{value:'4'}});
 fireEvent.change(screen.getByLabelText('Reason for change'),{target:{value:'Expected test traffic'}});
 fireEvent.click(screen.getByRole('button',{name:'Save limits'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Queue policy changed; reload it before saving');
 expect((screen.getByRole('spinbutton',{name:'Published jobs: Per account'}) as HTMLInputElement).value).toBe('4');
 expect(send.mock.calls[0]).toMatchObject(['dispatch_policy_update',{revision:3,settings:{account_limit:4,application_limit:32,queue_limit:128,active_account_limit:2,active_application_limit:16,active_queue_limit:32},reason:'Expected test traffic'},expect.any(String),'text']);
 fireEvent.click(screen.getByRole('button',{name:'Save limits'}));
 await waitFor(()=>expect(saved).toHaveBeenCalledWith({revision:4}));
 expect(send.mock.calls[1][2]).toBe(send.mock.calls[0][2]);
});
test('rejects inverted limits and exposes monitoring while disabling missing migrations',async()=>{
 const send=vi.spyOn(client,'command');render(createElement(DispatchPolicies,{policies:[...policies,{...policies[0],queue_kind:'observe'},{queue_kind:'image',account_limit:2,application_limit:32,queue_limit:128,revision:1}],onSaved:()=>{}}));
 expect((screen.getByRole('button',{name:'Edit Job monitoring queue'}) as HTMLButtonElement).disabled).toBe(false);
 expect((screen.getByRole('button',{name:'Edit Images queue'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Edit Text queue'}));
 fireEvent.change(screen.getByRole('spinbutton',{name:'Published jobs: Per account'}),{target:{value:'100'}});
 fireEvent.change(screen.getByLabelText('Reason for change'),{target:{value:'Test'}});
 fireEvent.click(screen.getByRole('button',{name:'Save limits'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Use account ≤ application ≤ whole queue, from 1 to 100000.');expect(send).not.toHaveBeenCalled();
});

test('saves monitoring limits without generation capacity fields',async()=>{
 const saved=vi.fn(),send=vi.spyOn(client,'command').mockResolvedValue({revision:4});
 render(createElement(DispatchPolicies,{policies:[{...policies[0],queue_kind:'observe'}],onSaved:saved}));
 fireEvent.click(screen.getByRole('button',{name:'Edit Job monitoring queue'}));
 expect(screen.queryByRole('spinbutton',{name:'Running tasks: Per account'})).toBeNull();
 fireEvent.change(screen.getByRole('spinbutton',{name:'Concurrent checks: Per account'}),{target:{value:'3'}});
 fireEvent.change(screen.getByLabelText('Reason for change'),{target:{value:'More observation capacity'}});
 fireEvent.click(screen.getByRole('button',{name:'Save limits'}));
 await waitFor(()=>expect(saved).toHaveBeenCalled());
 expect(send.mock.calls[0][1]).toEqual({revision:3,settings:{account_limit:3,application_limit:32,queue_limit:128},reason:'More observation capacity'});
});
test('validates running capacity independently of publication capacity',async()=>{
 const send=vi.spyOn(client,'command');render(createElement(DispatchPolicies,{policies,onSaved:()=>{}}));
 fireEvent.click(screen.getByRole('button',{name:'Edit Text queue'}));
 fireEvent.change(screen.getByRole('spinbutton',{name:'Running tasks: Per account'}),{target:{value:'17'}});
 fireEvent.change(screen.getByLabelText('Reason for change'),{target:{value:'Invalid active capacity'}});
 fireEvent.click(screen.getByRole('button',{name:'Save limits'}));
 expect(await screen.findByRole('alert')).toBeTruthy();expect(send).not.toHaveBeenCalled();
});
