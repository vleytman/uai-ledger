ALTER TABLE execution_dispatch_policies ADD COLUMN interactive_reserve integer NOT NULL DEFAULT 1 CHECK(interactive_reserve BETWEEN 0 AND 100000);
ALTER TABLE provider_quota_groups ADD COLUMN interactive_reserve integer NOT NULL DEFAULT 1 CHECK(interactive_reserve BETWEEN 0 AND 100000);
ALTER TABLE execution_limiters ADD COLUMN interactive_reserve integer NOT NULL DEFAULT 1 CHECK(interactive_reserve BETWEEN 0 AND 100000);
