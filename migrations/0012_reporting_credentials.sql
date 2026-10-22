-- Reporting credentials have separate encryption context and rotation history from inference credentials.
ALTER TABLE provider_connections ADD COLUMN reporting_credential_revision integer NOT NULL DEFAULT 0 CHECK(reporting_credential_revision>=0);
CREATE TABLE provider_reporting_credentials (
 connection_id text NOT NULL REFERENCES provider_connections(id),
 revision integer NOT NULL CHECK(revision>0),
 credential_scope jsonb NOT NULL,
 ciphertext text NOT NULL,
 iv text NOT NULL,
 tag text NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(connection_id,revision)
);
