ALTER TABLE configuration_versions DROP CONSTRAINT configuration_versions_kind_check;
ALTER TABLE configuration_versions ADD CONSTRAINT configuration_versions_kind_check
 CHECK(kind IN ('catalog','route','rate_card','execution_policy'));
