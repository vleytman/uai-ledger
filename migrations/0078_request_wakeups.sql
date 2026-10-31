-- A request's own events name it, so a stream waiting for that request reads its state at once.
CREATE OR REPLACE FUNCTION notify_uai_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('uai_transient',jsonb_strip_nulls(jsonb_build_object('type','outbox_wakeup','organization_id',NEW.organization_id,'application_id',NEW.application_id,'account_id',NEW.account_id,
  'request_id',CASE WHEN NEW.resource->>'type'='request' THEN NEW.resource->>'id' END))::text);
 RETURN NEW;
END $$;
