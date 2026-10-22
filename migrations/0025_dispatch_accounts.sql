-- Register accounts transactionally with dispatch intent, including accounts never served yet.
CREATE FUNCTION register_dispatch_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO execution_dispatch_fairness(queue_kind,organization_id,application_id,account_id,last_served_at)
 SELECT NEW.queue_kind,organization_id,application_id,account_id,enqueued_at FROM execution_requests WHERE id=NEW.request_id
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$;
CREATE TRIGGER execution_dispatch_register_account AFTER INSERT ON execution_dispatches
 FOR EACH ROW EXECUTE FUNCTION register_dispatch_account();
INSERT INTO execution_dispatch_fairness(queue_kind,organization_id,application_id,account_id,last_served_at)
 SELECT queue_kind,organization_id,application_id,account_id,min(enqueued_at)
 FROM execution_requests WHERE execution_backend='bullmq'
 GROUP BY queue_kind,organization_id,application_id,account_id ON CONFLICT DO NOTHING;
CREATE INDEX execution_dispatch_account_order ON execution_requests
 (queue_kind,organization_id,application_id,account_id,
 ((priority::numeric*60)-EXTRACT(EPOCH FROM (enqueued_at AT TIME ZONE 'UTC'))) DESC,enqueued_at,id)
 WHERE execution_backend='bullmq' AND execution_status IN ('queued','waiting_retry','waiting_recovery');
CREATE INDEX execution_dispatch_account_fairness ON execution_dispatch_fairness(queue_kind,last_served_at);
