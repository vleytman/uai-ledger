// @vitest-environment jsdom
import {createElement} from 'react';
import {afterEach,test,expect} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {QueueWaitReason} from '../../../packages/admin-module/src/components/queue-wait-reason';
afterEach(cleanup);
const details={group_id:'group',group_name:'OpenAI · image generation',rule:'ipm',metric:'images',window_ms:60000,demand:'1',available:'0',capacity:'150',checked_at:'2026-09-20T10:00:00Z'};
test('shows the rule and numbers explicitly as the last check, not current availability',()=>{
 render(createElement(QueueWaitReason,{reason:'waiting_rate_limit',status:'waiting_retry',details}));
 expect(screen.getByLabelText('Quota wait details').textContent).toContain('OpenAI · image generation · Images / minute');
 expect(screen.getByText('Needs 1 · Available 0 · Limit 150')).toBeTruthy();expect(screen.getByText(/At last check/)).toBeTruthy();
 expect(screen.getByText('Waiting for provider quota')).toBeTruthy();
});
test('preserves unknown amounts and large exact counters and hides obsolete details during execution',()=>{
 const view=render(createElement(QueueWaitReason,{reason:'quota_request_too_large',status:'paused',details:{...details,available:null,demand:'9007199254740993'}}));
 expect(screen.getByText(`Needs ${9007199254740993n.toLocaleString()} · Available Unknown · Limit 150`)).toBeTruthy();
 view.rerender(createElement(QueueWaitReason,{status:'running',details}));expect(screen.queryByLabelText('Quota wait details')).toBeNull();expect(screen.getByText('Provider is working')).toBeTruthy();
});
test('distinguishes worker, infrastructure and recovery waits without a fabricated quota snapshot',()=>{
 const view=render(createElement(QueueWaitReason,{status:'queued'}));expect(screen.getByText('Waiting for a worker')).toBeTruthy();
 view.rerender(createElement(QueueWaitReason,{status:'waiting_retry',reason:'quota_infrastructure_unavailable'}));expect(screen.getByText('Waiting for infrastructure')).toBeTruthy();
 view.rerender(createElement(QueueWaitReason,{status:'waiting_recovery'}));expect(screen.getByText('Recovering provider')).toBeTruthy();expect(screen.queryByLabelText('Quota wait details')).toBeNull();
});
