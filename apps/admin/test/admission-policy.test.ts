// @vitest-environment jsdom
import {createElement} from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {AdmissionPolicy} from '../../../packages/admin-module/src/components/admission-policy';
import * as client from '../../../packages/admin-module/src/client';
afterEach(()=>{cleanup();vi.restoreAllMocks()});
test('keeps a conflicted draft and explicitly reloads the current revision',async()=>{
 const policy={account_limit:20,application_limit:200,max_queue_age_ms:900000,revision:1,enabled:true};
 vi.spyOn(client,'api').mockResolvedValueOnce(policy).mockResolvedValueOnce({...policy,account_limit:15,revision:2});
 const send=vi.spyOn(client,'command').mockRejectedValue(new Error('Admission limits changed; reload before saving'));
 render(createElement(AdmissionPolicy));
 fireEvent.click(await screen.findByRole('button',{name:'Edit admission limits'}));
 fireEvent.change(screen.getByLabelText('Oldest queued task, min'),{target:{value:'10'}});
 fireEvent.change(screen.getByLabelText('Admission change reason'),{target:{value:'Expected traffic'}});
 fireEvent.click(screen.getByRole('button',{name:'Save admission limits'}));
 expect((await screen.findByRole('alert')).textContent).toContain('reload before saving');
 expect((screen.getByLabelText('Oldest queued task, min') as HTMLInputElement).value).toBe('10');
 expect(send.mock.calls[0]).toMatchObject(['admission_policy_update',{revision:1,settings:{account_limit:20,application_limit:200,max_queue_age_ms:600000},reason:'Expected traffic'},expect.any(String)]);
 fireEvent.click(screen.getByRole('button',{name:'Reload limits'}));
 await screen.findByText('Enabled · Revision 2');
 expect(screen.queryByRole('button',{name:'Save admission limits'})).toBeNull();
 expect(screen.getAllByText('15')).toHaveLength(2);
});
