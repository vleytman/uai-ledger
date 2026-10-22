ALTER TABLE execution_attempts ADD COLUMN observation_selected_poll integer;
ALTER TABLE execution_attempts ADD CONSTRAINT observation_selected_poll_nonnegative CHECK(observation_selected_poll>=0);
CREATE INDEX execution_observation_selected ON execution_attempts(request_id,number)
 WHERE observation_selected_poll IS NOT NULL AND observation_selected_poll=poll_count;
