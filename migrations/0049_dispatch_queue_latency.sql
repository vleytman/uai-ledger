-- Existing deliveries have no reliable lease timestamp; keep them unknown.
ALTER TABLE execution_dispatches ADD COLUMN first_leased_at timestamptz;
CREATE INDEX execution_dispatch_lease_metrics ON execution_dispatches(first_leased_at,request_id)
 WHERE first_leased_at IS NOT NULL;
