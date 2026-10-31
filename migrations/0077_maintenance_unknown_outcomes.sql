-- A call with an unknown outcome keeps maintenance busy only when one of its own times comes due.
DROP INDEX execution_requests_financially_open;
CREATE INDEX execution_requests_financially_open ON execution_requests(execution_status) WHERE financial_closed_at IS NULL;
