-- File definitions are immutable snapshots. Activation is an operational pointer.
CREATE TABLE configuration_releases (
 id text PRIMARY KEY,
 organization_id text NOT NULL,
 application_id text NOT NULL,
 bundle_key text NOT NULL,
 digest text NOT NULL,
 document jsonb NOT NULL,
 bindings jsonb NOT NULL,
 provenance jsonb NOT NULL,
 resources jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,application_id,bundle_key,digest),
 UNIQUE(organization_id,application_id,bundle_key,id),
 FOREIGN KEY(organization_id,application_id) REFERENCES applications(organization_id,id)
);
CREATE TABLE configuration_activations (
 organization_id text NOT NULL,
 application_id text NOT NULL,
 bundle_key text NOT NULL,
 release_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 actor_id text NOT NULL,
 activated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,bundle_key),
 FOREIGN KEY(organization_id,application_id,bundle_key,release_id)
 REFERENCES configuration_releases(organization_id,application_id,bundle_key,id)
);
CREATE TABLE configuration_activation_history (
 id bigserial PRIMARY KEY,
 organization_id text NOT NULL,
 application_id text NOT NULL,
 bundle_key text NOT NULL,
 release_id text NOT NULL REFERENCES configuration_releases(id),
 revision integer NOT NULL,
 actor_id text NOT NULL,
 activated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE configuration_versions ADD COLUMN file_source jsonb;
ALTER TABLE recipe_versions ADD COLUMN file_source jsonb;

-- Also guard old HTTP paths and direct SQL: one owner for every scoped key.
CREATE FUNCTION protect_file_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner jsonb; resource_kind text;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  IF OLD.file_source IS NOT NULL THEN
   -- The publisher completes its draft inside one transaction.
   IF TG_TABLE_NAME='configuration_versions' AND TG_OP='UPDATE'
    AND to_jsonb(OLD)->>'status'='draft' AND to_jsonb(NEW)->>'status'='published'
    AND (to_jsonb(NEW)-'status'-'revision'-'published_at')=(to_jsonb(OLD)-'status'-'revision'-'published_at')
   THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'file_managed_configuration';
  END IF;
  IF TG_OP='UPDATE' AND NEW.file_source IS DISTINCT FROM OLD.file_source THEN
   RAISE EXCEPTION 'file_managed_configuration';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id || ':' || NEW.application_id || ':configuration',0));
 IF TG_TABLE_NAME='configuration_versions' THEN
  resource_kind:=NEW.kind;
  SELECT file_source INTO owner FROM configuration_versions WHERE organization_id=NEW.organization_id AND application_id=NEW.application_id AND kind=NEW.kind AND key=NEW.key LIMIT 1;
 ELSE
  resource_kind:='recipe';
  SELECT file_source INTO owner FROM recipe_versions WHERE organization_id=NEW.organization_id AND application_id=NEW.application_id AND key=NEW.key LIMIT 1;
 END IF;
 IF FOUND AND ((owner IS NULL) <> (NEW.file_source IS NULL) OR owner->>'bundle_key' IS DISTINCT FROM NEW.file_source->>'bundle_key') THEN
  RAISE EXCEPTION 'file_managed_configuration';
 END IF;
 IF NEW.file_source IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM configuration_releases WHERE id=NEW.file_source->>'release_id' AND organization_id=NEW.organization_id
   AND application_id=NEW.application_id AND bundle_key=NEW.file_source->>'bundle_key'
 ) THEN RAISE EXCEPTION 'invalid_configuration_release'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_configuration_guard BEFORE INSERT OR UPDATE OR DELETE ON configuration_versions FOR EACH ROW EXECUTE FUNCTION protect_file_configuration();
CREATE TRIGGER file_recipe_guard BEFORE INSERT OR UPDATE OR DELETE ON recipe_versions FOR EACH ROW EXECUTE FUNCTION protect_file_configuration();
CREATE TRIGGER immutable_configuration_release BEFORE UPDATE OR DELETE ON configuration_releases FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TRIGGER immutable_configuration_activation_history BEFORE UPDATE OR DELETE ON configuration_activation_history FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
