-- Provider native counters are independent of customer credit lots and Redis quotas.
CREATE TABLE provider_accounts (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 provider text NOT NULL, name text NOT NULL, external_reference text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL,
 UNIQUE(organization_id,application_id,provider,external_reference),
 UNIQUE(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id) REFERENCES applications(organization_id,id)
);
CREATE TABLE provider_tariff_versions (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 key text NOT NULL, version integer NOT NULL CHECK(version>0), definition jsonb NOT NULL,
 file_source jsonb NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(organization_id,application_id,key,version), UNIQUE(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id) REFERENCES applications(organization_id,id)
);
CREATE TRIGGER immutable_provider_tariff BEFORE UPDATE OR DELETE ON provider_tariff_versions FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TABLE provider_subscriptions (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 provider_account_id text NOT NULL, tariff_version_id text NOT NULL,
 installation_share jsonb NOT NULL, starts_at timestamptz NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL,
 UNIQUE(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,provider_account_id) REFERENCES provider_accounts(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,tariff_version_id) REFERENCES provider_tariff_versions(organization_id,application_id,id)
);
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_scope_unique UNIQUE(organization_id,application_id,id);
CREATE TABLE provider_allowance_bindings (
 connection_id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 provider_account_id text NOT NULL, subscription_id text, revision integer NOT NULL CHECK(revision>0),
 FOREIGN KEY(organization_id,application_id,connection_id) REFERENCES provider_connections(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,provider_account_id) REFERENCES provider_accounts(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,subscription_id) REFERENCES provider_subscriptions(organization_id,application_id,id)
);
CREATE TABLE allowance_periods (
 id text PRIMARY KEY, subscription_id text NOT NULL REFERENCES provider_subscriptions(id),
 month_index integer NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 UNIQUE(subscription_id,month_index), CHECK(ends_at>starts_at)
);
CREATE TABLE allowance_grants (
 id text PRIMARY KEY, period_id text NOT NULL REFERENCES allowance_periods(id), metric text NOT NULL,
 quantity numeric(38,9) NOT NULL CHECK(quantity>=0), expires_at timestamptz NOT NULL,
 origin_id text REFERENCES allowance_grants(id), kind text NOT NULL CHECK(kind IN ('included','rollover','adjustment')),
 created_at timestamptz NOT NULL
);
CREATE TABLE allowance_reservations (
 id text PRIMARY KEY, subscription_id text NOT NULL REFERENCES provider_subscriptions(id),
 period_id text NOT NULL REFERENCES allowance_periods(id), identity text NOT NULL, input_hash text NOT NULL,
 demands jsonb NOT NULL, allocations jsonb NOT NULL, actual_allocations jsonb NOT NULL DEFAULT '[]',
 overage_reserved_units numeric(38,0) NOT NULL DEFAULT 0 CHECK(overage_reserved_units>=0),
 overage_spent_units numeric(38,0) NOT NULL DEFAULT 0 CHECK(overage_spent_units>=0),
 state text NOT NULL CHECK(state IN ('reserved','sent','unknown','settled','released')),
 observation_revision integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, sent_at timestamptz, settled_at timestamptz,
 UNIQUE(subscription_id,identity)
);
CREATE TABLE allowance_ledger (
 sequence bigserial PRIMARY KEY, period_id text NOT NULL REFERENCES allowance_periods(id),
 grant_id text REFERENCES allowance_grants(id), reservation_id text REFERENCES allowance_reservations(id),
 metric text NOT NULL, reserved_delta numeric(38,9) NOT NULL DEFAULT 0,
 consumed_delta numeric(38,9) NOT NULL DEFAULT 0, transferred_delta numeric(38,9) NOT NULL DEFAULT 0,
 kind text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX allowance_ledger_grant ON allowance_ledger(grant_id);
CREATE INDEX allowance_ledger_period ON allowance_ledger(period_id,metric);
CREATE INDEX allowance_reservations_period ON allowance_reservations(period_id,state);
CREATE TRIGGER immutable_allowance_ledger BEFORE UPDATE OR DELETE ON allowance_ledger FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TRIGGER immutable_allowance_grant BEFORE UPDATE OR DELETE ON allowance_grants FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TABLE allowance_observations (
 reservation_id text NOT NULL REFERENCES allowance_reservations(id), revision integer NOT NULL CHECK(revision>0),
 identity text NOT NULL, hash text NOT NULL, observation jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(reservation_id,revision), UNIQUE(reservation_id,identity)
);
CREATE TRIGGER immutable_allowance_observation BEFORE UPDATE OR DELETE ON allowance_observations FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TABLE allowance_snapshots (
 id text PRIMARY KEY, subscription_id text NOT NULL REFERENCES provider_subscriptions(id),
 period_id text NOT NULL REFERENCES allowance_periods(id), identity text NOT NULL, hash text NOT NULL,
 metric text NOT NULL, remaining numeric(38,9) NOT NULL CHECK(remaining>=0),
 observed_at timestamptz NOT NULL, covered_through timestamptz, precision text NOT NULL,
 scope text NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(subscription_id,identity), CHECK(covered_through IS NULL OR covered_through<=observed_at)
);
CREATE TRIGGER immutable_allowance_snapshot BEFORE UPDATE OR DELETE ON allowance_snapshots FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TABLE allowance_adjustments (
 id text PRIMARY KEY, period_id text NOT NULL REFERENCES allowance_periods(id), evidence_id text NOT NULL,
 hash text NOT NULL, adjustment jsonb NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(period_id,evidence_id)
);
CREATE TRIGGER immutable_allowance_adjustment BEFORE UPDATE OR DELETE ON allowance_adjustments FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
