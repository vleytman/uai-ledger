# Implementation plan for Cerebras, Groq, and Gemini Flash on Google Cloud

Plan date: 2026-09-25. Updated 2026-09-26. Status: AMI-I00–I08 implementation and applicable functional acceptance are complete. Live capabilities of all five models are confirmed, and all financial outcomes are closed. See [integration](ALTERNATIVE_MODEL_INTEGRATION.md) and the [check summary](REAL_PROVIDER_CHECKS.md). Activating operational routes, LogoPanel, and load/quality benchmarks remain separate tasks.

[Contents](README.md) · [Research and comparison](ALTERNATIVE_MODEL_SUPPORT_ASSESSMENT.md) · [Decisions](DECISIONS.md) · [Current acceptance](ACCEPTANCE_RESULTS.md) · [Paid-check rules](REAL_PROVIDER_CHECKS.md) · [LogoPanel follow-up](LOGOPANEL_FOLLOWUP_PLAN.md)

## 1. Scope and evidence status

Add Cerebras and Groq through their direct APIs and Gemini Flash through Google Cloud Standard PayGo. A standard account means a paid Cloud project with billing, the API enabled, and IAM access, without purchasing dedicated capacity. This is not an AI Studio key or a promise of a particular quota for a new account.

Previous checks of these models researched public catalogs and documentation. They did not run real generations. Documented capabilities, local adapter acceptance, and confirmed live calls must have separate statuses.

| Provider | Exact ID | Purpose | Input | Selection status |
|---|---|---|---|---|
| Cerebras | `qwen-3.8-27b` | Primary Qwen for text, image analysis, and tools | Text, images | In current public API |
| Cerebras | `gpt-oss-120b` | Text tasks and reasoning | Text | In current public API |
| Groq | `qwen/qwen3.8-27b` | Cross-provider Qwen comparison | Text, images | Preview; separate experimental profile |
| Groq | `openai/gpt-oss-20b` | Inexpensive data extraction, classification, and tools | Text | Production model in Groq catalog |
| Google Cloud | `gemini-3.8-flash` | Primary Gemini Flash | Text, images | GA; model card explicitly lists Standard PayGo |

Sources reviewed again on 2026-09-25: [Cerebras models](https://api.cerebras.ai/public/v1/models), [Groq models](https://console.groq.com/docs/models), [Gemini Flash on Cloud](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash). Recheck IDs, availability, and rates before implementation and configuration publication. “Latest version” is pinned by verification date and ID; new releases will not replace models automatically.

Include text, vision for supporting models, streaming, structured output, forced tool calling, quoting and actual-cost calculation, queues, and diagnostics. Accept full tool-history transfer as a separate mandatory phase before claiming full support. The application executes tools, not UAI.

Kie, Google Pro, the alternative Developer API, other intermediaries, image generation, embeddings, audio, video, built-in search/code execution, capacity purchasing, and Priority activation are outside this plan. A configuration extension is planned for Priority; its live checks occur later.

## 2. Existing foundation and changes

This snapshot refers to the current working copy with parallel uncommitted changes. Record its state and repeat relevant checks before working; do not overwrite others' changes.

| Already available | Reuse | Add |
|---|---|---|
| Provider registry and HTTP adapters | `packages/providers/src/registry.ts`, `contracts.ts`, `index.ts` | Cerebras, Groq, Google Cloud; shared Chat Completions transport and native Gemini |
| Parameter allowlists | `packages/providers/src/parameters.ts` | Model parameters, ranges, and permitted combinations |
| Schema compiler and LF-I02/LF-I03 forced-tool emulation | `packages/providers/src/structured.ts`, `packages/contracts/schema.ts` | New API specifics; do not write a second common compiler |
| TextInput, ToolChoice, common tool_call | `packages/contracts/invocation.ts` | Currently system/user/assistant roles and text/image blocks; add calls/results history and continuation metadata |
| Model calculations, rate cards, cache forecast | `packages/model-pricing`, `packages/quoting` | New family estimators, usage, and cache; replace estimated_actual OpenAI/Anthropic whitelist with capability checking |
| Queues, admission, execution policy | `packages/queue`, `packages/execution` | New-account quota groups, error classification, metrics |
| API/SDK, admin, file configurations | `apps/api`, `packages/sdk`, `packages/admin-module`, `packages/configuration` | Aligned schemas and five model profiles |

The estimated_actual restriction is confirmed in `packages/quoting/src/index.ts`; “OpenAI text only” wording also appears in the configuration editor. Update both server validation and interface. Schema/tools improvements in the LF contract do not prove new-provider compatibility.

## 3. Phases and dependencies

Original AMI-Ixx statuses were “not started.” Historical results are consolidated in the [acceptance matrix](ACCEPTANCE_RESULTS.md). Sequence: I00 → I01 → I02/I03 → I04 → I05 → I06 → I07 → I08. I02 and I03 have independent transports but use the common I01 contract.

### AMI-I00. Establish baseline and capability matrix

- Check current registry, text input/output contract, execution policy, and LF-I02/LF-I03 results. Record existing baseline failures separately.
- For each model, describe supported tools modes, schema subset, streaming combinations, reasoning, context/output limits, vision MIME/bytes/count, and usage fields.
- Check Gemini Flash availability on global Standard in the target account; obtain quotas from the account. The general Standard table alone does not establish a 3.8 Flash quota.
- Prepare minimal anonymized fixture payloads and responses. Do not save secrets or private provider responses.

Ready when: five cards are complete, unknown capabilities are explicit, and no request promises an unconfirmed combination.

### AMI-I01. Capability and financial-mode contract

Extend capabilities for schema/tools/streaming combinations, native/emulated forced choice, supported output limits, and available counters. A general tools flag does not imply support for every mode.

For Google Cloud, include service mode in the route profile, quote snapshot, and attempt evidence. Only Standard is permitted in this delivery. Do not accept Priority without implementing its transport, rates, and acceptance; do not silently switch to a more expensive mode. Store requested and actual modes separately if the latter is actually reported by the provider.

Generalize estimated_actual through calculation-profile and usage checks while preserving its existing forecast and permitted-debt semantics. Capped profiles require a proven provider-exposure bound; expected_output_tokens is not a limiter. Preserve the separation of provider cost, customer price, and installation risk.

Ready when: unsupported parameters are rejected before dispatch; API/SDK/configuration schemas align. Add storage fields or migrations only when existing mechanisms cannot express the data.

### AMI-I02. Cerebras and Groq

Create a shared Chat Completions transport and separate `cerebras@1` and `groq@1` wrappers. Names are proposed; register them explicitly. URL/auth, parameters, errors, and usage remain wrapper responsibilities rather than those of a single universal “compatible” adapter.

Implement normal and streaming text, fragmented tool-argument assembly by ID/index, terminal usage, and finish reason. Limit application-level tools to current capabilities. Do not enable providers' built-in paid tools.

For vision, check each Qwen's actual wire schema. Groq separately requires verification of published image limits and tokenization. GPT-OSS rejects image input before dispatch. Do not permit Groq schema+tools or schema+stream without confirmation of the supported combination; when buffering, explicitly distinguish the provider stream from UAI's delivery of a completed result.

Ready when: all four models pass local text/stream/tool/schema scenarios and negative checks. Groq Qwen Preview is available only as an explicitly experimental profile rather than a silent replacement for a stable route.

### AMI-I03. Google Cloud Standard and Gemini Flash

Proposed provider ID `google_cloud`, adapter `google_cloud@1`. A connection contains project, location, and a credentials reference. Use the global endpoint for the first connection. Choose a supported OAuth/ADC mechanism for the installation environment; implement refresh and protection against concurrent token refreshes. Do not store credentials in profiles, quote snapshots, or the browser.

Native Gemini transport serializes system instructions, contents/parts, inline images, generation config, function declarations, and response schema. Implement generateContent and streamGenerateContent, parsing candidates, safety/finish reasons, and usageMetadata. Preserve thought signatures as opaque continuation data rather than exposing them as user text.

Explicitly specify a Standard request according to current Cloud documentation; do not depend on an incidental account mode. The owner enables Google billing while preparing the connection; activation is not a side effect of UAI setup.

Ready when: Cloud auth/refresh, text, streaming, vision, schema, tools, and refusal pass local acceptance. Token expiry, 403, 429, incomplete streams, and missing usage have separate outcomes. Refresh after dispatch must not silently repeat generation.

### AMI-I04. Estimation, actual cost, and cache

- Estimate actually serialized messages, tools/schema, images, and expected output; include LF-I02/LF-I03 transformations.
- Do not assign GPT-OSS/Qwen tokenizers solely by developer name. Pin a tokenizer/chat template or a measured approximate estimator with an error margin.
- Check Gemini CountTokens and its terms. Do not make network counting an implicit mandatory step for every quote; provide local estimation and an explicit accuracy status.
- Normalize input/output/reasoning/cache usage per model. Do not add overlapping counters or replace missing values with zeros.
- Publish Cloud rate cards separately from Developer API rates. Each version stores source, checked_at, and conditions. Promotional rates have an end date; without a new rate, stop affected-profile publication/execution rather than extending the promotion automatically.
- Start cache forecasts with cold input. Save observed cache hits in usage; do not create a paid explicit-cache lifecycle in this phase. Cache identity includes connection, model, parameters, and stable prefix.

Ready when: independent fixtures confirm quote, provider cost, charge, refund/reserve, and exact arithmetic. Monetary integers travel as strings. Unknown cost remains unresolved under current rules.

### AMI-I05. Full tool history

Add blocks for assistant tool calls and tool results, stable call IDs, tool errors, and opaque provider metadata. Align TextInput, ProviderResult, delivery events, API/SDK, and result persistence. Preserve the convenient “exactly one” mode for current typed calls; represent multiple calls explicitly.

Validate results against original call IDs, duplicates, orphan results, and each model's support for parallel calls. Bind continuation metadata to provider/model; fallback must not forward another provider's signature. Reject fallback when history cannot transfer safely. The application executes the tool and calls UAI again; do not add a general autonomous agent loop.

Ready when: a two-step call → result → answer exchange passes for each model in a supported mode; unsupported parallelism is rejected. Before this phase, support may be claimed for a single forced call, but not a full tool dialogue.

### AMI-I06. Queue, diagnostics, and financial safety

Connect new account/model quota profiles and concurrent-stream limits. Additional keys on one account are not independent quotas. For Cloud, account for organization/model scope wherever the actual limit uses it. Apply available Retry-After headers in admission without duplicate charging.

Preserve maximum attempts/deadline across all routes. Disable SDK retries or include them in the observable policy; do not multiply them by queue retries. Distinguish auth, quota, transient failure, safety refusal, invalid request, defect, and outcome_unknown. No automatic new generation after an unknown paid outcome.

Metrics: TTFT, total time, queue wait, active requests, 429/5xx, safety refusals, invalid schema/tools, terminal-usage rate, forecast/actual. Reconcile against external reports only when a suitable API exists; do not describe local usage-based calculation as reconciliation against a provider invoice.

Ready when: fault injection creates no duplicate attempts/postings and correctly releases or retains reservations. Fallback between vision and text-only routes is forbidden.

### AMI-I07. Configurations, API/SDK, admin, and local acceptance

Prepare five file bundles: model/capabilities, rate card, route, and invocation profile, without keys or automatic publication to an operational database. Choose specific paths according to current FILE_CONFIGURATION rules; bind user connections separately.

In admin, show provider, model ID, Standard mode, preview, live-validation status, quotas, and unknown usage. Remove the editor's obsolete “OpenAI only” wording restriction. The demo must allow text, vision, and tools according to capabilities without offering unavailable combinations.

Update generated OpenAPI/SDK/configuration schemas and documentation. Run targeted provider, quoting, execution, queue, and API/SDK tests, then typecheck, schema checks, and docs checks. For changed UI, build and check rendered elements/errors in a browser. Separate existing failing baseline tests from new regressions.

Ready when: the local AMI-Axx matrix passes, financial checks are green, and admin contains no false “live verified” status.

### AMI-I08. Limited live run and enablement

Prepare a manifest with exact models, scenarios, call counts, input/output/thinking limits, and calculated maximum cost. Initial smoke: four requests per model — text, stream, forced tool, schema; one additional vision request for each of the three vision models; two calls per tool round-trip sequence for each of five models. Total **33 calls** if all combinations are confirmed; exclude unsupported scenarios with explanations. Budget a larger quality/load check separately.

Calculate budget using current published rates and actual manifest bounds rather than one expected response. Prepare the complete locally verified runner and reviewable manifest before requesting authorization. Authorization is required only before the paid run under the [real-check rules](REAL_PROVIDER_CHECKS.md); this planning task does not provide it.

Use dedicated test processes, a five-model allowlist, max_attempts=1, and stop-on-unknown. Do not provoke widespread errors through paid requests. After smoke, compare Russian-language task quality and load separately, keeping functional results, cost, and reliability distinct. Smoke does not confirm an SLA.

Ready when: a report records configuration versions, anonymized operation IDs, usage, cost, each scenario's status, and limitations. After the run, real flags are disabled and disputed reservations resolved. Activating operational routes and updating external LogoPanel occur in a separate delivery; this plan does not start them.

## 4. Acceptance matrix

New AMI-Axx IDs do not replace stable research AMS-Axx and current-plan LF-Axx IDs.

| ID | Scenario | Criterion |
|---|---|---|
| AMI-A01 | Registration and parameters | Five IDs; unknown ID/parameter and forbidden mode rejected before dispatch |
| AMI-A02 | Text/stream | Correct finish reason, SSE tail, and terminal usage; refusal does not become success |
| AMI-A03 | Vision | Qwen and Gemini receive correct assets; GPT-OSS rejects images |
| AMI-A04 | Schema | Original schema and reconstructed response valid; unsupported combinations rejected |
| AMI-A05 | Forced tools | Exactly one required/named result; native/schema method specified; refusal preserved |
| AMI-A06 | Tool history | Call IDs, results, and signatures survive round-trip; parallel only according to capabilities |
| AMI-A07 | Estimator | Includes tools/images/framing; accuracy not overstated; output forecast not declared a cap |
| AMI-A08 | Usage/pricing | Reasoning/cache not duplicated; promotional date, model, and mode select correct rate |
| AMI-A09 | Financial invariants | No duplicate charge; defect/refused/cancel/unknown follow current decisions |
| AMI-A10 | Cloud auth | Concurrent-safe refresh; credentials do not enter API content or logs |
| AMI-A11 | Quotas and retries | Shared account limits, 429/backoff, deadline, cancellation, and unknown cannot be bypassed by fallback |
| AMI-A12 | API/SDK/admin | Aligned schemas, correct preview/live-validation status, working demo |
| AMI-A13 | Live smoke | Authorized connections/budget only; report confirms every live result |
| AMI-A14 | Priority preparation | Standard remains default; Priority cannot enable without a separately accepted profile and rate |

## 5. Estimate and delivery order

| Package | Estimate |
|---|---:|
| I00–I01: baseline, capabilities, financial terms | 2–3 days |
| I02: Chat transport, Cerebras and Groq | 3–5 days |
| I03: Google Cloud auth and native Gemini | 3–5 days |
| I04: estimation, usage, rates, and cache | 2–3 days |
| I05: full tool history | 3–5 days |
| I06–I07: queues, profiles, API/SDK/admin, integration acceptance | 3–4 days |
| I08: agreed smoke execution and report | 1–2 days |

Total **17–27 engineering days**. This is a new estimate specifically for five models from three providers, with full tool history and without Kie. Waiting for access/budget, unknown provider restrictions, fixes following the live run, and a lengthy load/quality benchmark may extend the schedule. Do not reimplement accepted parallel LF work.

Complete local delivery I00–I07 first. If an early result is needed, a single forced tool call may be demonstrated after I04 with an explicit statement that full history is absent until I05. Full readiness requires applicable AMI-Axx completion rather than merely one text response.

## 6. Document and future-implementation checks

These commands exist in the root package.json: `pnpm typecheck`, `pnpm test`, `pnpm check:api`, `pnpm check:configuration`, `pnpm docs:check`, `pnpm build`. Select targeted tests according to affected files. Local fixtures do not confirm live APIs.

For rollback, disable new routes for new calls, preserve versions for already accepted quotes/attempts, and bring them to permitted outcomes. Do not roll back the ledger or accepted-operation configuration by restoring an old database. This task creates no branch, PR, publication, or deployment.
