ALTER TABLE notification_rules ADD COLUMN allowance jsonb;
ALTER TABLE notification_incidents ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
