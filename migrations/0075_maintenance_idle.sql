-- An idle maintenance cycle is planned later (due_at) but may start from wake_after as soon as work is due.
-- NULL keeps the cycle at its due_at: after a cycle with work and after a failed cycle.
ALTER TABLE execution_maintenance_cycles ADD COLUMN wake_after timestamptz;
-- The probe for work that is due reads only these partial indexes.
CREATE INDEX execution_requests_financially_open ON execution_requests(id) WHERE financial_closed_at IS NULL;
CREATE INDEX storage_inputs_available_expiry ON storage_inputs(expires_at) WHERE status='available';
CREATE INDEX storage_assets_available_expiry ON storage_assets(expires_at) WHERE status='available';
CREATE INDEX storage_manifests_available_expiry ON storage_manifests(content_expires_at) WHERE status='available';
CREATE INDEX storage_purge_jobs_open ON storage_purge_jobs(lease_expires_at) WHERE status IN ('pending','running');
CREATE INDEX grant_revocations_prepared ON grant_revocations(reconcile_after) WHERE status='prepared';
CREATE INDEX storage_tombstones_purging ON storage_tombstones(id) WHERE status='purging';
