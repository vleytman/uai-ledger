-- Operational settings must not invalidate the rules snapshot of an issued admission.
ALTER TABLE provider_quota_groups ADD COLUMN settings_revision integer NOT NULL DEFAULT 1 CHECK(settings_revision>0);
