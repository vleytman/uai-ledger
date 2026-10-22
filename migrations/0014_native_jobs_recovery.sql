ALTER TABLE execution_incidents ADD COLUMN recovered_at timestamptz;
ALTER TABLE execution_attempts ADD COLUMN native_validation jsonb;
ALTER TABLE execution_attempts ADD COLUMN poll_count integer NOT NULL DEFAULT 0;
ALTER TABLE execution_attempts ADD COLUMN next_poll_at timestamptz;
ALTER TABLE execution_attempts ADD COLUMN cancel_dispatched_at timestamptz;
CREATE INDEX execution_native_poll ON execution_attempts(next_poll_at) WHERE remote_job_id IS NOT NULL;
