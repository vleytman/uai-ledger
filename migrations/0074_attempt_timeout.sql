-- A call cut by the execution policy's attempt timeout. Its cost stays unknown; the metric counts these cuts.
ALTER TABLE execution_attempts ADD COLUMN timed_out_at timestamptz;
-- The provider deduplicates by key, so the retry of this call sends the same key.
ALTER TABLE execution_attempts ADD COLUMN reuse_idempotency_key boolean NOT NULL DEFAULT false;
CREATE INDEX execution_attempts_timed_out ON execution_attempts(timed_out_at) WHERE timed_out_at IS NOT NULL;
