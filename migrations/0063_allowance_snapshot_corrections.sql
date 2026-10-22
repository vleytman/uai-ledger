CREATE TABLE allowance_snapshot_supersessions (
 snapshot_id text PRIMARY KEY REFERENCES allowance_snapshots(id),
 replacement_id text NOT NULL REFERENCES allowance_snapshots(id),
 actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(snapshot_id<>replacement_id)
);
CREATE TRIGGER immutable_allowance_snapshot_supersession BEFORE UPDATE OR DELETE ON allowance_snapshot_supersessions FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
