-- Optional gateway address for OpenAI and Anthropic connections; NULL keeps the provider default.
ALTER TABLE provider_connections ADD COLUMN base_url text CHECK(base_url IS NULL OR provider IN ('openai','anthropic'));
