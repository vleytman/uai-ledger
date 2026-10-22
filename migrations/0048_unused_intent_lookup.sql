-- An unacknowledged Redis acquire still has state=intent in PostgreSQL.
CREATE INDEX quota_unused_admissions_by_request ON dispatch_admissions(request_id,fencing_token)
 WHERE state IN ('intent','admitted') AND slot_released_at IS NULL AND slot_unknown_at IS NULL;
DROP INDEX quota_unused_slots_by_request;
