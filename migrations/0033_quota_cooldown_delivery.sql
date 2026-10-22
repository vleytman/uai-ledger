ALTER TABLE dispatch_admissions ADD COLUMN cooldown_until timestamptz;
ALTER TABLE provider_quota_groups
 ADD COLUMN cooldown_applied_until timestamptz,
 ADD COLUMN cooldown_retry_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX provider_quota_cooldown_pending ON provider_quota_groups(cooldown_retry_at,id)
 WHERE blocked_until IS NOT NULL;
