-- Per-application admission policy; installation rollout configures explicit values.
CREATE TABLE execution_admission_policies (
 organization_id text NOT NULL, application_id text NOT NULL,
 account_limit integer NOT NULL CHECK(account_limit BETWEEN 1 AND 100000),
 application_limit integer NOT NULL CHECK(application_limit BETWEEN account_limit AND 1000000),
 max_queue_age_ms integer NOT NULL CHECK(max_queue_age_ms BETWEEN 1000 AND 86400000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(organization_id,application_id)
);
CREATE INDEX operations_admission_backlog ON operations(organization_id,application_id,account_id,deadline_at)
 WHERE admission_status='open';
CREATE INDEX execution_request_backlog ON execution_requests(organization_id,application_id,account_id,enqueued_at)
 WHERE execution_status IN ('queued','waiting_retry','waiting_recovery');
