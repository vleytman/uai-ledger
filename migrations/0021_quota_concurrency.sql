ALTER TABLE provider_quota_groups
 ADD COLUMN concurrency_limit integer NOT NULL DEFAULT 8 CHECK(concurrency_limit>0),
 ADD COLUMN slot_lease_ms integer NOT NULL DEFAULT 30000 CHECK(slot_lease_ms BETWEEN 10000 AND 300000),
 ADD COLUMN unknown_hold_ms integer NOT NULL DEFAULT 300000 CHECK(unknown_hold_ms BETWEEN 10000 AND 3600000);
ALTER TABLE dispatch_admissions
 ADD COLUMN slot_expires_at timestamptz,
 ADD COLUMN slot_released_at timestamptz;
CREATE INDEX quota_active_slots ON dispatch_admissions(group_id,slot_expires_at) WHERE slot_released_at IS NULL;
