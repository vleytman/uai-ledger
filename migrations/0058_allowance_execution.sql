ALTER TABLE execution_attempts ADD COLUMN allowance_reservation_id text REFERENCES allowance_reservations(id);
CREATE UNIQUE INDEX execution_attempt_allowance_unique ON execution_attempts(allowance_reservation_id) WHERE allowance_reservation_id IS NOT NULL;
-- Stable scope and grant attribution are enforced below the service layer as well.
ALTER TABLE allowance_grants ADD CONSTRAINT allowance_grant_period_unique UNIQUE(period_id,id);
ALTER TABLE allowance_ledger ADD CONSTRAINT allowance_ledger_grant_period FOREIGN KEY(period_id,grant_id) REFERENCES allowance_grants(period_id,id);
ALTER TABLE allowance_periods ADD CONSTRAINT allowance_period_subscription_unique UNIQUE(subscription_id,id);
ALTER TABLE allowance_reservations ADD CONSTRAINT allowance_reservation_subscription_period FOREIGN KEY(subscription_id,period_id) REFERENCES allowance_periods(subscription_id,id);
ALTER TABLE allowance_snapshots ADD CONSTRAINT allowance_snapshot_subscription_period FOREIGN KEY(subscription_id,period_id) REFERENCES allowance_periods(subscription_id,id);
