ALTER TABLE configuration_versions ADD COLUMN display_name text
  CHECK (display_name IS NULL OR (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 200));

CREATE OR REPLACE FUNCTION protect_published_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    IF TG_OP = 'UPDATE' AND OLD.kind = 'rate_card'
      AND NEW.revision = OLD.revision + 1
      AND (to_jsonb(NEW) - 'display_name' - 'revision') = (to_jsonb(OLD) - 'display_name' - 'revision')
    THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'published configuration is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.application_id, NEW.kind, NEW.key, NEW.version) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.application_id, OLD.kind, OLD.key, OLD.version) THEN RAISE EXCEPTION 'configuration identity is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
