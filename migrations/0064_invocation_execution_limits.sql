CREATE TABLE invocation_execution_limits (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 max_attempts integer NOT NULL DEFAULT 8 CHECK(max_attempts BETWEEN 1 AND 8),
 max_deadline_seconds integer NOT NULL DEFAULT 86400 CHECK(max_deadline_seconds BETWEEN 1 AND 86400),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
INSERT INTO invocation_execution_limits(singleton) VALUES(true);
