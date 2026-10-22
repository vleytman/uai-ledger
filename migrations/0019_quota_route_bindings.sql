CREATE TABLE provider_quota_bindings (
 connection_id text NOT NULL REFERENCES provider_connections(id),
 model text NOT NULL,
 group_id text NOT NULL REFERENCES provider_quota_groups(id),
 PRIMARY KEY(connection_id,model)
);
ALTER TABLE execution_attempts ADD COLUMN quota_admission_id text REFERENCES dispatch_admissions(id);
