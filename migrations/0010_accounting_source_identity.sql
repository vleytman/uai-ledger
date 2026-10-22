-- Billing event identity belongs to its stable issuer, independent of recipient wallet or token rotation.
CREATE TABLE grant_source_identities (
 organization_id text NOT NULL, application_id text NOT NULL, issuer text NOT NULL, external_reference text NOT NULL,
 wallet_id text NOT NULL, lot_id text NOT NULL UNIQUE,
 PRIMARY KEY(organization_id,application_id,issuer,external_reference),
 FOREIGN KEY(wallet_id,lot_id) REFERENCES credit_lots(wallet_id,id)
);
-- Existing installations use one application-level issuer. Conflicting historical events require reconciliation.
INSERT INTO grant_source_identities(organization_id,application_id,issuer,external_reference,wallet_id,lot_id)
 SELECT w.organization_id,w.application_id,'application:'||w.application_id,l.external_reference,w.id,l.id
 FROM credit_lots l JOIN wallets w ON w.id=l.wallet_id WHERE l.source<>'refund';
ALTER TABLE credit_lots DROP CONSTRAINT credit_lots_wallet_id_external_reference_key;
CREATE TRIGGER immutable_grant_source_identity BEFORE UPDATE OR DELETE ON grant_source_identities FOR EACH ROW EXECUTE FUNCTION accounting_immutable();
