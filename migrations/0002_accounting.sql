CREATE TABLE wallets (
 id text PRIMARY KEY, organization_id text NOT NULL, application_id text NOT NULL, account_id text NOT NULL,
 credit_unit_id text NOT NULL DEFAULT 'ai-credit-usd-v1' CHECK(credit_unit_id='ai-credit-usd-v1'),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 UNIQUE(organization_id,application_id,account_id,credit_unit_id),
 FOREIGN KEY(organization_id,application_id,account_id) REFERENCES accounts(organization_id,application_id,id)
);
CREATE TABLE credit_lots (
 id text PRIMARY KEY, wallet_id text NOT NULL REFERENCES wallets(id), original_amount_units bigint NOT NULL CHECK(original_amount_units>0),
 budget_per_credit_units bigint NOT NULL DEFAULT 1000000 CHECK(budget_per_credit_units=1000000),
 source text NOT NULL CHECK(source IN ('purchase','subscription','promotion','refund','migration','internal')),
 external_reference text NOT NULL, terms_version text NOT NULL, terms jsonb NOT NULL, actor_id text NOT NULL,
 expires_at timestamptz, created_at timestamptz NOT NULL,
 UNIQUE(wallet_id,external_reference), UNIQUE(wallet_id,id)
);
CREATE TABLE lot_balances (
 lot_id text PRIMARY KEY REFERENCES credit_lots(id), available bigint NOT NULL DEFAULT 0 CHECK(available>=0),
 reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0), revocation_reserved bigint NOT NULL DEFAULT 0 CHECK(revocation_reserved>=0),
 consumed bigint NOT NULL DEFAULT 0 CHECK(consumed>=0), expired bigint NOT NULL DEFAULT 0 CHECK(expired>=0), revoked bigint NOT NULL DEFAULT 0 CHECK(revoked>=0)
);
CREATE TABLE journal_transactions (
 id text PRIMARY KEY, wallet_id text NOT NULL REFERENCES wallets(id), type text NOT NULL, identity text NOT NULL,
 actor_id text NOT NULL, reason text NOT NULL, references_json jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL,
 UNIQUE(wallet_id,identity), UNIQUE(wallet_id,id)
);
CREATE TABLE journal_postings (
 id bigserial PRIMARY KEY, transaction_id text NOT NULL, wallet_id text NOT NULL,
 lot_id text, bucket text NOT NULL CHECK(bucket IN ('issuance','available','reserved','revocation_reserved','consumed','expired','revoked')),
 amount_units bigint NOT NULL CHECK(amount_units<>0),
 CHECK((bucket='issuance' AND lot_id IS NULL) OR (bucket<>'issuance' AND lot_id IS NOT NULL)),
 FOREIGN KEY(wallet_id,transaction_id) REFERENCES journal_transactions(wallet_id,id),
 FOREIGN KEY(wallet_id,lot_id) REFERENCES credit_lots(wallet_id,id)
);
CREATE INDEX journal_postings_transaction ON journal_postings(transaction_id);
CREATE FUNCTION accounting_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Accounting history is immutable'; END $$;
CREATE TRIGGER immutable_lots BEFORE UPDATE OR DELETE ON credit_lots FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON journal_transactions FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE TRIGGER immutable_postings BEFORE UPDATE OR DELETE ON journal_postings FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
CREATE FUNCTION accounting_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE txid text; total numeric; entries integer;
BEGIN
 IF TG_TABLE_NAME='journal_transactions' THEN txid:=NEW.id; ELSE txid:=NEW.transaction_id; END IF;
 SELECT COALESCE(sum(amount_units),0),count(*) INTO total,entries FROM journal_postings WHERE transaction_id=txid;
 IF total<>0 OR entries<2 THEN RAISE EXCEPTION 'Unbalanced journal transaction %',txid; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balanced_journal AFTER INSERT ON journal_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_balanced();
CREATE CONSTRAINT TRIGGER balanced_postings AFTER INSERT ON journal_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_balanced();
CREATE TABLE accounting_commands (
 wallet_id text NOT NULL REFERENCES wallets(id), command text NOT NULL, key text NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(wallet_id,command,key)
);
CREATE TABLE reservations (
 operation_id text PRIMARY KEY, wallet_id text NOT NULL REFERENCES wallets(id), max_units bigint NOT NULL CHECK(max_units>=0),
 captured_units bigint NOT NULL DEFAULT 0 CHECK(captured_units>=0), released_units bigint NOT NULL DEFAULT 0 CHECK(released_units>=0),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 CHECK(captured_units+released_units<=max_units), UNIQUE(wallet_id,operation_id)
);
CREATE TABLE reservation_allocations (
 operation_id text NOT NULL REFERENCES reservations(operation_id), lot_id text NOT NULL REFERENCES credit_lots(id),
 reserved_units bigint NOT NULL CHECK(reserved_units>=0), captured_units bigint NOT NULL DEFAULT 0 CHECK(captured_units>=0), released_units bigint NOT NULL DEFAULT 0 CHECK(released_units>=0),
 PRIMARY KEY(operation_id,lot_id), CHECK(captured_units+released_units<=reserved_units)
);
CREATE TABLE request_budget_claims (
 request_id text PRIMARY KEY, operation_id text NOT NULL REFERENCES reservations(operation_id), max_units bigint NOT NULL CHECK(max_units>=0),
 charged_units bigint NOT NULL DEFAULT 0 CHECK(charged_units>=0 AND charged_units<=max_units),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')), capture_id text REFERENCES journal_transactions(id)
);
CREATE TABLE capture_allocations (
 capture_id text NOT NULL REFERENCES journal_transactions(id), lot_id text NOT NULL REFERENCES credit_lots(id),
 amount_units bigint NOT NULL CHECK(amount_units>0), refunded_units bigint NOT NULL DEFAULT 0 CHECK(refunded_units>=0 AND refunded_units<=amount_units),
 PRIMARY KEY(capture_id,lot_id)
);
CREATE TABLE grant_revocations (
 id text PRIMARY KEY, wallet_id text NOT NULL REFERENCES wallets(id), lot_id text NOT NULL REFERENCES credit_lots(id),
 amount_units bigint NOT NULL CHECK(amount_units>0), external_reference text NOT NULL, payload_hash text NOT NULL,
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','committed','canceled')), reconcile_after timestamptz NOT NULL,
 UNIQUE(wallet_id,external_reference)
);
-- Materialized balances must equal the immutable journal, including direct SQL writes.
CREATE FUNCTION accounting_reconciles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lot text; state text; projected numeric; recorded numeric; bal lot_balances%ROWTYPE;
BEGIN
 lot:=NEW.lot_id;
 IF lot IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO bal FROM lot_balances WHERE lot_id=lot;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing lot balance %',lot; END IF;
 FOREACH state IN ARRAY ARRAY['available','reserved','revocation_reserved','consumed','expired','revoked'] LOOP
  SELECT COALESCE(sum(amount_units),0) INTO recorded FROM journal_postings WHERE lot_id=lot AND bucket=state;
  projected:=(to_jsonb(bal)->>state)::numeric;
  IF projected<>recorded THEN RAISE EXCEPTION 'Lot journal mismatch % %',lot,state; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconcile_balance AFTER INSERT OR UPDATE ON lot_balances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_reconciles();
CREATE CONSTRAINT TRIGGER reconcile_postings AFTER INSERT ON journal_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_reconciles();
ALTER TABLE journal_transactions ADD COLUMN creating_transaction bigint NOT NULL DEFAULT txid_current();
CREATE FUNCTION accounting_new_postings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM journal_transactions WHERE id=NEW.transaction_id AND creating_transaction=txid_current()) THEN
 RAISE EXCEPTION 'Cannot append postings to committed history'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER append_postings BEFORE INSERT ON journal_postings FOR EACH ROW EXECUTE FUNCTION accounting_new_postings();
CREATE INDEX credit_lots_wallet ON credit_lots(wallet_id,expires_at,created_at,id);
CREATE INDEX journal_postings_lot ON journal_postings(lot_id,bucket);
CREATE INDEX journal_transactions_wallet ON journal_transactions(wallet_id,created_at,id);

CREATE TRIGGER prevent_balance_delete BEFORE DELETE ON lot_balances FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
