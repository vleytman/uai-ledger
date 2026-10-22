-- Event identities avoid high-watermark gaps when outbox transactions commit out of order.
CREATE TABLE notification_event_consumption (
 event_id text PRIMARY KEY REFERENCES outbox_events(id), consumed_at timestamptz NOT NULL
);
