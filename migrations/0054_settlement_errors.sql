CREATE TABLE execution_settlement_errors (
 id text PRIMARY KEY,
 request_id text NOT NULL REFERENCES execution_requests(id),
 organization_id text NOT NULL,
 application_id text NOT NULL,
 account_id text NOT NULL,
 error_kind text NOT NULL CHECK (error_kind IN ('domain','infrastructure')),
 occurred_at timestamptz NOT NULL
);
CREATE INDEX settlement_errors_scope_time ON execution_settlement_errors(organization_id,application_id,occurred_at);
