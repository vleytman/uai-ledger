-- Bounded recent samples, replaced by each heartbeat. Empty means instrumentation unavailable.
ALTER TABLE execution_worker_heartbeats ADD COLUMN telemetry jsonb NOT NULL DEFAULT '{}'::jsonb
 CHECK(jsonb_typeof(telemetry)='object');
