-- HTTP facts are independent of quota-header ownership and contain no response bodies.
CREATE TABLE provider_http_observations (
 attempt_id text NOT NULL REFERENCES execution_attempts(id),
 sent_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL,
 status integer NOT NULL CHECK (status BETWEEN 100 AND 599),
 PRIMARY KEY(attempt_id,sent_at,received_at)
);
CREATE INDEX provider_http_observations_metrics ON provider_http_observations(received_at,attempt_id);
-- Only reconstruction by the execute relay is recorded; ordinary retry generations stay NULL.
ALTER TABLE execution_dispatches ADD COLUMN recovered_at timestamptz;
CREATE INDEX execution_dispatch_recovered_metrics ON execution_dispatches(recovered_at,request_id)
 WHERE recovered_at IS NOT NULL;
