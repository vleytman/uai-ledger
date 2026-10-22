CREATE TABLE execution_worker_heartbeats (
 installation_id text NOT NULL,
 worker_id text NOT NULL,
 queue_kind text NOT NULL CHECK(queue_kind IN ('text','image','audio','tools','observe','maintenance')),
 concurrency integer NOT NULL CHECK(concurrency>0),
 active_jobs integer NOT NULL CHECK(active_jobs>=0),
 state text NOT NULL CHECK(state IN ('running','draining','stopped')),
 started_at timestamptz NOT NULL DEFAULT now(),
 heartbeat_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(installation_id,worker_id,queue_kind)
);
CREATE INDEX execution_worker_heartbeat_recent ON execution_worker_heartbeats(installation_id,heartbeat_at);
