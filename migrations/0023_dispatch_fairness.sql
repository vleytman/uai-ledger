CREATE TABLE execution_dispatch_policies (
 queue_kind text PRIMARY KEY CHECK (queue_kind IN ('text','image','audio','tools','observe','maintenance')),
 account_limit integer NOT NULL DEFAULT 2 CHECK (account_limit>0),
 application_limit integer NOT NULL DEFAULT 32 CHECK (application_limit>0),
 queue_limit integer NOT NULL DEFAULT 128 CHECK (queue_limit>0),
 revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
 last_served_at timestamptz
);
INSERT INTO execution_dispatch_policies(queue_kind) VALUES ('text'),('image'),('audio'),('tools'),('observe'),('maintenance');
CREATE TABLE execution_dispatch_fairness (
 queue_kind text NOT NULL REFERENCES execution_dispatch_policies(queue_kind),
 organization_id text NOT NULL,
 application_id text NOT NULL,
 account_id text NOT NULL,
 last_served_at timestamptz NOT NULL,
 PRIMARY KEY(queue_kind,organization_id,application_id,account_id)
);
ALTER TABLE execution_dispatches ADD COLUMN selected_at timestamptz;
UPDATE execution_dispatches SET selected_at=COALESCE(published_at,created_at) WHERE published_at IS NOT NULL OR lease_owner IS NOT NULL;
CREATE INDEX execution_dispatch_selected ON execution_dispatches(queue_kind,request_id,generation) WHERE selected_at IS NOT NULL;
