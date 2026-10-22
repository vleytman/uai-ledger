CREATE INDEX execution_dispatch_ready ON execution_dispatches(queue_kind,due_at,request_id,generation) WHERE published_at IS NULL;
CREATE INDEX execution_transport_active ON execution_requests(queue_kind,organization_id,application_id,account_id,id,dispatch_generation)
 WHERE execution_backend='bullmq' AND execution_status IN ('queued','waiting_retry','waiting_recovery','leased','submitting','running');
