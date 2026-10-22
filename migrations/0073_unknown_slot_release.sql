-- Financial maintenance now closes the unknown attempt of an absorbed request. Apply the same to
-- requests absorbed earlier, whose attempts still look unknown and used to hold limiter slots.
UPDATE execution_attempts a SET status='abandoned',finished_at=COALESCE(a.finished_at,r.financial_closed_at)
FROM execution_requests r
WHERE r.id=a.request_id AND a.status='outcome_unknown' AND r.financial_closed_at IS NOT NULL;
-- Limiter admission and the limiter slot metric count open attempts per limiter key.
CREATE INDEX execution_attempts_open_limiter ON execution_attempts((variant->>'limiter_key')) WHERE status IN ('submitting','running','outcome_unknown');
