CREATE TABLE configuration_versions (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  application_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('catalog','route','rate_card')),
  key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  payload jsonb NOT NULL,
  author text NOT NULL,
  comment text NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  UNIQUE (organization_id, application_id, kind, key, version),
  CHECK ((status = 'draft' AND published_at IS NULL) OR (status = 'published' AND published_at IS NOT NULL))
);
CREATE FUNCTION protect_published_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN RAISE EXCEPTION 'published configuration is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.application_id, NEW.kind, NEW.key, NEW.version) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.application_id, OLD.kind, OLD.key, OLD.version) THEN RAISE EXCEPTION 'configuration identity is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_configuration BEFORE UPDATE OR DELETE ON configuration_versions FOR EACH ROW EXECUTE FUNCTION protect_published_configuration();
CREATE INDEX configuration_versions_lookup ON configuration_versions(organization_id, application_id, kind, key, status, version DESC);
