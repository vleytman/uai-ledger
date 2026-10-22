CREATE FUNCTION notify_uai_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('uai_transient',json_build_object('type','outbox_wakeup','organization_id',NEW.organization_id,'application_id',NEW.application_id,'account_id',NEW.account_id)::text);
 RETURN NEW;
END $$;
CREATE TRIGGER uai_outbox_wakeup AFTER INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION notify_uai_outbox();
CREATE FUNCTION notify_uai_scheduler() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('uai_scheduler','ready');
 RETURN NEW;
END $$;
CREATE TRIGGER uai_dispatch_wakeup AFTER INSERT ON execution_dispatches FOR EACH STATEMENT EXECUTE FUNCTION notify_uai_scheduler();
ALTER TABLE execution_requests ADD COLUMN received_at timestamptz;
ALTER TABLE execution_requests ADD COLUMN accepted_at timestamptz;
