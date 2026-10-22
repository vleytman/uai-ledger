ALTER TABLE execution_requests ADD COLUMN quota_wait jsonb;
ALTER TABLE execution_requests ADD CONSTRAINT execution_quota_wait_object
 CHECK (quota_wait IS NULL OR jsonb_typeof(quota_wait)='object');
