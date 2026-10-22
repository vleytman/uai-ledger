# Jev System One integration plan

Plan date: 2026-09-25. Updated: 2026-09-26. The local path was implemented at the owner's request; see the [contract](JEV.md). Following the owner's clarification of 2026-09-26, a maximum of 32768 tokens was selected for reservations and quotas: this replaces the proven billable maximum requirement in JEV-D06/I00/I03. The file profile is active and has not been published to a running installation. The exact provider limit remains unknown. Paid acceptance completed: 5 successful calls, $0.000066948 of the authorized $0.05. The original assignment's phases and criteria are retained below.

[Contents](README.md) · [Decisions](DECISIONS.md) · [Paid APIs](PAID_API_PLAN.md) · [Universal invocations](UNIVERSAL_INVOCATION_PLAN.md) · [File configurations](FILE_CONFIGURATION.md) · [Local run](LOCAL_RUN.md) · [Real-check rules](REAL_PROVIDER_CHECKS.md)

## Scope

Connect the direct TypeSafe API for Jev through the existing `api.call` capability. Support `state` and a batch of named `choice`, `score`, and `noul` questions, typed results, actual-usage accounting, queues, cancellation, and safe UAI recovery.

Initial model: `jev-1.13.0`. Proposed identifiers: provider `typesafe`, adapter `typesafe@1`, profile `typesafe.jev-1.13.0`. The external model ID and internal operation key differ; their mapping is pinned in configuration and the adapter, and the client cannot substitute the model inside `input`.

Out of scope: automatically selecting other models through Jev, executing selected tools, product confidence thresholds, translating user content, LogoPanel integration, images/audio/video, text generation, automatic alias updates, deployment, and changes to existing connections. The application acts on Jev's results.

Low confidence is a successful response. UAI does not turn it into a technical defect, refusal, or reason for another paid attempt.

## Verified baseline

Snapshot of the current working copy on 2026-09-25, including parallel uncommitted changes. Recheck sources before implementation; this plan does not authorize overwriting others' work.

| Area | Already available | Required work |
|---|---|---|
| `packages/providers` | Registry, adapter interface, usage and rate-limit observations, API HTTP adapters | TypeSafe transport and validation that answers match questions |
| `packages/contracts/paid-api.ts`, `packages/api-services` | Operation input/output schemas, `provider_usage` measurements, `actual_capped` | Bounded dictionaries, type unions, and JSON-state validation |
| `packages/quoting`, `packages/execution` | Reservations, actual-cost calculation, unknown outcomes, JSON delivery as content | Check exposure bounds, preservation of model identity, and convenient JSON results |
| `packages/queue` | Quotas with different windows and shared account limits | TypeSafe rules and token-consumption estimates |
| `packages/sdk` | `services.quote` and `services.run` | Question/answer types and safe retrieval of a typed value |
| `packages/configuration`, `packages/catalog`, `packages/reconciliation` | Publishable versions, rates, connections, and key vault | Provider registration, profile, route, operation schema, and diagnostic capabilities |

Current `validateOperationSchema` requires closed input objects, rejects `additionalProperties` schemas and `anyOf/oneOf`, limits arrays to 100 items, and requires nonnegative input numbers. Jev's native format does not pass directly: questions and options are dictionaries, while `state` may contain nested JSON and negative numbers. The common structured-response compiler already exists in `packages/contracts/schema.ts`; first examine whether its checks and limits can be reused.

## Proposed technical decisions

| ID | Decision |
|---|---|
| JEV-D01 | Use `api.call` with a separate typed Jev contract. Do not introduce a new global capability or execution mechanism. |
| JEV-D02 | Pin `jev-1.13.0`. Store requested and actual models separately; do not substitute the requested value when the provider response omits it. |
| JEV-D03 | Make a direct HTTP request to fixed `https://api.typesafe.ai/v1/systemone`, obtaining the key from the existing vault. UAI controls retries; there are no hidden SDK retries. |
| JEV-D04 | Send all questions in one request as one provider call. Do not split batches or truncate input automatically. |
| JEV-D05 | Use `actual_capped`, actual input-token measurement, and a separate provider rate card. Initial customer policy: `cost_plus`, 0% markup, multiplier 1; these are proposed values, not a running installation's current rates. |
| JEV-D06 | Without an exact preliminary tokenizer, reserve the confirmed profile maximum. Do not describe this maximum as a forecast of actual price. Do not extend `estimated_actual` or debt authorization to Jev. |
| JEV-D07 | Retain output tokens for diagnostics and explicitly specify the current free output rate in pricing policy. Missing usage is not zero. |
| JEV-D08 | Treat lookup, cancel, provider idempotency, and cost/balance reporting absent from the public API as unsupported until evidence appears. UAI's local idempotency remains intact. |
| JEV-D09 | Existing SSE conveys request lifecycle and the completed result. Do not promise or simulate Jev token streaming. |

## Implementation phases

Current implementation statuses and remaining limitations appear in the report. Sequence: JEV-I00 → I01 → I02 → I03 → I04 → I05 → I06. Live acceptance JEV-I07 runs separately after the owner authorizes a specific budget.

### JEV-I00. Check the baseline and establish limits

- Record affected files and existing check failures, and review parallel provider and SDK changes.
- Recheck API/OpenAPI, model, rates, limits, and discrepancies between prose documentation and OpenAPI. For example, they describe required `instructions` and the minimum number of Score levels differently. Select an explicitly documented subset; do not infer compatibility from a single schema.
- Establish limits for JSON size, depth, question count, options, key length, and responses; separate UAI limits from provider limits.
- Clarify the numeric interpretation of 64k/32k and the relationship between the context limit and billable input tokens. Check for an official tokenizer or count endpoint. Without confirmation, do not call a heuristic exact or guaranteed conservative.
- Establish a proven upper cost bound per admitted request and refusal rules when it cannot be established. Do not publish an executable profile solely on the basis of a desired monetary cap.

Ready when: the model card, contract, resource bounds, and maximum justification are recorded; unknowns are explicit. A key is not required for local implementation.

### JEV-I01. Types and bounded validation

Input contains `state` and `questions`. `state` accepts a string, JSON object, or array; nested values are validated as JSON with finite numbers and resource bounds. `questions` is a nonempty dictionary. Support string and structured instructions/criteria within the selected contract. For the first version, require meaningful `instructions`; do not rely on OpenAPI making them optional.

Choice contains an option dictionary; the current provider maximum is 255. Score contains ordered levels; the supported subset is 2–10. Noul contains optional `true/false` criteria. Limit question count and total size separately; the Choice limit does not imply that any total batch size is acceptable.

Extend the common schema subset only with necessary constructs: bounded dictionaries, unions, constants/discriminators, and property-count bounds. Provide explicit bounded validation for arbitrary JSON state; do not allow unbounded recursive schemas or external references. Preserve strict validation for other API operations. Do not pass JSON as strings to bypass the validator.

Result validation must match actual questions and answers: identical keys and types, Choice only from original options, valid probability and legend keys, finite numbers, the 0–1 range, and distribution sums within a documented rounding tolerance. Score allows a fractional expected value and is checked against the original scale. Noul receives no invented confidence field. Errors include a path and reason without private content.

Ready when: contract and negative tests pass; unsupported forms and exceeded bounds are rejected before sending, and existing API schemas are not weakened.

### JEV-I02. TypeSafe adapter

Add the adapter and register the provider in every actual allowlist. Serialize exactly the selected model, state, and questions; prohibit arbitrary endpoints/headers. Bound response size, the overall deadline, and transport time, and honor the cancellation signal.

Save usage before accepting content as successful: a defective response with known consumption still incurs provider cost. Save the actual model in the result and available attempt data. Record a provider request ID only when present in the response; do not present a local attempt ID as one. An audit-write failure must not authorize another paid dispatch.

Classify 401/403 as access problems and 422 as invalid requests. Handle 429 and documented 529 with backoff and `Retry-After` within the overall attempt limit and deadline. Treat other 5xx, connection loss, and a lost response after sending as unknown outcomes unless safe retry is proven. Canceling the local wait does not prove that TypeSafe computation was canceled.

Ready when: transport tests confirm one HTTP request per attempt, correct JSON, usage, errors, and no hidden retries.

### JEV-I03. Estimation and financial calculation

Create a versioned rate card with source, verification date, and exact decimal strings. Observed research-date price: $0.042 per 1,000,000 input tokens; output is free. Recheck before publication.

Provider-cost calculation: `usage.input_tokens × 0.042 / 1000000` USD. Use existing exact arithmetic and UAI monetary units; transmit all monetary integers as strings in the API. Retain exact intermediate cost and apply current half-up rounding once to the attempt total, and upward rounding to the maximum reservation. Check small amounts and zero rounded totals: they do not mean usage was absent. Do not introduce a hidden minimum charge.

The initial quote uses the confirmed maximum from I00; the current API mechanism substitutes `measurement.maximum` before usage arrives and reserves `pricing.max_units` for `actual_capped`. Align the measurement maximum, route limit, customer reservation, and risk budget. After execution, charge the actual customer price within the accepted cap and release the remainder. Record confirmed provider cost above expectations in full; do not automatically charge the customer above the cap.

Check success, defect, missing/invalid usage, cancellation before/after dispatch, unknown outcome, disputed-reservation expiry, late usage, ACK, and reversal of the original charge. A fixed reservation may obstruct users with small balances; state this in the contract. Treat a more accurate forecast as a later improvement if there is no verified method.

Ready when: integration checks confirm separation of provider cost and customer charge, the cap, reservation release, and no duplicate postings.

### JEV-I04. Configuration and quotas

Add the operation, catalog, rate, route, and profile file package following the repository's current structure; check preview and publication on a test installation. Do not create a second editor for these values in the admin interface. Initial statuses: `live_validation=not_run`; explicitly reflect the absence of live-execution evidence.

The connection uses existing key storage and provider-account grouping. `allowance_mode=unmetered` means there is no provider allowance package tracked by UAI, not that service is free or has no rate limits. Do not display an invented account balance.

Configure independent requests/minute and tokens/second windows in the common quota mechanism. The 1,200 RPM and 250,000 tokens/second published on the research date are a reference; the provider warns that limits may change. Store applicable values as account settings. Align admission token estimates with I00 and reconcile actual consumption from the response. Multiple keys on the same account do not create independent quotas.

Ready when: configuration passes checks and local publication, unsupported settings are rejected, and concurrent workers obey the shared quota.

### JEV-I05. SDK and result presentation

Keep the common `services.quote/run` path; add exported types and a small Jev helper that infers question and Choice-option keys in TypeScript. The helper uses normal UAI authorization, idempotency, events, and result retrieval.

Provide a validated JSON value together with the actual model without requiring each application to parse a string manually. Check the current manifest: an API operation may be delivered as `type:text` with `application/json`. Choose a common representation for JSON services, align manifest/API/SDK and existing consumers, and do not add a separate incompatible response only for Jev. Before the first launch, legacy adapters solely for compatibility are unnecessary.

Add a minimal mixed-batch example and result/usage display to the existing demo. Existing profile, connection, and attempt pages with correct names and statuses suffice in the admin; a separate visual question editor is out of scope. Do not present unsupported chat/tools/streaming settings as Jev capabilities. Check the interface through Aside in the exact local environment.

Ready when: the example completes the full local quote → run → JSON result → ACK path; types retain keys and options, and low confidence displays as a result.

### JEV-I06. Overall local acceptance and documentation

Run targeted adapter, schema, SDK, and configuration tests; verify financial and concurrency scenarios on isolated local infrastructure. Then run type, API, configuration-schema, documentation, and build checks according to current scripts in `package.json` and LOCAL_RUN. Do not run paid checks as part of the normal test suite.

Align API, SDK, capability descriptions, calculations, examples, and acceptance matrix. Record results in a separate report with JEV-Axx and “passed / failed / not run” statuses. List omissions and preexisting baseline errors separately. Prepare an exact live-check scenario.

Ready when: local implementation is reproducibly verified, documentation describes actual behavior, and real calls remain `not_run`.

### JEV-I07. Separate live acceptance

After separate budget authorization, run five small anonymized scenarios: Noul, Choice, Score, a mixed batch, and ambiguous input. First prepare exact inputs, model, attempt count, applicable maximum cost, and stop conditions; propose an overall budget accounting for possible retries. The current planning request does not authorize these calls.

Use one attempt per scenario and retain financial results without secrets or private content. Stop on unknown outcome, unexpected price, or model mismatch; do not automatically retry. Separately check the authenticated model list; a missing snapshot ID in an alias list alone does not prove that version is unavailable.

Check the actual model, all response types, usage, UAI cost, and reservation release. Measure total UAI latency and HTTP time separately; five requests are not evidence of p95, SLA, or model quality. Reproduce errors and edge cases primarily with local fixtures; do not create artificial provider load.

## Acceptance criteria

| ID | Behavior checked |
|---|---|
| JEV-A01 | One mixed batch produces one provider request; question keys and the actual model are preserved. |
| JEV-A02 | String and structured state, instructions, and criteria pass without hidden truncation or value changes. |
| JEV-A03 | Empty questions, invalid types, unsupported parameters, and exceeded local/provider limits are rejected before dispatch. |
| JEV-A04 | Response types/keys, Choice options, Score scale, probabilities, and rounding tolerance are checked; errors include a path and reason. |
| JEV-A05 | Noul receives no invented confidence; low confidence does not trigger retry, fallback, or refusal to pay for a valid result. |
| JEV-A06 | Cost is calculated from actual input tokens, with explicit free output; missing usage does not become zero. |
| JEV-A07 | The quote uses a justified maximum; reservation and final charge respect the cap, and the remainder is released. |
| JEV-A08 | Unexpected excess cost is recorded as provider cost without automatically exceeding the customer cap. |
| JEV-A09 | A response defect with known usage retains provider cost; customer settlement follows the current defect policy. |
| JEV-A10 | Repeated client commands, queue delivery, and worker recovery do not create a second dispatch or duplicate charge. |
| JEV-A11 | Timeout/lost response after sending preserves outcome_unknown; late observations do not violate the disputed-reservation closure deadline. |
| JEV-A12 | 429/529 respect backoff, Retry-After, overall deadline, and attempt limit; the SDK performs no hidden retries. |
| JEV-A13 | Cancellation before/after dispatch is distinguished; stopping HTTP is not declared confirmation of provider cancellation. |
| JEV-A14 | RPM/TPS windows and the shared account quota work with concurrent workers; keys on one account do not double the limit. |
| JEV-A15 | JSON value, actual model, events, ACK, and cleanup are available through aligned API/SDK; existing JSON services pass regression checks. |
| JEV-A16 | File definitions, schemas, SDK, and UI align; absent reporting/balance/lookup features are not shown as available. |
| JEV-A17 | Firecrawl/Serper schemas and other models' structured responses pass regression checks; new forms cannot bypass resource bounds. |
| JEV-A18 | Real acceptance has separate authorization, budget, and report; local fixtures do not set live_validation=passed. |

## Effort estimate and revision conditions

Preliminary estimate: 2–4 working days for I00–I06 if existing schema validation and JSON delivery can be reused. This is an estimate, not a committed deadline; repeat after I00. Separate waiting time for access/live-acceptance authorization is excluded.

Reasons to revise: no confirmed billable-token limit, need for a shared JSON-result format change, incompatibility between the current schema compiler and bounded dictionaries, TypeSafe API changes, or overlap with parallel work. Add database migrations only if existing facilities cannot correctly store the model/result.

## Sources

Checked during assessment on 2026-09-25. Recheck changeable information before implementation and live acceptance.

- [TypeSafe API](https://docs.typesafe.ai/api) and [OpenAPI](https://api.typesafe.ai/openapi.json): transport, questions, responses, usage, and errors.
- [Models](https://docs.typesafe.ai/models): `jev-1.13.0`, rates, context, aliases, and changeable quotas.
- [Primitives](https://docs.typesafe.ai/primitives) and [confidence](https://docs.typesafe.ai/confidence): result semantics.
- [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): quality boundaries; assessing application-decision quality remains a separate task.
