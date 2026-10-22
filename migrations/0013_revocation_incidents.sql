CREATE TABLE revocation_incidents (
 id text PRIMARY KEY,
 organization_id text NOT NULL,
 application_id text NOT NULL,
 account_id text NOT NULL,
 wallet_id text NOT NULL REFERENCES wallets(id),
 revocation_id text NOT NULL UNIQUE REFERENCES grant_revocations(id),
 amount_units bigint NOT NULL CHECK(amount_units>0),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
 reconcile_after timestamptz NOT NULL,
 opened_at timestamptz NOT NULL,
 resolved_at timestamptz,
 resolution text CHECK(resolution IN ('committed','canceled')),
 FOREIGN KEY(organization_id,application_id,account_id) REFERENCES accounts(organization_id,application_id,id),
 CHECK((status='open' AND resolved_at IS NULL AND resolution IS NULL) OR (status='resolved' AND resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX revocation_incidents_scope ON revocation_incidents(organization_id,application_id,account_id,opened_at);
