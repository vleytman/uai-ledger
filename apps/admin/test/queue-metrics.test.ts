// @vitest-environment jsdom
import {createElement} from 'react';
import {afterEach,test,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {QueueMetrics} from '../../../packages/admin-module/src/components/queue-metrics';
import * as client from '../../../packages/admin-module/src/client';
const snapshot={sampled_at:'2026-09-19T19:00:00Z',data:[{queue_kind:'image',waiting:4,running:2,active_leases:2,remote_pending:0,paused:0,unknown:1,unsettled_terminal:1,waiting_rate_limit:2,oldest_wait_seconds:75,unpublished_due:1,oldest_unpublished_seconds:12,first_dispatch_wait_p95_ms:null,http_observations_24h:0,http_429_observations_24h:0,recovered_execute_deliveries_24h:0,queue_wait_samples_24h:0,ready_queue_wait_p50_ms:null,ready_queue_wait_p95_ms:null}]};
afterEach(()=>{cleanup();vi.restoreAllMocks()});
test('retains the last snapshot after an update error, then clears the error on recovery',async()=>{
 const api=vi.spyOn(client,'api').mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('API unavailable')).mockResolvedValueOnce({...snapshot,data:[{...snapshot.data[0],waiting:0,waiting_rate_limit:0,unknown:0,unsettled_terminal:0}]});
 render(createElement(QueueMetrics));
 await screen.findByRole('table',{name:'Queue status'});
 expect(screen.getByText('2 rate limited')).toBeTruthy();expect(screen.getByText('1 unknown')).toBeTruthy();expect(screen.getByText('1 awaiting settlement')).toBeTruthy();expect(screen.getAllByText('No samples')).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:'Refresh status'}));
 expect((await screen.findByRole('alert')).textContent).toContain('Showing the last snapshot');
 expect(screen.getByText('1 unknown')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Refresh status'}));
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());expect(screen.getByText('None')).toBeTruthy();
 expect(api.mock.calls.every(call=>call[0]==='execution_metrics')).toBe(true);
});
test('does not show zero metrics when the first load fails',async()=>{
 vi.spyOn(client,'api').mockRejectedValue(new Error('Access denied'));
 render(createElement(QueueMetrics));await screen.findByRole('alert');
 expect(screen.queryByRole('table')).toBeNull();expect(screen.getByText('Queue status unavailable')).toBeTruthy();
});

test('shows measured queue latency separately from first dispatch, including sample count',async()=>{
 vi.spyOn(client,'api').mockResolvedValue({...snapshot,data:[{...snapshot.data[0],queue_wait_samples_24h:2,ready_queue_wait_p50_ms:3000,ready_queue_wait_p95_ms:4800,first_dispatch_wait_p95_ms:605000}]});
 render(createElement(QueueMetrics));await screen.findByRole('table',{name:'Queue status'});
 expect(screen.getByText('3s / 5s')).toBeTruthy();expect(screen.getByText('2 deliveries')).toBeTruthy();expect(screen.getByText('10m')).toBeTruthy();
});

test('distinguishes recorded HTTP rate limits from missing observations and shows restored deliveries',async()=>{
 vi.spyOn(client,'api').mockResolvedValue({...snapshot,data:[{...snapshot.data[0],http_observations_24h:8,http_429_observations_24h:2,recovered_execute_deliveries_24h:3}]});
 render(createElement(QueueMetrics));await screen.findByRole('table',{name:'Queue status'});
 expect(screen.getByText('8 responses / 24h')).toBeTruthy();expect(screen.getByText('3 restored / 24h')).toBeTruthy();expect(screen.queryByText('No HTTP samples')).toBeNull();
});

test('labels installation worker health separately and shows stale and draining processes',async()=>{
 vi.spyOn(client,'api').mockResolvedValue({...snapshot,workers:{scope:'installation',freshness_seconds:45,data:[{queue_kind:'text',alive_workers:2,active_jobs:3,configured_concurrency:4,draining_workers:1,stale_workers:1}]}});
 render(createElement(QueueMetrics));await screen.findByRole('region',{name:'Worker health'});
 expect(screen.getByText('2 alive · 3 active jobs')).toBeTruthy();expect(screen.getByText('4 configured slots')).toBeTruthy();expect(screen.getByText('1 draining')).toBeTruthy();expect(screen.getByText('1 stale')).toBeTruthy();
 expect(screen.getByText(/Covers all applications in this installation/)).toBeTruthy();
});

test('shows probe errors without substituting zero milliseconds',async()=>{
 vi.spyOn(client,'api').mockResolvedValue({...snapshot,workers:{scope:'installation',freshness_seconds:45,data:[{queue_kind:'text',alive_workers:1,active_jobs:0,configured_concurrency:2,draining_workers:0,stale_workers:0,admission_samples:4,admission_p95_ms:38.5,admission_denied:1,admission_errors:1,db_probe_p95_ms:2,redis_probe_p95_ms:null,db_probe_failures:0,redis_probe_failures:1}]}});
 render(createElement(QueueMetrics));await screen.findByRole('region',{name:'Worker health'});
 expect(screen.getByText('Admission p95 38.5ms · 4 samples')).toBeTruthy();expect(screen.getByText('Probe p95 · DB 2ms · Redis —')).toBeTruthy();expect(screen.getByText('Probe failures: DB 0, Redis 1')).toBeTruthy();expect(screen.getByText('1 admission errors')).toBeTruthy();
});
