-- Recovery holds a request row lock; avoid scanning unrelated admission history.
CREATE INDEX quota_unused_slots_by_request ON dispatch_admissions(request_id,fencing_token)
 WHERE state='admitted' AND slot_released_at IS NULL AND slot_unknown_at IS NULL;
