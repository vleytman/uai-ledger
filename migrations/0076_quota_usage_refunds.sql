-- The unused part of an admitted demand, once the provider reported actual usage for the call.
-- Applying it replaces the admission's own window event with the actual amount; nothing else changes.
CREATE TABLE quota_usage_refunds (
 admission_id text NOT NULL REFERENCES dispatch_admissions(id),
 rule_key text NOT NULL,
 group_id text NOT NULL REFERENCES provider_quota_groups(id),
 admitted_units bigint NOT NULL CHECK(admitted_units>0 AND admitted_units<=9007199254740991),
 actual_units bigint NOT NULL CHECK(actual_units>=0 AND actual_units<admitted_units),
 window_ms integer NOT NULL CHECK(window_ms>0 AND window_ms<=86400000),
 observed_at timestamptz NOT NULL,
 applied_at timestamptz,
 PRIMARY KEY(admission_id,rule_key)
);
CREATE INDEX quota_refund_pending ON quota_usage_refunds(group_id,observed_at) WHERE applied_at IS NULL;
CREATE INDEX quota_refund_recovery ON quota_usage_refunds(group_id,observed_at);
-- Recovery replays these facts like quota_usage_adjustments: only applied_at may change.
CREATE FUNCTION protect_quota_refund_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.admission_id,NEW.rule_key,NEW.group_id,NEW.admitted_units,NEW.actual_units,NEW.window_ms,NEW.observed_at)
  IS DISTINCT FROM ROW(OLD.admission_id,OLD.rule_key,OLD.group_id,OLD.admitted_units,OLD.actual_units,OLD.window_ms,OLD.observed_at) THEN
  RAISE EXCEPTION 'quota_refund_facts_immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER quota_refund_facts_immutable
 BEFORE UPDATE ON quota_usage_refunds
 FOR EACH ROW EXECUTE FUNCTION protect_quota_refund_facts();
