CREATE TABLE provider_quota_groups (
 id text PRIMARY KEY,
 organization_id text NOT NULL,
 name text NOT NULL,
 provider text NOT NULL,
 scope jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 recovery_epoch text NOT NULL,
 source text NOT NULL,
 checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,name)
);
CREATE TABLE provider_quota_rules (
 group_id text NOT NULL REFERENCES provider_quota_groups(id),
 key text NOT NULL,
 metric text NOT NULL CHECK(metric IN ('requests','input_tokens','output_tokens','tokens','images','audio_seconds')),
 capacity bigint NOT NULL CHECK(capacity>0 AND capacity<=9007199254740991),
 window_ms integer NOT NULL CHECK(window_ms>0 AND window_ms<=86400000),
 PRIMARY KEY(group_id,key)
);
CREATE TABLE dispatch_admissions (
 id text PRIMARY KEY,
 group_id text NOT NULL REFERENCES provider_quota_groups(id),
 request_id text NOT NULL REFERENCES execution_requests(id),
 fencing_token bigint NOT NULL,
 rules_revision integer NOT NULL,
 demands jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('intent','admitted','rejected')),
 admitted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 rejection jsonb,
 UNIQUE(group_id,request_id,fencing_token)
);
CREATE INDEX quota_admissions_recovery ON dispatch_admissions(group_id,created_at) WHERE state<>'rejected';
CREATE TABLE quota_observations (
 id text PRIMARY KEY,
 group_id text NOT NULL REFERENCES provider_quota_groups(id),
 attempt_id text REFERENCES execution_attempts(id),
 sent_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 headers jsonb NOT NULL
);
