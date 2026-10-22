CREATE INDEX execution_expired_lease_scan ON execution_requests(lease_expires_at,id)
 WHERE execution_status IN ('leased','submitting','running');
