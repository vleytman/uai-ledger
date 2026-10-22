-- Never reinterpret a past admission using today's model/rule configuration.
-- Legacy rows stay unknown rather than guessing their historical metric mapping.
ALTER TABLE dispatch_admissions ADD COLUMN rule_metrics jsonb NOT NULL DEFAULT '{}'
 CHECK(jsonb_typeof(rule_metrics)='object');
CREATE FUNCTION preserve_admission_rule_metrics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.rule_metrics IS DISTINCT FROM OLD.rule_metrics THEN
  RAISE EXCEPTION 'admission_rule_metrics_immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dispatch_admission_rule_metrics_immutable
 BEFORE UPDATE ON dispatch_admissions FOR EACH ROW EXECUTE FUNCTION preserve_admission_rule_metrics();
