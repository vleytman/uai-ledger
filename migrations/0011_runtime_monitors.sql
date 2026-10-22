CREATE TABLE runtime_monitor_runs (
 monitor_key text PRIMARY KEY, last_completed_at timestamptz NOT NULL,
 observations integer NOT NULL CHECK(observations>=0)
);
