-- Explicit ownership transfer keeps historical payloads and accepted references immutable.
CREATE TABLE configuration_file_adoptions (
 organization_id text NOT NULL, application_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('catalog','rate_card','route','recipe')),
 key text NOT NULL, bundle_key text NOT NULL, baseline_id text NOT NULL, baseline_hash text NOT NULL,
 actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,kind,key)
);
CREATE TRIGGER immutable_configuration_adoption BEFORE UPDATE OR DELETE ON configuration_file_adoptions FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE OR REPLACE FUNCTION protect_file_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner jsonb; resource_kind text; adopted text;
BEGIN
 resource_kind:=CASE WHEN TG_TABLE_NAME='configuration_versions' THEN COALESCE(to_jsonb(NEW)->>'kind',to_jsonb(OLD)->>'kind') ELSE 'recipe' END;
 SELECT bundle_key INTO adopted FROM configuration_file_adoptions WHERE organization_id=COALESCE(NEW.organization_id,OLD.organization_id) AND application_id=COALESCE(NEW.application_id,OLD.application_id) AND kind=resource_kind AND key=COALESCE(NEW.key,OLD.key);
 IF TG_OP <> 'INSERT' THEN
  IF OLD.file_source IS NOT NULL OR adopted IS NOT NULL THEN
   IF OLD.file_source IS NOT NULL AND TG_TABLE_NAME='configuration_versions' AND TG_OP='UPDATE'
    AND to_jsonb(OLD)->>'status'='draft' AND to_jsonb(NEW)->>'status'='published'
    AND (to_jsonb(NEW)-'status'-'revision'-'published_at')=(to_jsonb(OLD)-'status'-'revision'-'published_at')
   THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'file_managed_configuration';
  END IF;
  IF TG_OP='UPDATE' AND NEW.file_source IS DISTINCT FROM OLD.file_source THEN RAISE EXCEPTION 'file_managed_configuration'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id || ':' || NEW.application_id || ':configuration',0));
 IF TG_TABLE_NAME='configuration_versions' THEN
  SELECT file_source INTO owner FROM configuration_versions WHERE organization_id=NEW.organization_id AND application_id=NEW.application_id AND kind=NEW.kind AND key=NEW.key ORDER BY version DESC LIMIT 1;
 ELSE
  SELECT file_source INTO owner FROM recipe_versions WHERE organization_id=NEW.organization_id AND application_id=NEW.application_id AND key=NEW.key ORDER BY version DESC LIMIT 1;
 END IF;
 IF adopted IS NOT NULL THEN
  IF NEW.file_source IS NULL OR NEW.file_source->>'bundle_key' IS DISTINCT FROM adopted THEN RAISE EXCEPTION 'file_managed_configuration'; END IF;
 ELSIF FOUND AND ((owner IS NULL) <> (NEW.file_source IS NULL) OR owner->>'bundle_key' IS DISTINCT FROM NEW.file_source->>'bundle_key') THEN
  RAISE EXCEPTION 'file_managed_configuration';
 END IF;
 IF NEW.file_source IS NOT NULL AND NOT EXISTS (SELECT 1 FROM configuration_releases WHERE id=NEW.file_source->>'release_id' AND organization_id=NEW.organization_id AND application_id=NEW.application_id AND bundle_key=NEW.file_source->>'bundle_key') THEN RAISE EXCEPTION 'invalid_configuration_release'; END IF;
 RETURN NEW;
END $$;
