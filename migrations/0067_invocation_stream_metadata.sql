ALTER TABLE execution_attempts ADD COLUMN delta_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE execution_attempts ADD COLUMN provider_first_delta_at timestamptz;
ALTER TABLE execution_requests ADD COLUMN api_first_delta_at timestamptz;
