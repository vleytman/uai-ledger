ALTER TABLE quota_observations
 ADD COLUMN delivery_rules jsonb,
 ADD COLUMN delivery_domain text,
 ADD COLUMN applied_at timestamptz,
 ADD COLUMN retry_at timestamptz NOT NULL DEFAULT now();
-- Historical observations were already handled by the recovery journal.
UPDATE quota_observations SET applied_at=now();
CREATE INDEX quota_observations_pending ON quota_observations(retry_at,id) WHERE applied_at IS NULL;
