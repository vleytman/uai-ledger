CREATE TABLE execution_maintenance_cycles (
 installation_id text PRIMARY KEY,
 generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
 due_at timestamptz NOT NULL DEFAULT now(),
 relay_after timestamptz NOT NULL DEFAULT '-infinity',
 lease_owner text,
 lease_until timestamptz,
 completed_at timestamptz
);
