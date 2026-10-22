ALTER TABLE execution_requests
 ADD COLUMN execution_backend text NOT NULL DEFAULT 'legacy' CHECK (execution_backend IN ('legacy','bullmq')),
 ADD COLUMN dispatch_generation integer NOT NULL DEFAULT 0 CHECK (dispatch_generation>=0),
 ADD COLUMN queue_kind text NOT NULL DEFAULT 'tools' CHECK (queue_kind IN ('text','image','audio','tools','observe','maintenance'));
CREATE TABLE execution_dispatches (
 request_id text NOT NULL REFERENCES execution_requests(id),
 generation integer NOT NULL,
 queue_kind text NOT NULL,
 due_at timestamptz NOT NULL,
 published_at timestamptz,
 lease_owner text,
 lease_until timestamptz,
 delivery_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(request_id,generation)
);
CREATE INDEX execution_dispatch_pending ON execution_dispatches(due_at) WHERE published_at IS NULL;
CREATE INDEX execution_backend_queue ON execution_requests(execution_backend,not_before) WHERE execution_status IN ('queued','waiting_retry','waiting_recovery');
