# Cerebras, Groq, and Google Cloud

[Contents](README.md) · [Plan](ALTERNATIVE_MODEL_IMPLEMENTATION_PLAN.md)

## Setup

The registry contains `cerebras@1`, `groq@1`, and `google_cloud@1`. Only the five IDs from the [configuration bundle](../configurations/ai/alternatives/) are allowed. Importing the module and updating the repository do not publish them to the database. Installation uses the standard [file configuration](FILE_CONFIGURATION.md) commands, separate connection bindings, and the `alternative-models` budget.

Cerebras and Groq use a key from the encrypted credential vault. Google Cloud uses a JSON service account or authorized-user ADC in the same vault. The Google connection's `account_scope` must contain `project` and `location: global`. The worker obtains a short-lived OAuth token through google-auth-library. Concurrent attempts in one worker share token refresh; a refresh failure does not dispatch a generation. After a 401/403, the adapter does not retry an already dispatched generation. Tokens and JSON credentials are excluded from quotes, API reads, and browser bundles.

The Google route requires `service_mode: standard`. The request fixes `X-Vertex-AI-LLM-Request-Type: shared`; it does not send a Flex/Priority selection header. Priority is rejected at publication and execution. Requested mode is stored in the route/attempt snapshot and usage evidence; actual mode remains unknown until the API reports it. The owner enables billing/IAM/API separately.

## Capabilities and Tool History

TextFeatures describes tools, forced choice, parallel/history, schema-streaming, tool-streaming, output limit, and usage counters. A general tools flag does not imply an unknown combination. Schema and tools cannot be used together. Cerebras/Groq schema-streaming is disabled in this delivery. Google supports native streamGenerateContent.

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

The estimator counts the UTF-8 of the full context after the existing schema compiler, framing, and images. This is a local approximate estimate, not a Qwen/Harmony/Gemini tokenizer or a measured accuracy guarantee. For Groq Qwen, an image is counted as 2048 tokens according to the model card. Cerebras/Gemini use an explicitly approximate value of 4096. Error was measured on 34 live responses during functional verification, including vision and reasoning. The corpus is small and the approximate status is preserved; input forecasts substantially overestimate short prompts. This is not representative calibration. The [CountTokens documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/get-token-count), checked on 2026-09-26, lists Gemini 3.8 Flash and free token counting; the same page specifies a maximum of 3000 requests per minute. For images this is an estimate that may differ from final billed usage. Availability in the target account was not checked. CountTokens is not called implicitly during quoting.

Chat completion_tokens already include reasoning, so reasoning is not added again. Gemini candidatesTokenCount and thoughtsTokenCount are counted separately, then summed. Cached input is subtracted from the full prompt count. Missing mandatory input/output counters leave usage unknown. A zero cache count when an optional counter is absent is not stored as a measured value. For Google HTTP 4xx/5xx, zero billable quantities are stored according to published billing rules, together with billing_basis; actual token counters remain unknown. Transport loss and HTTP 200 without usage do not become free requests.

Groq GPT-OSS 20B cache-read costs 0.0375 USD per million tokens. Groq Qwen caching is not declared. The Cloud rate card applies only to Standard/global and ends at 2027-01-01T00:00:00Z. A new published rate must be added as a separate version. After the period ends, publication, quoting, and new dispatch stop without an applicable rate. Already known costs do not disappear from accounting.

Provider cost, customer charge, and external payment remain separate. The preliminary cache forecast assumes a cold cache; confirmed cache hits are stored. Cache identity includes account, connection, model, prefix, tools/schema, and parameters other than the output forecast/limit. No explicit cache lifecycle is created.

## Quotas and Observability

For an operational launch, connections are bound to existing account/model quota groups. Multiple keys for one account are bound to one group. Actual installation limits are not included in the JSON examples. Google 3.8 Flash has no declared fixed quota, and numeric Standard throughput for the target account is unconfirmed. The console shows QCD options; their limits cannot be applied to Standard. A general table of adjacent models does not replace account verification.

Adapters do not retry generations themselves. Shared execution policy, deadline, fencing, idempotency, and outcome_unknown apply without a separate queue. Token admission for the new models uses the conservative full context limit and max output. This may require a smaller profile or a verified estimator for low account quotas. Retry-After and available rate-limit headers feed the existing admission system. Auth, quota, transient, invalid, refusal, defect, and unknown errors remain distinct outcomes.

Existing queue metrics and request timings provide queue wait, active requests, TTFT, and total time. Usage observations contain terminal counters, finish reason, requested/actual service mode, and a provider stream flag. Quote-to-actual comparison uses the stored calculation snapshot and provider cost. This is a local calculation, not reconciliation against the provider invoice; reporting APIs for the new providers are not declared.

## Live Run

The historical smoke manifest contained 33 calls, five IDs, scenarios, input/output/image limits, and maximum spending. The total limit is 9.850552320 USD (9850552320 internal monetary units). Provider budgets sum to this limit. The upper financial estimate uses the models' full documented context/output limits, rather than expected output. It is intentionally much higher than the expected cost of short prompts.

```sh
pnpm exec tsx scripts/check-alternative-models.ts manifest
pnpm exec tsx scripts/check-alternative-models.ts fixture /tmp/ami-fixture-report.json
```

The runner requires a separate local database named uai_ami_test… or uai_ami_live…. Live mode additionally requires explicit approval of the manifest SHA256 in UAI_AMI_APPROVED_MANIFEST_SHA256, the paths UAI_AMI_CEREBRAS_CREDENTIAL_FILE, UAI_AMI_GROQ_CREDENTIAL_FILE, UAI_AMI_GOOGLE_CLOUD_CREDENTIAL_FILE, and UAI_AMI_GOOGLE_PROJECT, as well as real account scopes in UAI_AMI_CEREBRAS_ACCOUNT and UAI_AMI_GROQ_ACCOUNT. Do not send credential contents in chat. The run creates a separate installation, uses only its scoped worker, max_attempts=1, and sequential requests. On unknown usage/outcome or a refusal, it stops and stores IDs for investigation. At the end, real calls are disabled and the created connections are disabled. Result ACK occurs only after checking the completed request. The report stores IDs before dispatch, the cost of refusals with known usage, and remaining reservations. With unknown cost, cost_state=incomplete and cost_units contains only the known portion of the sum. Forecast-to-actual differences are reported for input/output/cost; relative_error_ppm is measured in parts per million and is null when actual is zero. The fixture is marked not_calibrated; the live smoke provides only a small sample_only sample. Operational routes and external LogoPanel are not activated.

Local browser fixture: `pnpm exec tsx scripts/run-alternative-fixture.ts`, with DATABASE_URL pointing to a separate uai_ami_test… database. The fixture password is ami-local-fixture, admin runs on 4336, and demo on 4337. Real providers are disabled.

Completed runs are summarized in [provider checks](REAL_PROVIDER_CHECKS.md). For a new manifest, UAI_AMI_CONTINUATION_REPORT points to the previous JSON report; the manifest command calculates a new SHA. Live mode requires separate approval of this SHA. UAI_AMI_DEFER_PROVIDERS allows explicitly deferring a provider without dispatch; the result is deferred, rather than passed.

UAI_AMI_RESUME_REPORT supplies a confirmed prefix of a previously started manifest. The runner checks statuses and cost against the database, requires closed reservations, skips every already dispatched request including failed ones, and preserves the original approval SHA. It cannot start at the second tools step without a saved first step. This continues remaining approved scenarios and does not authorize repeating a failed call. Resume is prohibited for unknown financial outcomes. Late cost confirmation for a terminal failed attempt uses `confirmFailedAttemptCost` only against an existing calculated cost entry, with actor/reason and audit; it does not change the outcome, start generation, or charge the customer after closure.

In the five bundles, live_validation=passed refers to functional acceptance on 2026-09-26. Credentials, access, and quotas for a new installation are checked separately; publishing these files does not automatically enable the primary route.
