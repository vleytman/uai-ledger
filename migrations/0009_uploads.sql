CREATE TABLE asset_uploads (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 blob_key text NOT NULL UNIQUE, media_type text NOT NULL, expected_size integer NOT NULL CHECK(expected_size>0 AND expected_size<=16777216),
 expected_hash text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploaded','completed')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
