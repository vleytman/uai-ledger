-- Readers and writers coordinate one connection/model, including absent rows.
-- The trigger covers direct configuration writes as well as future admin commands.
CREATE FUNCTION quota_binding_lock_key(connection_id text, model text) RETURNS bigint
 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT hashtextextended(jsonb_build_array(connection_id,model)::text,8194)
$$;

CREATE FUNCTION lock_quota_binding_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_key bigint; new_key bigint;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_key := quota_binding_lock_key(OLD.connection_id,OLD.model); END IF;
 IF TG_OP <> 'DELETE' THEN new_key := quota_binding_lock_key(NEW.connection_id,NEW.model); END IF;
 -- Stable ordering when a row is moved between routes.
 IF old_key IS NOT NULL AND new_key IS NOT NULL AND old_key <> new_key THEN
  PERFORM pg_advisory_xact_lock(LEAST(old_key,new_key));
  PERFORM pg_advisory_xact_lock(GREATEST(old_key,new_key));
 ELSE
  PERFORM pg_advisory_xact_lock(COALESCE(old_key,new_key));
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER provider_quota_bindings_scope_lock
 BEFORE INSERT OR UPDATE OR DELETE ON provider_quota_bindings
 FOR EACH ROW EXECUTE FUNCTION lock_quota_binding_change();
