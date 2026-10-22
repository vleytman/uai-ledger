CREATE TABLE recipe_versions (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 key text NOT NULL, version integer NOT NULL CHECK(version>0), definition jsonb NOT NULL,
 created_at timestamptz NOT NULL, actor_id text NOT NULL,
 UNIQUE(organization_id,application_id,key,version)
);
CREATE TRIGGER immutable_recipe BEFORE UPDATE OR DELETE ON recipe_versions FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TABLE quotes (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 wallet_id text NOT NULL REFERENCES wallets(id), recipe_id text NOT NULL REFERENCES recipe_versions(id),
 kind text NOT NULL CHECK(kind IN ('single_call','recipe')), input_hash text NOT NULL, input_ref text NOT NULL REFERENCES storage_inputs(id),
 components jsonb NOT NULL, max_units bigint NOT NULL CHECK(max_units>=0), estimated_units bigint NOT NULL CHECK(estimated_units>=0),
 terms jsonb NOT NULL, external_project_id text, project_generation text, for_operation_id text,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 CHECK((external_project_id IS NULL)=(project_generation IS NULL))
);
CREATE TRIGGER immutable_quotes BEFORE UPDATE OR DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TABLE operations (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 quote_id text NOT NULL REFERENCES quotes(id), client_operation_key text NOT NULL,
 admission_status text NOT NULL DEFAULT 'open' CHECK(admission_status IN ('open','closed')),
 execution_status text NOT NULL DEFAULT 'accepted', settlement_status text NOT NULL DEFAULT 'open',
 components jsonb NOT NULL, accepted_max_units bigint NOT NULL CHECK(accepted_max_units>=0),
 external_project_id text, project_generation text, deadline_at timestamptz NOT NULL, content_ttl_seconds integer NOT NULL CHECK(content_ttl_seconds>0),
 closed_reason text, created_at timestamptz NOT NULL, closed_at timestamptz, settled_at timestamptz,
 UNIQUE(organization_id,application_id,account_id,client_operation_key),
 CHECK((external_project_id IS NULL)=(project_generation IS NULL))
);
CREATE TABLE quote_bindings (
 quote_id text PRIMARY KEY REFERENCES quotes(id), operation_id text NOT NULL REFERENCES operations(id), bound_at timestamptz NOT NULL
);
CREATE TRIGGER immutable_quote_bindings BEFORE UPDATE OR DELETE ON quote_bindings FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TABLE quoting_commands (
 organization_id text NOT NULL, application_id text NOT NULL, command text NOT NULL, key text NOT NULL,
 account_id text NOT NULL, payload_hash text NOT NULL, resource_id text NOT NULL,
 PRIMARY KEY(organization_id,application_id,command,key)
);
CREATE INDEX quotes_scope ON quotes(organization_id,application_id,account_id,created_at,id);
CREATE INDEX operations_scope ON operations(organization_id,application_id,account_id,created_at,id);
CREATE TABLE request_authorizations (
 request_id text PRIMARY KEY REFERENCES execution_requests(id), quote_id text NOT NULL REFERENCES quotes(id),
 component jsonb NOT NULL, accepted_at timestamptz NOT NULL
);
CREATE TRIGGER immutable_request_authorizations BEFORE UPDATE OR DELETE ON request_authorizations FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
