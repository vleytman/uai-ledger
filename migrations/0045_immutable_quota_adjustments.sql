-- Recovery replays these facts. Delivery metadata may change, consumption may not.
CREATE FUNCTION protect_quota_adjustment_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.group_id,NEW.admission_id,NEW.rule_key,NEW.reported_units,NEW.delta_units,NEW.window_ms,NEW.observed_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.group_id,OLD.admission_id,OLD.rule_key,OLD.reported_units,OLD.delta_units,OLD.window_ms,OLD.observed_at) THEN
  RAISE EXCEPTION 'quota_adjustment_facts_immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER quota_adjustment_facts_immutable
 BEFORE UPDATE ON quota_usage_adjustments
 FOR EACH ROW EXECUTE FUNCTION protect_quota_adjustment_facts();
