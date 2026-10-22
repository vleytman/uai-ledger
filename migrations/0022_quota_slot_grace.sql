-- Worker ownership expires before the conservative remote-execution hold.
ALTER TABLE dispatch_admissions
 ADD COLUMN slot_heartbeat_until timestamptz,
 ADD COLUMN slot_unknown_at timestamptz;
UPDATE dispatch_admissions a
 SET slot_heartbeat_until=a.slot_expires_at,
     slot_expires_at=a.slot_expires_at+g.unknown_hold_ms*interval '1 millisecond'
 FROM provider_quota_groups g
 WHERE a.group_id=g.id AND a.slot_expires_at IS NOT NULL AND a.slot_released_at IS NULL;
