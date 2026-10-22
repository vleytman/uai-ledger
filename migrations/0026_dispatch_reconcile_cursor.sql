ALTER TABLE execution_dispatches ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT '-infinity';
CREATE INDEX execution_dispatch_reconcile ON execution_dispatches(reconcile_after,request_id,generation) WHERE published_at IS NOT NULL;
