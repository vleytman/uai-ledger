ALTER TABLE execution_attempts
 ADD COLUMN observation_relay_after timestamptz NOT NULL DEFAULT '-infinity',
 ADD COLUMN observation_relay_owner text,
 ADD COLUMN observation_relay_until timestamptz,
 ADD COLUMN observation_delivery_count integer NOT NULL DEFAULT 0;
CREATE INDEX execution_observation_relay ON execution_attempts(observation_relay_after,next_poll_at,id)
 WHERE remote_job_id IS NOT NULL;
