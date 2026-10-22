ALTER TABLE dispatch_admissions
 ADD COLUMN unused_at timestamptz,
 ADD COLUMN unused_refunded_at timestamptz,
 ADD CONSTRAINT unused_admission_released CHECK(unused_at IS NULL OR (slot_released_at IS NOT NULL AND slot_unknown_at IS NULL));
CREATE INDEX quota_unused_refunds ON dispatch_admissions(group_id,unused_at)
 WHERE unused_at IS NOT NULL AND unused_refunded_at IS NULL;

CREATE FUNCTION preserve_unused_admission_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.unused_at IS NOT NULL AND NEW.unused_at IS DISTINCT FROM OLD.unused_at THEN
  RAISE EXCEPTION 'unused_admission_proof_immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER unused_admission_proof_immutable BEFORE UPDATE ON dispatch_admissions
 FOR EACH ROW EXECUTE FUNCTION preserve_unused_admission_proof();
