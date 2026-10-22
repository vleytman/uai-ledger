# Cerebras, Groq, and Google Cloud

[Contents](README.md)

## Setup

The registry includes `cerebras@1`, `groq@1`, and `google_cloud@1`, with the five model IDs in the [configuration bundle](../configurations/ai/alternatives/). Updating the repository doesn't publish those models to your database. Use the [file configuration](FILE_CONFIGURATION.md) commands with separate connection bindings and the `alternative-models` budget.

Cerebras and Groq use a key from the encrypted credential vault. Google Cloud uses a JSON service account or authorized-user ADC in the same vault. The Google connection's `account_scope` must contain `project` and `location: global`. The worker obtains a short-lived OAuth token through google-auth-library. Concurrent attempts in one worker share token refresh; a refresh failure does not dispatch a generation. After a 401/403, the adapter does not retry an already dispatched generation. Tokens and JSON credentials are excluded from quotes, API reads, and browser bundles.

The Google route requires `service_mode: standard`. The request fixes `X-Vertex-AI-LLM-Request-Type: shared`; it does not send a Flex/Priority selection header. Priority is rejected at publication and execution. Requested mode is stored in the route/attempt snapshot and usage evidence; actual mode remains unknown until the API reports it. The owner enables billing/IAM/API separately.

## Capabilities and Tool History

Check TextFeatures for the exact combination of tools, forced choice, parallel calls, history, schema-streaming, tool-streaming, output limits, and usage counters a model supports. A general tools flag isn't enough. Schema and tools cannot be combined. Cerebras/Groq schema-streaming is disabled; Google supports native streamGenerateContent.

`tool_choice` accepts required, named, auto, and none. Required/named preserve the exactly-one-call contract. Multiple calls require auto and `parallel_tool_calls: true`, and the model must support parallel calls. A single-call result has type tool_call; multiple calls use tool_calls with a calls array. The provider ID is preserved and used in the subsequent tool_result.

Example input for the second request:

```json
{
  "messages": [
    {"role":"user","content":[{"type":"text","text":"Find the blue color"}]},
    {"role":"assistant","content":[{"type":"tool_call","id":"call-1","name":"lookup_color","arguments":{"color":"blue"}}]},
    {"role":"user","content":[{"type":"tool_result","call_id":"call-1","result":{"hex":"#0000ff"}}]}
  ]
}
```

For a tool error, tool_result contains `is_error: true`. Duplicate IDs, results without a call, and incomplete call groups are rejected. UAI does not execute user tools.

A Google thought signature is stored in the specific tool_call's `continuation`, with provider, model, and thought_signature. The application preserves this field unchanged. It is not part of the response text. A history with another provider's or model's signature makes fallback ineligible already at quote time. OpenAI/Anthropic currently reject the new history blocks; their existing single forced-call contract is preserved.

## Calculation and Tariffs

All five examples use estimated_actual. The mode is allowed based on adapter capabilities, rather than a whitelist of provider names. Expected output sets the forecast; max_output_tokens sets the limit sent separately. A new capped profile with an approximate estimate is rejected until a provider exposure bound has been established.

The estimator approximates tokens from the UTF-8 of the full context after schema compilation, framing, and image handling. It isn't a Qwen/Harmony/Gemini tokenizer and can substantially overestimate short prompts. Groq Qwen images count as 2048 tokens according to the model card; Cerebras/Gemini use an approximate 4096.

The [CountTokens documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/get-token-count), checked on 2026-09-26, lists Gemini 3.8 Flash, free token counting, and a maximum of 3000 requests per minute. Target-account availability was not checked, and image estimates can differ from billed usage. Quoting does not call CountTokens implicitly.

Chat completion_tokens already include reasoning, so reasoning is not added again. Gemini candidatesTokenCount and thoughtsTokenCount are counted separately, then summed. Cached input is subtracted from the full prompt count. Missing mandatory input/output counters leave usage unknown. A zero cache count when an optional counter is absent is not stored as a measured value. For Google HTTP 4xx/5xx, zero billable quantities are stored according to published billing rules, together with billing_basis; actual token counters remain unknown. Transport loss and HTTP 200 without usage do not become free requests.

Groq GPT-OSS 20B cache-read costs 0.0375 USD per million tokens. Groq Qwen caching is not declared. The Cloud rate card applies only to Standard/global and ends at 2027-01-01T00:00:00Z. A new published rate must be added as a separate version. After the period ends, publication, quoting, and new dispatch stop without an applicable rate. Already known costs do not disappear from accounting.

Provider cost, customer charge, and external payment remain separate. The preliminary cache forecast assumes a cold cache; confirmed cache hits are stored. Cache identity includes account, connection, model, prefix, tools/schema, and parameters other than the output forecast/limit. No explicit cache lifecycle is created.

## Quotas and Observability

Before enabling real traffic, bind connections to the account/model quota groups they actually share. Put multiple keys for one account in the same group. The JSON examples contain no installation-specific limits. Google 3.8 Flash has no declared fixed quota, and Standard throughput for the target account is unconfirmed. QCD options in the console do not establish Standard limits, nor does a table for nearby models. Verify the allocation on your account.

Adapters do not retry generations themselves. Shared execution policy, deadline, fencing, idempotency, and outcome_unknown apply without a separate queue. Token admission for the new models uses the conservative full context limit and max output. This may require a smaller profile or a verified estimator for low account quotas. Retry-After and available rate-limit headers feed the existing admission system. Auth, quota, transient, invalid, refusal, defect, and unknown errors remain distinct outcomes.

Existing queue metrics and request timings provide queue wait, active requests, TTFT, and total time. Usage observations contain terminal counters, finish reason, requested/actual service mode, and a provider stream flag. Quote-to-actual comparison uses the stored calculation snapshot and provider cost. This is a local calculation, not reconciliation against the provider invoice; reporting APIs for the new providers are not declared.
