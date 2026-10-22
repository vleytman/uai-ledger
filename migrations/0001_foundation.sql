CREATE TABLE IF NOT EXISTS applications (
 id text PRIMARY KEY, organization_id text NOT NULL, name text NOT NULL,
 UNIQUE(organization_id,id)
);
CREATE TABLE IF NOT EXISTS accounts (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL REFERENCES applications(id),
 external_account_id text NOT NULL, spending_suspended boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(application_id,external_account_id),
 UNIQUE(organization_id,application_id,id)
);
CREATE TABLE IF NOT EXISTS outbox_events (
 sequence bigserial UNIQUE NOT NULL, id text PRIMARY KEY, organization_id text NOT NULL,
 application_id text NOT NULL, account_id text NOT NULL, type text NOT NULL,
 resource jsonb NOT NULL, data jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_scope_sequence ON outbox_events(organization_id,application_id,account_id,sequence);
CREATE TABLE IF NOT EXISTS audit_events (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 actor_id text NOT NULL, action text NOT NULL, resource_id text NOT NULL,
 reason text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
