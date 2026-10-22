CREATE TABLE prefix_cache_observations (
 organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 connection_id text NOT NULL, model text NOT NULL, digest text NOT NULL,
 observed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 read_tokens bigint NOT NULL CHECK(read_tokens>=0), write_tokens bigint NOT NULL CHECK(write_tokens>=0),
 PRIMARY KEY(organization_id,application_id,account_id,connection_id,model,digest)
);
CREATE INDEX prefix_cache_expiry ON prefix_cache_observations(expires_at);
