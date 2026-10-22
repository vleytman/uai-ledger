CREATE TABLE execution_requests (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 operation_id text NOT NULL, component text NOT NULL, client_request_key text NOT NULL, input_hash text NOT NULL,
 input_ref text NOT NULL, route jsonb NOT NULL, max_units bigint NOT NULL CHECK(max_units>=0),
 external_project_id text, project_generation text, priority integer NOT NULL DEFAULT 0,
 execution_status text NOT NULL DEFAULT 'queued', settlement_status text NOT NULL DEFAULT 'open',
 reason text, enqueued_at timestamptz NOT NULL, not_before timestamptz NOT NULL, deadline_at timestamptz NOT NULL,
 initial_queue_budget_ms integer NOT NULL DEFAULT 900000, recovery_wait_started_at timestamptz,
 recovery_wait_ms bigint NOT NULL DEFAULT 0, first_dispatched_at timestamptz, content_ttl_seconds integer NOT NULL DEFAULT 3600,
 lease_owner text, lease_expires_at timestamptz, fencing_token bigint NOT NULL DEFAULT 0,
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 16), slot integer NOT NULL DEFAULT 0,
 cycle integer NOT NULL DEFAULT 0 CHECK(cycle BETWEEN 0 AND 3), defect_seen boolean NOT NULL DEFAULT false,
 cancel_requested_at timestamptz, unresolved_at timestamptz, financial_closed_at timestamptz,
 incident_id text, created_at timestamptz NOT NULL,
 UNIQUE(organization_id,application_id,account_id,operation_id,client_request_key),
 CHECK((external_project_id IS NULL)=(project_generation IS NULL)), CHECK(content_ttl_seconds>0)
);
CREATE INDEX execution_queue ON execution_requests(not_before,priority,enqueued_at) WHERE execution_status IN ('queued','waiting_retry','waiting_recovery');
CREATE TABLE execution_attempts (
 id text PRIMARY KEY, request_id text NOT NULL REFERENCES execution_requests(id), number integer NOT NULL,
 fencing_token bigint NOT NULL, variant jsonb NOT NULL, status text NOT NULL, submission_intent_at timestamptz NOT NULL,
 remote_job_id text, remote_request_id text, provider_idempotency_key text NOT NULL,
 cost_units bigint CHECK(cost_units>=0), charged_units bigint CHECK(charged_units>=0),
 incident_id text, incident_cycle integer, finished_at timestamptz, created_at timestamptz NOT NULL,
 UNIQUE(request_id,number)
);
CREATE TABLE execution_observations (
 attempt_id text NOT NULL REFERENCES execution_attempts(id), observation_key text NOT NULL, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL, PRIMARY KEY(attempt_id,observation_key)
);
CREATE TABLE execution_incidents (
 id text PRIMARY KEY, organization_id text NOT NULL, failure_scope text NOT NULL,
 status text NOT NULL, cycle integer NOT NULL DEFAULT 1 CHECK(cycle BETWEEN 1 AND 3),
 dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 4),
 next_retry_at timestamptz NOT NULL, owner_request_id text, lease_owner text, lease_expires_at timestamptz,
 fencing_token bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, reason text NOT NULL,
 UNIQUE(organization_id,failure_scope)
);
CREATE TABLE execution_budgets (
 organization_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('provider','request','incident','period')),
 budget_key text NOT NULL, limit_units bigint NOT NULL CHECK(limit_units>=0), reserved_units bigint NOT NULL DEFAULT 0 CHECK(reserved_units>=0),
 spent_units bigint NOT NULL DEFAULT 0 CHECK(spent_units>=0), PRIMARY KEY(organization_id,kind,budget_key)
);
CREATE TABLE execution_exposures (
 attempt_id text NOT NULL REFERENCES execution_attempts(id), organization_id text NOT NULL,
 kind text NOT NULL, budget_key text NOT NULL, reserved_units bigint NOT NULL CHECK(reserved_units>=0),
 state text NOT NULL DEFAULT 'open', actual_units bigint, PRIMARY KEY(attempt_id,kind,budget_key),
 FOREIGN KEY(organization_id,kind,budget_key) REFERENCES execution_budgets(organization_id,kind,budget_key)
);
CREATE TABLE execution_limiters (
 organization_id text NOT NULL, limiter_key text NOT NULL, window_started_at timestamptz NOT NULL,
 window_ms integer NOT NULL CHECK(window_ms>0), request_limit integer NOT NULL CHECK(request_limit>0),
 token_limit bigint NOT NULL CHECK(token_limit>=0), requests_used integer NOT NULL DEFAULT 0,
 tokens_used bigint NOT NULL DEFAULT 0, concurrency_limit integer NOT NULL CHECK(concurrency_limit>0),
 blocked_until timestamptz, PRIMARY KEY(organization_id,limiter_key)
);
CREATE TABLE execution_fairness (
 organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 last_served_at timestamptz NOT NULL, PRIMARY KEY(organization_id,application_id,account_id)
);
CREATE TABLE storage_tombstones (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 scope_key text NOT NULL, operation_id text, external_project_id text, project_generation text,
 reason text NOT NULL, requested_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'accepted',
 UNIQUE(organization_id,application_id,account_id,scope_key)
);
CREATE TABLE storage_manifests (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 request_id text NOT NULL UNIQUE, operation_id text NOT NULL, external_project_id text, project_generation text,
 version text NOT NULL, manifest_hash text NOT NULL, content jsonb, assets jsonb NOT NULL DEFAULT '[]',
 ready_at timestamptz NOT NULL, content_expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'available',
 acknowledged_at timestamptz, receipt_id text, CHECK(content_expires_at>ready_at)
);
CREATE TABLE storage_assets (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('input','output')), blob_key text NOT NULL UNIQUE, content_hash text NOT NULL,
 media_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>=0), operation_id text,
 external_project_id text, project_generation text, expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'available'
);
CREATE TABLE storage_purge_jobs (
 id text PRIMARY KEY, manifest_id text, asset_id text, blob_key text,
 status text NOT NULL DEFAULT 'pending', lease_owner text, lease_expires_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL,
 UNIQUE(asset_id)
);
CREATE TABLE storage_inputs (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 operation_id text, external_project_id text, project_generation text, content jsonb,
 content_hash text NOT NULL, expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'available'
);
ALTER TABLE execution_incidents ADD COLUMN working_endpoint_scope text;
