-- Immutable request scope copied onto native attempts for ordered account lookup.
ALTER TABLE execution_attempts ADD COLUMN observation_organization_id text,
 ADD COLUMN observation_application_id text, ADD COLUMN observation_account_id text;
UPDATE execution_attempts a SET observation_organization_id=r.organization_id,
 observation_application_id=r.application_id,observation_account_id=r.account_id
 FROM execution_requests r WHERE r.id=a.request_id AND a.remote_job_id IS NOT NULL;
CREATE FUNCTION register_observation_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.remote_job_id IS NOT NULL THEN
  SELECT organization_id,application_id,account_id INTO
   NEW.observation_organization_id,NEW.observation_application_id,NEW.observation_account_id
   FROM execution_requests WHERE id=NEW.request_id;
  INSERT INTO execution_dispatch_fairness(queue_kind,organization_id,application_id,account_id,last_served_at)
   VALUES('observe',NEW.observation_organization_id,NEW.observation_application_id,NEW.observation_account_id,NEW.created_at)
   ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER execution_observation_register_account BEFORE INSERT OR UPDATE OF remote_job_id ON execution_attempts
 FOR EACH ROW EXECUTE FUNCTION register_observation_account();
INSERT INTO execution_dispatch_fairness(queue_kind,organization_id,application_id,account_id,last_served_at)
 SELECT 'observe',observation_organization_id,observation_application_id,observation_account_id,min(created_at)
 FROM execution_attempts WHERE remote_job_id IS NOT NULL
 GROUP BY observation_organization_id,observation_application_id,observation_account_id ON CONFLICT DO NOTHING;
CREATE INDEX execution_observation_account_order ON execution_attempts
 (observation_organization_id,observation_application_id,observation_account_id,observation_relay_after,next_poll_at NULLS FIRST,id)
 WHERE remote_job_id IS NOT NULL;
