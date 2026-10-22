ALTER TABLE execution_attempts ADD COLUMN observation_fence bigint;
CREATE INDEX execution_observation_active ON execution_attempts(request_id,observation_fence)
 WHERE observation_fence IS NOT NULL;
