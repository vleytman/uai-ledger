ALTER TABLE storage_assets ADD COLUMN retention_seconds integer NOT NULL DEFAULT 604800 CHECK(retention_seconds BETWEEN 1 AND 2592000);
ALTER TABLE storage_assets ADD COLUMN last_used_at timestamptz;
ALTER TABLE asset_uploads ADD COLUMN retention_seconds integer NOT NULL DEFAULT 604800 CHECK(retention_seconds BETWEEN 1 AND 2592000);
ALTER TABLE asset_uploads ADD COLUMN external_project_id text;
ALTER TABLE asset_uploads ADD COLUMN project_generation text;
ALTER TABLE asset_uploads ADD CONSTRAINT upload_project_binding CHECK((external_project_id IS NULL)=(project_generation IS NULL));
CREATE TABLE storage_asset_holds (
 asset_id text NOT NULL REFERENCES storage_assets(id),
 request_id text NOT NULL REFERENCES execution_requests(id),
 created_at timestamptz NOT NULL,
 PRIMARY KEY(asset_id,request_id)
);
CREATE INDEX storage_asset_holds_request ON storage_asset_holds(request_id);
