CREATE TABLE quota_usage_adjustments (
 id text PRIMARY KEY,
 group_id text NOT NULL REFERENCES provider_quota_groups(id),
 admission_id text NOT NULL REFERENCES dispatch_admissions(id),
 rule_key text NOT NULL,
 reported_units bigint NOT NULL CHECK(reported_units>=0 AND reported_units<=9007199254740991),
 delta_units bigint NOT NULL CHECK(delta_units>0 AND delta_units<=9007199254740991),
 window_ms integer NOT NULL CHECK(window_ms>0 AND window_ms<=86400000),
 observed_at timestamptz NOT NULL,
 applied_at timestamptz,
 UNIQUE(admission_id,rule_key,reported_units)
);
CREATE INDEX quota_adjustment_recovery ON quota_usage_adjustments(group_id,observed_at);
CREATE INDEX quota_adjustment_pending ON quota_usage_adjustments(group_id,observed_at) WHERE applied_at IS NULL;
