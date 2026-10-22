ALTER TABLE provider_quota_groups ADD COLUMN coordination_domain text;
CREATE TABLE dispatch_admission_bundles (
 id text PRIMARY KEY,
 request_id text NOT NULL REFERENCES execution_requests(id),
 fencing_token bigint NOT NULL,
 organization_id text NOT NULL,
 coordination_domain text NOT NULL,
 fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,fencing_token)
);
CREATE TABLE dispatch_admission_bundle_members (
 bundle_id text NOT NULL REFERENCES dispatch_admission_bundles(id),
 admission_id text NOT NULL UNIQUE REFERENCES dispatch_admissions(id),
 group_id text NOT NULL REFERENCES provider_quota_groups(id),
 PRIMARY KEY(bundle_id,group_id)
);
