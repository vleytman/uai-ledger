-- Debt is kept separately from prepaid lots; prepaid balances remain nonnegative.
ALTER TABLE journal_postings DROP CONSTRAINT journal_postings_bucket_check;
ALTER TABLE journal_postings DROP CONSTRAINT journal_postings_check;
ALTER TABLE journal_postings ADD CHECK(bucket IN ('issuance','available','reserved','revocation_reserved','consumed','expired','revoked','debt','debt_consumed'));
ALTER TABLE journal_postings ADD CHECK((bucket IN ('issuance','debt','debt_consumed') AND lot_id IS NULL) OR (bucket NOT IN ('issuance','debt','debt_consumed') AND lot_id IS NOT NULL));
CREATE TABLE capture_debts (
 capture_id text PRIMARY KEY REFERENCES journal_transactions(id),
 wallet_id text NOT NULL REFERENCES wallets(id),
 original_units bigint NOT NULL CHECK(original_units>0),
 unpaid_units bigint NOT NULL CHECK(unpaid_units>=0 AND unpaid_units<=original_units),
 refunded_units bigint NOT NULL DEFAULT 0 CHECK(refunded_units>=0 AND refunded_units+unpaid_units<=original_units)
);
CREATE INDEX capture_debts_wallet ON capture_debts(wallet_id) WHERE unpaid_units>0;
CREATE FUNCTION accounting_debt_reconciles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wallet text; owed numeric; posted numeric;
BEGIN
 wallet:=NEW.wallet_id;
 SELECT COALESCE(sum(unpaid_units),0) INTO owed FROM capture_debts WHERE wallet_id=wallet;
 SELECT COALESCE(sum(amount_units),0) INTO posted FROM journal_postings WHERE wallet_id=wallet AND bucket='debt';
 IF owed<>-posted THEN RAISE EXCEPTION 'Debt journal mismatch %',wallet; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconcile_debt AFTER INSERT OR UPDATE ON capture_debts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_debt_reconciles();
CREATE CONSTRAINT TRIGGER reconcile_debt_postings AFTER INSERT ON journal_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_debt_reconciles();
CREATE TRIGGER immutable_debt_identity BEFORE DELETE ON capture_debts FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
