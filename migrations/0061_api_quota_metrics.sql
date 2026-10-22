-- Native API measurements use the same rolling-window admission machinery.
ALTER TABLE provider_quota_rules DROP CONSTRAINT provider_quota_rules_metric_check;
ALTER TABLE provider_quota_rules ADD CONSTRAINT provider_quota_rules_metric_check CHECK(metric ~ '^[a-z][a-z0-9_]{0,63}$' AND metric NOT IN ('constructor','prototype'));
