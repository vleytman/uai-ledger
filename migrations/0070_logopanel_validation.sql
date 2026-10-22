ALTER TABLE execution_attempts ADD COLUMN validation_error jsonb;
ALTER TABLE execution_attempts ADD CONSTRAINT validation_error_shape CHECK (
 validation_error IS NULL OR (jsonb_typeof(validation_error)='object' AND validation_error ? 'path' AND validation_error ? 'reason')
);
