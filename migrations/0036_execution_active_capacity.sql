ALTER TABLE execution_dispatch_policies
 ADD COLUMN active_queue_limit integer NOT NULL DEFAULT 32 CHECK(active_queue_limit>0),
 ADD COLUMN active_application_limit integer NOT NULL DEFAULT 16 CHECK(active_application_limit>0),
 ADD COLUMN active_account_limit integer NOT NULL DEFAULT 2 CHECK(active_account_limit>0);
COMMENT ON COLUMN execution_dispatch_policies.active_queue_limit IS 'Concurrent execution leases; distinct from publication backlog limits';
