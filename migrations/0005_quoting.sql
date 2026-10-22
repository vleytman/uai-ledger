CREATE TABLE service_tokens (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL REFERENCES applications(id),
 account_ids text[], scopes text[] NOT NULL, max_grant_units bigint CHECK(max_grant_units>0),
 token_hash text NOT NULL UNIQUE, expires_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE command_idempotency (
 organization_id text NOT NULL, application_id text NOT NULL, command text NOT NULL, key text NOT NULL,
 input_hash text NOT NULL, resource_refs jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,command,key)
);
