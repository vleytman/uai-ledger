CREATE TABLE quota_result_feedback (
 id text PRIMARY KEY,
 request_id text NOT NULL REFERENCES execution_requests(id),
 attempt_id text NOT NULL REFERENCES execution_attempts(id),
 result jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 applied_at timestamptz,
 retry_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_result_feedback_pending ON quota_result_feedback(retry_at,id) WHERE applied_at IS NULL;
