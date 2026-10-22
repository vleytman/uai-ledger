ALTER TABLE provider_quota_bindings DROP CONSTRAINT provider_quota_bindings_pkey;
ALTER TABLE provider_quota_bindings ADD PRIMARY KEY(connection_id,model,group_id);
