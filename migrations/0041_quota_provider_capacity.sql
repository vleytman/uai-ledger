ALTER TABLE provider_quota_rules ADD COLUMN provider_capacity bigint
 CHECK(provider_capacity IS NULL OR (provider_capacity>0 AND provider_capacity<=9007199254740991 AND capacity<=provider_capacity));
