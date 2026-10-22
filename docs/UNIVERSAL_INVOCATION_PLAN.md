# UAI universal invocation extension plan

Date: 2026-09-25. Status: implementation started; criteria and phases are listed below. Initial inspection used UAI `6745373`. Recheck subsequent changes before starting each phase.

[Contents](README.md) · [Decisions](DECISIONS.md) · [Execution](EXECUTION.md) · [Quoting](QUOTING.md) · [File configuration](FILE_CONFIGURATION.md) · [Local verification](LOCAL_RUN.md)

## 1. Goal and boundaries

Give applications one invocation with multimodal context, tools, validated structured results, streaming, and configurable execution terms. Use UAI's existing queues, accounting, identity, and storage.

UAI gains no director, character, round, or discussion entities. The application selects context, roles, models from permitted routes, permissions, and post-result actions. Product-action settings reside in the application and pass through the server SDK. The application executes tools. Images and mockups requiring human approval continue through quoting and operation acceptance; new text capabilities must not bypass this boundary.

Before the first joint UAI and LogoPanel launch, backward compatibility is not required. Contracts, SDK, configurations, and tests change together, without legacy branches or additional versions solely to preserve earlier behavior. Financial idempotency, pinning accepted request terms, and protection against resubmitting unknown outcomes remain mandatory.

This plan does not authorize product-logic implementation in the LogoPanel repository, changes to existing connections, paid calls, or deployment. Their checks are listed as separate readiness phases.

## 2. Agreed decisions

| ID | Decision |
|---|---|
| UI-D01 | Defaults are mandatory. Precedence: UAI default, selected profile, specific-call parameters. Missing parameters and `{}` are equivalent. Partial overrides inherit other fields; invalid values are rejected. |
| UI-D02 | Default overall duration is 300 seconds from acceptance, including queueing, execution, and retries. Maximum is 4 attempts including the first. The agreed absolute installation limit is 8; requests and profiles cannot raise it. |
| UI-D03 | Short retries respect Retry-After and the overall deadline. Extended recovery is off by default. Model changes, schema-validation retries, and worker restarts do not reset the overall counter. |
| UI-D04 | OpenAI and Anthropic are included in the first text delivery. Cross-provider switching is allowed only through explicitly configured routes with compatible capabilities. |
| UI-D05 | Automatic LogoPanel text calls use estimated_actual: forecast reservation, actual charge, possible debt. New calls with debt receive insufficient_credits. |
| UI-D06 | Input defines tools; the result contains a parsed call. UAI enforces “exactly one” mode. UAI does not automatically execute tools or run tool loops. |
| UI-D07 | UAI validates JSON Schema. Technical defects recover within the accepted policy at platform expense. Semantic refinement of a valid answer is not a technical retry. |
| UI-D08 | Model refusal is a separate terminal outcome, refused. Accepted policy determines billing; refusal does not trigger automatic retry or circumvention through a fallback model. |
| UI-D09 | When retry is permitted after text display, a new attempt resets provisional text. The final valid result is the source of truth. |
| UI-D10 | Cache has separate read/write counters; reservation forecasts may include expected hits. Hits are not guaranteed; a miss is permissible under estimated_actual. |
| UI-D11 | LogoPanel owns original images and resizing for LogoPanel. UAI sends original bytes unchanged by default; resizing, rotation, and transcoding require explicit enablement. |
| UI-D12 | Input assets can be reused in different requests by one owner. The discussed scenario uses 7 days of inactivity retention with renewal. This is a setting, not a constant of the common mechanism. |
| UI-D13 | wallet.updated follows financial changes; available already excludes reservations and includes debt. The application computes balance warnings. |
| UI-D14 | Embeddings enter the overall plan as a separate capability; their implementation does not block text readiness. The application owns persistent vectors and search. |

Earlier `2+2`, three recovery cycles, and 16 attempts in existing documentation describe the previous implementation. When implementing UI-D02/UI-D03, replace them consistently in specifications, runtime, and configuration rather than retaining a second execution system.

## 3. Baseline

| Area | Existing behavior and required changes |
|---|---|
| Invocation and money | POST /invocations, ai.run, reservations, and insufficient_credits already exist. estimated_actual is limited to single OpenAI text calls. |
| Policies | Recipes and routes have deadlines. Retry/recovery counts are fixed in catalog and execution; no common call override exists. |
| Structure | response_schema reaches adapters and is validated locally. A bounded JSON Schema subset is supported. A50 checks recovery before streaming starts. |
| Started stream | reason=output_started currently forbids retry of unsuccessful responses. This must change for UI-D09. |
| Tools and images | No native tools. Messages are strings. The common layer passes assets, but real OpenAI and Anthropic text adapters do not accept them. |
| SSE and SDK | Deltas travel through NOTIFY; handlers with asynchronous access checks may finish out of order. No attempt_id/sequence. ai.run polls final results. |
| Cache | cache_read/cache_write normalized. No common prefix-boundary control or public typed result usage. Demo estimates assume cold input. |
| Assets | Public upload sets one hour. Model-priced input preparation always does rotate/resize/toFormat. Original bytes are possible by bypassing this preparation. |
| Routes | estimated_actual currently requires fallback compatibility in shared rate table, preparation, and normalized parameters; this is insufficient for two different providers. |
| Wallet | Events are created in financial transactions; SSE polls outbox every 500 ms. Operation-only subscriptions exclude wallet.updated. |

Main change points: [API contracts](../packages/contracts/api.ts), [quoting](../packages/quoting/src/index.ts), [execution](../packages/execution/src/index.ts), [runtime](../packages/execution/src/runtime.ts), [adapters](../packages/providers/src/index.ts), [SDK](../packages/sdk/src/index.ts), [API/SSE](../apps/api/src/server.ts).

## 4. Recommended contract

New field names below are implementation proposals rather than an existing API.

### Invocation

- `input`: ordered messages with text and image blocks, instructions, tool definitions, tool_choice, response_schema. An asset may occupy a specific message position.
- `execution`: deadline, max_attempts, backoff, safe-retry reasons, permission for another attempt after provisional output. Routes are selected from those available to the application; arbitrary client connections are not accepted.
- `billing`: settlement mode and refused billing rule. Options are authorized by installation/profile configuration rather than an arbitrary untrusted client.
- `delivery`: streaming request and selected string fields from structured results. Fields use generic paths such as `/message`; the message entity is not hardwired into UAI.
- `parameters`: supported model parameters, separate from execution rules. `expected_output_tokens` forecasts consumption; an explicit generation bound is a different parameter.

Defaults apply to optional settings. They do not remove required input or selection of an available model/profile. Do not inherit arrays by index: explicit lists replace the entire list, while policy objects merge by known schema fields. `null`, unknown fields, negative durations, and max_attempts=0 are errors rather than absent values.

Validation before reservation must cover every permitted route variant: tools, tool selection, schema, images, cache, parameters, and calculation method. Do not remove an unsupported constraint to make failover succeed. Do not implicitly expand current JSON Schema support: begin with one explicitly documented common subset for both adapters, rejecting unsupported combinations.

### Policy and storage

| Layer | Location and responsibility |
|---|---|
| Defaults and named policies | JSON in UAI Git, published through common configuration machinery; example new file `configurations/execution/default.json` |
| Active definitions | UAI database after validate/preview/publish/activate; change history required for audit and reproducibility |
| Installation bounds | Operational database configuration: max_attempts=8, limits on duration/loss/size/subscriptions. This plan does not raise the agreed attempt limit. |
| Product settings | LogoPanel repository and server; role names and logic absent from UAI |
| Accepted terms | Request snapshot: effective policy, route variants, each variant's calculation terms, acceptance, and deadline_at |

One parameter has one editing source. File policies appear in admin without a second independent editor; operational bounds are edited in the database. Out-of-bounds settings are rejected before acceptance rather than silently clamped.

For four attempts, proposed exponential backoff uses a 1-second base: 1, 2, 4 seconds with bounded jitter. The third delay is a technical continuation of previously proposed 1/2 seconds rather than a new recovery cycle. Policy defines base/multiplier/cap. Do not start another attempt if Retry-After exceeds the deadline.

Configuration changes do not rewrite active-request snapshots. Absolute operational bounds are rechecked before dispatch; reducing a limit does not authorize another call. This controls current execution rather than supporting an old API.

### Result and settlement

Return a typed result view: text, parsed structured object, parsed tool call, or refused. Store execution_status and settlement_status separately: a result's existence does not prove that unknown usage is already settled.

A tool call contains a stable UAI ID, name, and parsed arguments. Its ID stays stable when retrieving the final result again; the original provider ID is stored separately when available. The application checks permissions, current state, and execution idempotency. UAI does not call application functions.

Usage is returned per attempt and as an explicitly labeled request summary: uncached/read/write/output, model/provider, and whether metrics are known. Failed-attempt provider costs and customer charges remain separate. Monetary amounts travel as integer strings.

Support `platform` and `actual_usage` for refused in billing policy. The owner approved default `platform` on 2026-09-25; the application may explicitly select `actual_usage`. Unknown refusal cost does not become zero.

## 5. Implementation phases

### UI-I00. Contracts, defaults, and aligned specification

1. Move policy, multimodal-input, tool, result, and event schemas into contracts. Define permitted tools/response_schema combinations by model capabilities; do not promise arbitrary combinations.
2. Implement one pure function resolving defaults and bounds. Use it in quote, invocation, and request creation within an accepted operation.
3. Extend configuration definitions, publication, active bindings, and discovery capabilities. Add accepted-policy identity and per-variant snapshot fields.
4. Update OpenAPI and generated SDK types. Old-format support is unnecessary.
5. Update DECISIONS, API, EXECUTION, QUOTING, MODEL_PRICING_SPEC, FILE_CONFIGURATION, README, and IMPLEMENTATION together. Preserve existing requirement/acceptance IDs; new checks receive UI-Axx.

Files: `packages/contracts/api.ts`, `packages/providers/src/contracts.ts`, `packages/catalog/src/index.ts`, `packages/configuration/src/index.ts`, `packages/quoting/src/index.ts`, `apps/api/src/profiles.ts`, `scripts/generate-openapi.ts`, `scripts/generate-configuration-schema.ts`, new migrations in `migrations/`. Update checked generated artifacts `docs/openapi.json`, `configurations/schema.json`, and `packages/sdk/src/generated/`.

Ready when: missing block, `{}`, and equivalent partial inheritance yield identical effective conditions; invalid parameters are rejected before reservation. Publication requires no LogoPanel entities. Check publish → active profile serializer → SDK: policy/capability fields must not disappear from discovery.

### UI-I01. Finite attempts, routes, and model refusal

1. Replace hardcoded retry/recovery slots, cycle counts, and regeneration delays with a common next-attempt policy. Do not mechanically replace matching numbers in observation or financial-reconciliation durations. Support finite explicit recovery configuration, disabled by default. Recovery uses the same overall counter.
2. Atomically reserve the dispatch number before contacting the provider under existing locks/fencing. If a process dies after dispatch admission, do not reset the number or assume no external call occurred.
3. Job redelivery and repeated HTTP with the same idempotency key do not create a new paid attempt. Predispatch quota waiting, lookup, and original-job polling are not repeat generation; observation retains its own finite deadlines.
   Disable hidden paid-submit retries in HTTP/provider SDKs: every new dispatch must pass common UAI admission and counting.
4. For a confirmed defect after output_started, allow another attempt only under accepted policy and reset support. Do not regenerate for unknown, canceled, refused, or final errors.
5. Normalize refused separately and add terminal status to all API, SDK, queue, admin, demo, and settlement checks. Apply accepted billing policy idempotently.
6. Preserve compatible parameters, rates, and markup per route variant. Successful-attempt settlement uses its model's accepted terms. Failed technical attempts count as platform costs and remain within its risk budget.

Limit 8 applies to attempts per request and differs from concurrent worker/slot limits. Disabling extended retry recovery does not stop original native-job observation, reconciliation, or unknown financial closure. Separately check existing submit/observation timeouts so unexpected internal limits do not override accepted policy.

Files: `packages/execution/src/index.ts`, `packages/execution/src/runtime.ts`, `packages/execution/src/default-runtime.ts`, `packages/queue/src/`, `packages/catalog/src/index.ts`, `packages/quoting/src/index.ts`, `packages/providers/src/`, `packages/accounting/src/index.ts`.

Ready when: concurrent workers, restarts, fallback, and defective JSON cannot exceed the default 4 attempts or installation limit; max_attempts=1 forbids retries; unknown remains the original attempt.

### UI-I02. Original images and reusable assets

1. Separate image validation from transformation. In preserve mode, validate digest, type, size, decodability, and model limits, while sending identical bytes including original orientation/metadata.
2. Retain existing resize as an explicit transform. Do not rotate, pad, or toFormat without agreed settings. Size limits mean rejection rather than hidden resizing.
3. Calculate input tokens from actual dimensions and sending settings. Remove mandatory-preparation dependency from pricing; current 1024×1024-square assumptions cannot apply to arbitrary originals.
4. Extend uploaded input-asset retention and generic project binding. Set last_used_at on accepted use; normal GET and rejected requests do not renew retention. Provide explicit renewal by an authorized application. Initial TTL for a new available copy begins at upload completion.
5. Add holds from accepted requests to protect assets from normal TTL cleanup until use ends. Result ACK does not delete a shared input asset needed by other calls.
6. Project deletion closes new access, cancels unsent requests, and forbids late content delivery. Cleanup of held files after references release must not revive a deleted project.
7. The application uploads an expired copy again from its original. Output assets still transfer to the application for storage and later input upload; directly turning output into durable input is outside this phase.

Files: `packages/quoting/src/prepare-model-assets.ts`, `packages/model-pricing/src/index.ts`, `packages/model-pricing/src/examples.ts`, `packages/storage/src/index.ts`, `apps/api/src/server.ts`, `packages/contracts/api.ts`, `packages/sdk/src/index.ts`, admin and configuration preparation settings.

Ready when: original-byte hash matches the decoded attachment hash in the provider request; explicit transform changes only declared properties; assets reuse and clean up without disrupting active execution. UAI gains no LogoPanel image-variant catalog.

### UI-I03. Multimodal text, tools, and schemas on two adapters

1. Implement normalization of ordered text/image blocks for OpenAI and Anthropic. Support only verified image formats/modes for the specific model.
2. Send tool definitions and required/named tool_choice; forbid parallel calls in “exactly one” mode. Independently of provider options, locally validate result count, name, and parsed arguments.
3. Preserve server-side JSON Schema validation. For structured output, return the object together with original final text; do not parse model refusal as the expected business schema.
4. Validate schema/model eligibility before dispatch. Do not hide incompatibility through prompt-only tools/schema imitation.
5. Include tool definitions, instructions, response schema, framing, and images in the estimator. Extend estimated_actual to Anthropic while preserving independent provider-cost, customer-charge, and allowance accounting.

Files: `packages/providers/src/contracts.ts`, `packages/providers/src/index.ts`, `packages/providers/src/parameters.ts`, `packages/providers/src/usage.ts`, `packages/quoting/src/index.ts`, `packages/quoting/src/estimation.ts`, `packages/model-pricing/src/tokenization.ts`, `packages/execution/src/runtime.ts`.

Ready when: both adapters pass the same contract matrix on mock transport: images in the correct positions, one required tool call, invalid arguments, missing/multiple calls, valid schema, defect, and refused. Matching fixtures are not declared real-provider acceptance.

### UI-I04. Ordered stream for one invocation

1. Introduce an attempt event and delta envelope with request_id, attempt_id, monotonic attempt number, fencing/generation, sequence, and field_path. Sequence increments within an attempt across all deltas regardless of field. Control events contain no text; delta payloads remain transient.
2. Serialize access validation and sending within one stream. Reject old-worker/attempt deltas after fencing-token changes. A higher-order attempt start resets preceding provisional text. Even if attempt/reset is lost, the SDK detects a new attempt through the envelope, resets text, and marks a gap; duplicates and late deltas are ignored.
3. For a new call, implement one streaming invocation endpoint: shared LISTEN and subscriber are ready before acceptance commit, accepted is emitted first, and early deltas are bounded-buffered until accepted. On reconnect, first register a subscriber for the known request, then read the attempt/result snapshot, reconcile buffered events by generation/sequence, and only then resume delivery. Completion or attempt changes in this interval must not be lost; deltas are forbidden after terminal-result delivery. Do not rely on POST followed by the client subscribing to GET events in time.
4. Use one shared LISTEN per API process and bounded subscriber buffers rather than one database connection per subscriber. Disconnect slow clients with final-result retrieval available, without blocking the provider.
5. Add an incremental parser for selected JSON string fields. Handle UTF-8, escape, Unicode, key, and string splits between chunks. The message field must not be a parser special case.
6. SDK provides ai.stream as an async iterator and onDelta/onAttempt in ai.run over the common mechanism. Transport disconnection does not cancel generation or create a new invocation. Explicit cancellation remains a separate action.
7. The final result completely replaces provisional text; persist runs before ACK. When deltas are lost, the SDK marks live display incomplete rather than presenting it as a saved result. For a fast response, the application places message first in the schema; early field generation is checked on selected models.

Files: `apps/api/src/server.ts`, `packages/execution/src/default-runtime.ts`, `packages/execution/src/runtime.ts`, `packages/contracts/api.ts`, `packages/sdk/src/index.ts`, a new transient event-hub and parser module.

Ready when: the first delta is not lost to a startup race, ordering survives slow access checks, attempt changes do not concatenate answers, and reconnect consumes no additional attempt. Deltas do not enter the durable financial outbox.

### UI-I05. Prefix cache, usage, and reservation forecast

1. Add provider-independent stable-prefix hints to blocks. Adapters must state support for explicit boundaries or automatic caching; do not promise identical mechanics across providers.
2. Build safe prefix identity from owner scope, model/connection, block order and content, tools/schema, image-processing parameters, and byte digest. Schema/tool/image changes invalidate the relevant assumption.
3. Store only bounded observation metadata: digest, time, scope, model, confirmed counters, and usefulness expiry. Do not create a second permanent prompt store or declare provider cache guaranteed.
4. Use cold estimates for cold or unconfirmed prefixes. For justified expected hits, split the forecast into uncached/read/write and output. Save expected estimate, cold estimate, and confidence; reserve the forecast under estimated_actual.
5. On fallback to another model/connection, reset unconfirmed hit expectations. Route terms must account for possible cold cost; the original reservation does not become a hard ceiling on actual charges.
6. Normalize public usage without inventing missing counters. Do not assume cache write is zero merely because the field is absent. Separately validate total input and its breakdown using the specific model's documentation/observations.
   Pricing breakdown preserves write categories with different rates/TTLs when the model provides them. Cached input is not charged again as uncached; rounding follows the accepted method, and each category's rates enter the route-variant snapshot. An aggregate cached counter does not prove that the entire marked prefix hit cache.
7. Preserve insufficient_credits as a predispatch rejection, separate from provider allowance/quota and backpressure. Add a typed SDK code/guard for existing insufficient_credits. Concurrent accepted calls may finish with aggregate debt; the application's warning is not a financial block.

Files: `packages/providers/src/usage.ts`, `packages/quoting/src/estimation.ts`, `packages/quoting/src/index.ts`, `packages/model-pricing/src/`, `packages/execution/src/runtime.ts`, `packages/contracts/api.ts`, `packages/sdk/src/index.ts`, new metadata tables.

Ready when: a warm forecast admits a call whose balance is below the cold estimate; a miss creates correct actual charge/debt without duplicate charging; switching providers does not use another provider's cache session. Do not promise “ten times” or “four times cheaper” without measurements.

### UI-I06. Wallet events, observability, and latency

1. Keep wallet.updated in the same transaction as capture/release/reserve and other postings. After commit, wake the outbox reader through a metadata-only notification; retain periodic polling to recover missed wakeups.
2. SDK provides wallet/account subscriptions separately from request streams. Use wallet.revision when applying new snapshots; reconnect reconciles against the current wallet. Operation subscription does not replace wallet subscription.
3. Add timestamps: received, accepted, enqueued, dispatched, provider_first_delta, api_first_delta; the test setup also records client_first_delta. Separate UAI and provider latency, cold/warm cache, input length, available limits, and backpressure.
4. Remove the relay's one-second wait from an unconstrained request's path: wake the scheduler after commit with durable relay/reconciliation guaranteeing recovery. Do not replace a reliable queue with a single lossy notification.
5. Measure p50/p95/p99 to first delta for single and concurrent calls. The target of approximately 1 second concerns invocation acceptance and first visible content with available limits. Do not substitute dispatch time or the first technical SSE line.

Files: `packages/accounting/src/index.ts`, `packages/db/src/index.ts`, `apps/api/src/server.ts`, `apps/scheduler/src/index.ts`, `packages/queue/src/relay.ts`, `packages/queue/src/scheduler.ts`, `packages/sdk/src/index.ts`, load runner, and telemetry.

Ready when: every nonzero capture/release yields a current wallet snapshot after commit, available excludes reservations, and measurements include distributions and conditions. The old p95 dispatch figure of about 1.1 seconds is not verification of the new target. If the model itself cannot meet one second, explicitly record that limitation rather than declaring the SLO met.

### UI-I07. Overall local acceptance and integration guide

1. Build a generic fixture client with text, image blocks, tools, schema, streaming, and wallet. Use role scenarios only as test inputs, without product logic in the core.
2. Add accepted policies, remaining attempts, actual model, refused, cache breakdown, and measured timings to admin; do not add a database editor for file policies.
3. Publish an integration guide: server SDK, identity, ai.run/ai.stream, persist-before-ACK, insufficient_credits handling, result/settlement separation, asset recovery, and wallet subscription.
4. Prepare LogoPanel submodule/build updates as a separate parent task. Discussion code, tool execution, image dimensions, and balance warnings remain in that task. Do not create LogoPanel placeholder files in UAI.
5. Run real acceptance calls only within a separately authorized budget after checking current official provider contracts and specific models. Check both adapters, tools, schema+stream, images, cold/warm cache, and fallback. Include no real credentials/private content in the report.

Ready when: UI-A01–UI-A18 below are complete, evidence limitations are preserved, and no live-support claim rests on fixtures alone.

### UI-I08. Embeddings, separate later phase

1. Add capability `embeddings.generate`, string batches with stable indices, and model/dimension in responses. Request dimensions only from models supporting them.
2. Normalize provider usage and count whole-batch tokens with reservation/charge through the common mechanism. Do not turn every item into a separate hidden invocation.
3. Validate vector count, indices, dimension, and finiteness of every number; bound item count and result size.
4. Recommended first contract: atomic batch delivery. An incomplete batch is a result defect, with recovery bounded by the common policy. Do not implicitly include partial client results.
5. Use current temporary-result and ACK rules. The application stores persistent embeddings, index, and search. Select the first specific provider/model when starting this phase; support for both text adapters does not require both to have embeddings endpoints.

Files: capability enums in contracts/providers/catalog, new embeddings adapter, quoting/model-pricing, execution validation, SDK, and generated types. Checks: UI-A19–UI-A20.

## 6. Order and dependencies

`UI-I00 → UI-I01`; after contracts, `UI-I02` can proceed independently of retries. `UI-I03` uses I00/I01/I02. `UI-I04` completes streaming over I01/I03. `UI-I05` uses actual input/usage formats from I02/I03. `UI-I06` begins metrics collection earlier, but final measurements follow I04/I05. `UI-I07` integrates the text scenario. `UI-I08` follows separately without blocking I07.

Update related contracts and tests together at each phase. Do not release an SDK form the server does not yet accept. Runtime, configuration, and documentation changes must describe one system without a parallel old branch.

## 7. Acceptance matrix

| ID | Check and expected result |
|---|---|
| UI-A01 | Missing parameters, `{}`, and explicit defaults equivalent; partial inheritance deterministic; invalid values create no reservation. |
| UI-A02 | Default 4 attempts, 1 without retries, maximum 8 under installation settings; duplicate delivery, restart, and fallback cannot bypass limits. |
| UI-A03 | Deadline includes queue/backoff; Retry-After beyond it triggers no new dispatch; timeout after possible dispatch is not proof of zero consumption; disabling retry recovery does not end unknown reconciliation. |
| UI-A04 | A defect after first delta causes reset and an authorized new attempt; customer does not pay for a technically defective attempt. |
| UI-A05 | Refused is terminal and does not switch providers; both billing policies account for cost once, unknown usage remains unknown. |
| UI-A06 | Both adapters return exactly one permitted tool call with valid arguments; 0/2 calls and invalid schemas do not execute tools. |
| UI-A07 | Common schema validation, incompatible fallback rejected before reservation, unsupported capabilities not removed. |
| UI-A08 | SDK receives early deltas for one invocation without caller-side scope subscription; artificial authorization delays do not change order. |
| UI-A09 | Unicode/escapes and JSON chunks correctly extract the selected field; lost reset detected from envelope; attempt changes/completion between subscribe and snapshot not lost; old attempts and post-terminal deltas not appended. |
| UI-A10 | preserve leaves byte digest unchanged for JPEG/PNG/WebP including EXIF; transform only explicit; unsuitable files rejected. |
| UI-A11 | Unusual-size originals have a correct estimate or explicit pricing refusal; 1024×1024 rule never silently applied. |
| UI-A12 | One input asset reused repeatedly; 7-day inactivity, renewal, ACK, active holds, project deletion, and cleanup checked for races and owner isolation. |
| UI-A13 | Cache cold/warm/expiry/schema or image changes/fallback yield correct estimates, usage, and category/TTL cost without counting input twice; unknown counters not declared zero. |
| UI-A14 | Balance between warm and cold estimate permits a justified warm call; cold miss and concurrent accepted calls correctly create debt; new calls receive insufficient_credits before dispatch. |
| UI-A15 | Different route-variant rates/markup, defective-attempt costs, and customer charge remain separate; capture/release idempotent. |
| UI-A16 | Wallet events reflect committed capture/release/reserve; missed wakeups recover through outbox polling; stale revisions do not roll back UI. |
| UI-A17 | received → visible content measurement includes p50/p95/p99 and separate components; target of approximately 1 second checked on selected models with available limits. |
| UI-A18 | Network/worker/Redis failure, slow SSE client, revoked access, and deleted content do not cause duplicate dispatch, delta leakage, or lost financial reconciliation. |
| UI-A19 | Embeddings batch preserves order/indices, model, and dimension; malformed/partial batch follows bounded defect path. |
| UI-A20 | Embeddings usage and charge correspond to the batch; repeated retrieval/ACK creates no new provider call or capture. |

## 8. Checks and evidence

Run unit/contract tests for affected modules, then related integration tests in a separate database. Run the full suite after assembling the complete scenario. Missing DATABASE_URL and skipped financial tests do not count as integration acceptance.

Main commands from the current repository:

```sh
pnpm typecheck
pnpm check:api
pnpm check:configuration
pnpm check:paid-api
REQUIRE_INTEGRATION_TESTS=1 pnpm test
pnpm docs:check
pnpm build
git diff --check
```

Before these commands, prepare isolated PostgreSQL/Redis/blob storage under LOCAL_RUN and migrate a separate test database. Do not run the integration suite against the running demo. For DTO changes, run appropriate generate commands before check. Distinguish document checks from runtime verification.

Use Aside for streaming and admin: first words, attempt replacement, final-object retrieval, cancellation, reconnect, wallet warning, and no access after revocation. Use test transport with real local PostgreSQL/Redis for financial/queue races, without external paid calls.

The acceptance report must link UI-Axx to performed tests/measurements, identify fixtures versus real providers, and retain only anonymized technical data. The original audit's historical 49 unit tests do not prove new-feature readiness.

## 9. Remaining clarifications before the relevant phase

- The owner confirmed refused=`platform` default on 2026-09-25; the option to select actual_usage remains.
- In I03/I05, check current protocols, supported schemas, image tokenization, and cache counters for specific models from both providers. Do not invent model names, prices, or exact limits from old fixtures.
- In I06, specify measured load profile and interpretation of the target of approximately 1 second; show provider contribution separately. This does not automatically change deadline=300 or max_attempts=4.
- In I08, select an embeddings model and confirm proposed batch atomicity. This choice does not delay text phases.

These points do not require revisiting UAI/LogoPanel boundaries, product-configuration source, attempt count, lack of backward compatibility, or resize ownership.

## Local implementation 2026-09-25

UI-I00–UI-I08 are implemented; historical results and limitations are consolidated in the [acceptance matrix](ACCEPTANCE_RESULTS.md). The local implementation's first embeddings contract is OpenAI text-embedding-3-small with atomic delivery. The [integration guide](UNIVERSAL_INVOCATION_INTEGRATION.md) describes SDK, identity, result/settlement, input assets, and wallet subscription. LogoPanel updates and paid checks are excluded.
