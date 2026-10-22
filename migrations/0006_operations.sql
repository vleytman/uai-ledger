CREATE TABLE provider_connections (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 provider text NOT NULL, name text NOT NULL, account_scope jsonb NOT NULL,
 capabilities jsonb NOT NULL, limits jsonb NOT NULL, risk_policy jsonb NOT NULL,
 status text NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled','locked')),
 credential_status text NOT NULL DEFAULT 'missing', credential_revision integer NOT NULL DEFAULT 0,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE provider_credentials (
 connection_id text NOT NULL REFERENCES provider_connections(id), revision integer NOT NULL,
 ciphertext text NOT NULL, iv text NOT NULL, tag text NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(connection_id,revision)
);
CREATE TABLE provider_snapshots (
 id text PRIMARY KEY, connection_id text NOT NULL REFERENCES provider_connections(id),
 organization_id text NOT NULL, application_id text NOT NULL, account_scope jsonb NOT NULL,
 metric text NOT NULL, source text NOT NULL CHECK(source IN ('provider_api','manual','derived')),
 native_unit text NOT NULL, total text, used text, remaining text,
 fetched_at timestamptz NOT NULL, covered_through timestamptz, precision text NOT NULL,
 stale_after_seconds integer NOT NULL CHECK(stale_after_seconds>0), author text NOT NULL, reason text NOT NULL
);
CREATE TABLE provider_usage_observations (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 attempt_id text NOT NULL, connection_id text NOT NULL, model text NOT NULL, provider_event_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('final','cumulative','delta')), revision integer NOT NULL CHECK(revision>=0),
 usage jsonb NOT NULL, source_hash text NOT NULL, provider_request_id text,
 observed_at timestamptz NOT NULL, provider_at timestamptz,
 UNIQUE(organization_id,application_id,account_id,attempt_id,provider_event_id)
);
CREATE TABLE provider_cost_entries (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 attempt_id text, connection_id text NOT NULL, model text NOT NULL, observation_id text,
 rate_card_id text, state text NOT NULL CHECK(state IN ('provisional','calculated','reported','reconciled','unknown')),
 currency text NOT NULL, exact_amount text, rounded_units bigint, rated_items jsonb NOT NULL DEFAULT '[]',
 provider_completed_at timestamptz, priced_at timestamptz NOT NULL,
 entry_type text NOT NULL CHECK(entry_type IN ('original','adjustment','unattributed')),
 correction_of text REFERENCES provider_cost_entries(id), reason text NOT NULL,
 identity text NOT NULL, source_hash text NOT NULL,
 UNIQUE(organization_id,application_id,account_id,identity),
 CHECK((state='unknown' AND rounded_units IS NULL) OR (state<>'unknown' AND rounded_units IS NOT NULL))
);
CREATE TABLE reconciliation_runs (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 connection_id text NOT NULL REFERENCES provider_connections(id), account_scope jsonb NOT NULL,
 period_start timestamptz NOT NULL, period_end timestamptz NOT NULL, timezone text NOT NULL,
 native_unit text NOT NULL, time_semantics text NOT NULL,
 local_units bigint, provider_units bigint, difference_units bigint,
 status text NOT NULL CHECK(status IN ('matched','discrepancy','incomplete','unavailable')),
 classification text NOT NULL, coverage jsonb NOT NULL, created_at timestamptz NOT NULL,
 identity text NOT NULL, source_hash text NOT NULL, UNIQUE(organization_id,application_id,identity),
 CHECK(period_end>period_start)
);
CREATE TABLE pricing_correction_runs (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 identity text NOT NULL, source_hash text NOT NULL, reason text NOT NULL, results jsonb NOT NULL,
 created_at timestamptz NOT NULL, UNIQUE(organization_id,application_id,account_id,identity)
);
CREATE TABLE notification_rules (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 signal text NOT NULL, severity text NOT NULL, threshold text, minimum_samples integer NOT NULL DEFAULT 1,
 recipients jsonb NOT NULL DEFAULT '[]', cooldown_seconds integer NOT NULL,
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE notification_incidents (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 rule_id text NOT NULL REFERENCES notification_rules(id), fingerprint text NOT NULL,
 resource_id text NOT NULL, signal text NOT NULL, severity text NOT NULL,
 state text NOT NULL CHECK(state IN ('open','acknowledged','resolved')),
 first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL, observed_value text,
 last_notified_at timestamptz, recovery_sent boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,
 UNIQUE(organization_id,application_id,rule_id,fingerprint)
);
CREATE TABLE notification_incident_history (
 id text PRIMARY KEY, incident_id text NOT NULL REFERENCES notification_incidents(id),
 action text NOT NULL, actor text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE webhook_destinations (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL,
 url text NOT NULL, secret_reference text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL
);
CREATE TABLE notification_deliveries (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES outbox_events(id),
 destination_id text REFERENCES webhook_destinations(id), organization_id text NOT NULL, application_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','sending','delivered','delivery_not_configured','dead_letter')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 lease_token text, lease_expires_at timestamptz, last_error text, delivered_at timestamptz,
 UNIQUE(event_id,destination_id)
);
CREATE FUNCTION protect_provider_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'provider financial record is append-only'; END $$;
CREATE TRIGGER provider_usage_append_only BEFORE UPDATE OR DELETE ON provider_usage_observations FOR EACH ROW EXECUTE FUNCTION protect_provider_audit();
CREATE TRIGGER provider_cost_append_only BEFORE UPDATE OR DELETE ON provider_cost_entries FOR EACH ROW EXECUTE FUNCTION protect_provider_audit();
CREATE INDEX provider_cost_period ON provider_cost_entries(organization_id,application_id,connection_id,provider_completed_at);
CREATE INDEX notification_pending ON notification_deliveries(next_attempt_at) WHERE status IN ('pending','sending');
