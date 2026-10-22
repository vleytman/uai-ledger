-- The setting belongs to the current transaction. Only the authenticated server sets it.
CREATE FUNCTION uai_set_audit_account(target text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE context jsonb;
BEGIN
 context:=nullif(current_setting('uai.audit_identity',true),'')::jsonb;
 IF context IS NULL THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=target AND organization_id=context->>'organization_id' AND application_id=context->>'application_id') THEN
  RAISE EXCEPTION 'Audit account scope mismatch';
 END IF;
 PERFORM set_config('uai.audit_identity',(context||jsonb_build_object('account_id',target))::text,true);
END $$;

-- Additive snapshots keep historic actor_id/author semantics and leave historical humans unknown.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['audit_events','operations','quotes','execution_requests','credit_lots','journal_transactions','accounting_commands','quoting_commands','recipe_versions','configuration_versions','grant_revocations'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN audit_identity jsonb',t);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT audit_identity_shape CHECK (audit_identity IS NULL OR (jsonb_typeof(audit_identity)=''object'' AND audit_identity->>''version''=''1''))',t);
 END LOOP;
END $$;

CREATE FUNCTION uai_snapshot_audit_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 context jsonb:=nullif(current_setting('uai.audit_identity',true),'')::jsonb;
 row_data jsonb:=to_jsonb(NEW);
 org text:=row_data->>'organization_id'; app text:=row_data->>'application_id';
 account text:=row_data->>'account_id'; team text; operation text:=row_data->>'operation_id';
 target text:=row_data->>'resource_id'; owner_row record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.audit_identity IS DISTINCT FROM OLD.audit_identity THEN RAISE EXCEPTION 'Audit identity is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF row_data->>'wallet_id' IS NOT NULL THEN
  SELECT organization_id,application_id,account_id INTO owner_row FROM wallets WHERE id=row_data->>'wallet_id';
  org:=coalesce(org,owner_row.organization_id); app:=coalesce(app,owner_row.application_id); account:=coalesce(account,owner_row.account_id);
 END IF;
 IF TG_TABLE_NAME='operations' THEN operation:=NEW.id; END IF;
 operation:=coalesce(operation,row_data#>>'{references_json,operation_id}');
 IF operation IS NULL AND row_data#>>'{references_json,capture_id}' IS NOT NULL THEN
  SELECT references_json->>'operation_id' INTO operation FROM journal_transactions WHERE id=row_data#>>'{references_json,capture_id}';
 END IF;
 IF operation IS NULL AND row_data#>>'{references_json,request_id}' IS NOT NULL THEN
  SELECT operation_id INTO operation FROM execution_requests WHERE id=row_data#>>'{references_json,request_id}';
 END IF;
 -- Audit target IDs are resolved through stored ownership, never arbitrary form metadata.
 IF TG_TABLE_NAME='audit_events' AND target IS NOT NULL THEN
  SELECT organization_id,application_id,account_id,id operation_id INTO owner_row FROM operations WHERE id=target
  UNION ALL SELECT organization_id,application_id,account_id,operation_id FROM execution_requests WHERE id=target
  UNION ALL SELECT organization_id,application_id,account_id,NULL FROM wallets WHERE id=target
  UNION ALL SELECT organization_id,application_id,id,NULL FROM accounts WHERE id=target
  UNION ALL SELECT organization_id,application_id,account_id,for_operation_id FROM quotes WHERE id=target
  UNION ALL SELECT w.organization_id,w.application_id,w.account_id,coalesce(j.references_json->>'operation_id',j.audit_identity->>'operation_id') FROM journal_transactions j JOIN wallets w ON w.id=j.wallet_id WHERE j.id=target
  UNION ALL SELECT w.organization_id,w.application_id,w.account_id,NULL FROM credit_lots l JOIN wallets w ON w.id=l.wallet_id WHERE l.id=target
  UNION ALL SELECT w.organization_id,w.application_id,w.account_id,NULL FROM grant_revocations r JOIN wallets w ON w.id=r.wallet_id WHERE r.id=target
  LIMIT 1;
  IF FOUND THEN
   IF org<>owner_row.organization_id OR app<>owner_row.application_id THEN RAISE EXCEPTION 'Audit resource scope mismatch'; END IF;
   account:=owner_row.account_id; operation:=coalesce(operation,owner_row.operation_id);
  END IF;
 END IF;
 IF context IS NOT NULL THEN
  IF org IS DISTINCT FROM context->>'organization_id' OR app IS DISTINCT FROM context->>'application_id' THEN RAISE EXCEPTION 'Audit identity scope mismatch'; END IF;
  account:=coalesce(account,context->>'account_id');
 END IF;
 IF account IS NOT NULL THEN
  SELECT external_account_id INTO team FROM accounts WHERE id=account AND organization_id=org AND application_id=app;
  -- Legacy internal execution can have a scope without a provisioned account.
  -- An asserted API identity must always resolve; unknown internal teams stay null.
  IF NOT FOUND AND context IS NOT NULL THEN RAISE EXCEPTION 'Audit account scope mismatch'; END IF;
 END IF;
 NEW.audit_identity:=jsonb_build_object('version',1,'organization_id',org,'application_id',app,
  'service_principal_id',context->>'service_principal_id','user_id',context->>'user_id',
  'account_id',account,'external_team_id',team,'operation_id',operation);
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['audit_events','operations','quotes','execution_requests','credit_lots','journal_transactions','accounting_commands','quoting_commands','recipe_versions','configuration_versions','grant_revocations'] LOOP
  EXECUTE format('CREATE TRIGGER snapshot_audit_identity BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION uai_snapshot_audit_identity()',t);
 END LOOP;
END $$;
