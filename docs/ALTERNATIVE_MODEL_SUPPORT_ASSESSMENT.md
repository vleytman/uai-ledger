# Alternative-model and Google Gemini support

Verification date: September 25, 2026. Status: research with Google Cloud Standard PayGo selected as the first phase; other options remain proposals. This is not a provider-readiness report.

[Implementation plan for the five selected models](ALTERNATIVE_MODEL_IMPLEMENTATION_PLAN.md) · [Documentation contents](README.md) · [Decisions](DECISIONS.md) · [Universal invocations](UNIVERSAL_INVOCATION_PLAN.md) · [LogoPanel improvements](LOGOPANEL_FOLLOWUP_PLAN.md) · [Real-check rules](REAL_PROVIDER_CHECKS.md)

## 1. Conclusion and boundaries

**Owner's selection of 2026-09-25:** prepare **Google Cloud Standard PayGo** support for Gemini first, allowing later addition of **Cloud Priority PayGo**. Standard is already pay-as-you-go; subsequent PayGo in this decision means Priority. The present task records requirements; implementation and paid-route activation have not been requested. Section 13 describes the first phase.

UAI can extend its existing architecture to Cerebras, Groq, Kie.ai, and Google Cloud. Shared queues, attempt accounting, reservations, rate versions, and result delivery remain intact. New adapters/configurations, refined model capabilities, input estimators, and separate intermediary-cost handling are required.

“Images” in the main scope means image analysis by a language model. Image generation/editing, embeddings, video, realtime, audio, and execution of providers' built-in paid tools are outside this scope.

This research ran no paid generations and changed no connections, database rates, or operational routes. Implementation state was checked against the current working copy, including uncommitted changes. Production configuration and active database models were not checked.

## 2. What counts as confirmed

- **Present in code**: the mechanism was found in the working copy. This does not mean every combination has passed acceptance.
- **Provider-declared**: official API, documentation, or public catalog describes the capability.
- **Needs verification**: exact specification is absent or real responses have not been checked.
- **Proposed**: this research's technical solution; it does not change agreed project decisions.

Provider documents may disagree. For example, Cerebras' current public API lists Qwen 3.8 27B and GPT-OSS 120B, whereas an older overview lists different models. Selection prioritizes the current API. Catalog presence does not confirm availability on a specific account.

The previous answer mostly described JSON Schema transformation and forced-tool-choice emulation as upcoming work. During reinspection, `providerSchema`, `structuredTransport`, and `forced_tool_choice` had appeared in the working copy. They are treated below as existing code without separate acceptance in this research.

## 3. Unified model and route table

Table prices: USD per 1 million input / output tokens for ordinary uncached text requests. These are published rates rather than UAI customer prices. Long context, service tier, region, and additional services may have different rates. “Tools / schema” indicates separate capabilities, not guaranteed combination with streaming.

Shared-work notation: **A** — transport and adapter; **B** — capabilities and parameters; **C** — calculation, usage, and cache; **D** — full tool history; **E** — limits, errors, and reconciliation. Details follow.

| Access provider | Model / exact ID | Input → output; context | Tools / schema / streaming | Input / output price | Already in UAI | Missing / limitations | Role |
|---|---|---|---|---|---|---|---|
| Direct OpenAI | `gpt-5.6-sol`, `gpt-5.6-terra` | Text and images → text; UAI profile limit separate | Responses, tools, schema, SSE implemented | Baseline route here; obtain rates from published configuration | Adapter and demo-model definitions | Common tool-history limitations; specific published profiles may expose fewer capabilities than the adapter | Existing comparison baseline |
| Direct Anthropic | Claude families allowed by configuration | Text and images → text | Adapter exists; some models already provide tool emulation | Not reassessed in this research | Messages, usage, images, schema/tools | New uncommitted changes need acceptance; do not claim all Claude models verified | Existing comparison baseline |
| Cerebras | `qwen-3.8-27b` | Text, images → text; 65,536 | Tools, schema, streaming declared | 0.99 / 1.49 | Common contracts and accounting | A/B/C/E; Qwen tokenizer, exact image accounting, combination checks; D for tool dialogue | Primary Qwen candidate |
| Cerebras | `gpt-oss-120b` | Text → text; 131,072 | Tools, schema, streaming; catalog parallel tools=false | 0.35 / 0.75 | Common contracts and accounting | A/B/C/E; no image input; D if needed | Inexpensive text reasoning |
| Groq | `qwen/qwen3.8-27b` | Text, images → text; 131,072 | Tools, schema, streaming individually | 0.80 / 4.00 | Common contracts and accounting | A/B/C/E; Preview; up to 3 images; documentation says schema incompatible with tools/streaming | Alternative Qwen with larger context |
| Groq | `openai/gpt-oss-20b` | Text → text; 131,072 | Tools, strict schema, streaming individually | 0.075 / 0.30 | Common contracts and accounting | A/B/C/E; no vision; schema-combination restrictions; D if needed | Cheap functions, extraction, classification |
| Kie.ai | `kimi-k3` | Text, images → text; claimed 1M | Functions, JSON Schema, SSE | Kie rate unconfirmed | Common Responses code reusable | A/B/C/E; `auto` and named documented, general `required` undeclared; credits cost; check output bound | Priority Kimi candidate |
| Kie.ai | `deepseek-v4-1-flash` | Text, images → text; verify exact limit | Functions, JSON, SSE | Kie rate unconfirmed | Common Responses code reusable | A/B/C/E; `max_output_tokens` ignored; cannot promise a hard ceiling through this parameter | Economical-route candidate after verification |
| Kie.ai | Gemini 3.8 Flash, endpoint `/gemini-3-8-flash-openai/v1/chat/completions` | Text, images → text; verify route limits | Streaming declared; functions example exists; schema needs checking | Native: 0.225 / 1.125 through 2026-12-31; verify compatible variant | Common contracts | A/B/C/D/E; conflicting response forms; preserve continuation metadata; do not invent model ID from endpoint name | Economical Gemini after acceptance |
| Kie.ai | Gemini 3.1 Pro; UI ID `gemini-3.1-pro-openai` | Text and images → text; verify route limit | Check tools/schema/stream against specific API | 0.50 / 3.50 | Common contracts | A/B/C/D/E; long context, billing, and errors not accepted | Fourth Kie model |
| Direct Google | `gemini-3.8-flash`, Standard / Priority | Text and images → text | Gemini capabilities need new adapter; Priority via Interactions | 0.75 / 3.75; Priority 1.35 / 6.75, 2026 promotion | Common contracts and accounting | A/B/C/D/E; native transport, metadata; tier-specific rates | Primary candidate without intermediary |
| Direct Google | `gemini-3.1-pro-preview` | Text and images → text | Tools/schema/stream by profile | 2.00 / 12.00; >200k: 4.00 / 18.00 | Common contracts | A/B/C/D/E; preview, native transport, quotas | Direct Pro |
| Google Cloud | Gemini Flash/Pro, Standard / Priority / Provisioned | Specific to model and location | Native Gemini API, Cloud auth | Separate Cloud rate card; do not copy Developer API | Common contracts | A/B/C/D/E; OAuth/IAM, global routing, capacity, service tier | Standard selected first; Priority planned later |
| OpenRouter | `google/gemini-3.8-flash` | Text and images → text | Check combinations on selected upstream | 0.75 / 3.75; top-up terms separate | Shared compatible-transport foundation | A/B/C/D/E; upstream and own balance | Alternative intermediary |

Table sources: [Cerebras public models](https://api.cerebras.ai/public/v1/models), [Groq models](https://console.groq.com/docs/models), [Groq Qwen](https://console.groq.com/docs/model/qwen/qwen3.8-27b), [Groq GPT-OSS 20B](https://console.groq.com/docs/model/openai/gpt-oss-20b), [Kie Kimi](https://docs.kie.ai/market/kimi/kimi-k3), [Kie DeepSeek](https://docs.kie.ai/market/deepseek-v4-1-flash), [Kie Gemini](https://docs.kie.ai/market/gemini/gemini-3-8-flash-openai).

Gemini Pro/Flash are preliminary interpretations of the request. No Google/Gemini definitions were found in inspected UAI configurations; this does not disprove their use by an external application. Exact Gemini versions used by the application were not established when writing. Do not present proposed versions as an existing production set.

No text Qwen was found in the inspected Kie index. Qwen entries in Image Models generate/edit images. They do not replace Qwen with function calling. Adding Gemini Pro selected four Kie models within the requested range. GPT-OSS was developed by OpenAI; it provides independence from the direct OpenAI API, but not the OpenAI model family.

## 4. UAI inventory

| Mechanism | Current state | Required change |
|---|---|---|
| ProviderAdapter / HttpAdapter | Execution, usage, error classification, limits, streaming, and native-job interface exists | New implementations; do not substitute result lookup for expanded financial reconciliation |
| Provider registry | OpenAI, Anthropic, Voyage, Cartesia, Serper, Firecrawl, fake | Register Cerebras, Groq, Kie, Google Cloud; separate adapter_ref versions |
| HTTP protocols | OpenAI uses Responses with hardcoded URL; Anthropic Messages | Extract shared Responses transport; add Chat Completions and native Gemini transports |
| Model and connection | Catalog, connections, route versions, rate cards exist | Separate intermediary and upstream; store requested and actual model, revision only with evidence |
| Tools | required/named, exactly one tool_call; system/user/assistant roles | Permitted-mode table; tool_result and call history for full dialogue |
| JSON Schema | Working copy has schema transformation, reconstruction, and validation | Check each route's subset; shared compiler does not make all models compatible |
| Tool emulation | structuredTransport and execution_method in new changes | Use according to capabilities; check transformed-input estimates and refusals |
| Image input | Asset ID, message position, preparation, format validation exist | New serializers, count/byte/resolution limits, model estimators |
| Streaming | Provider SSE and UAI events exist; transformed schemas may buffer | Chat deltas, tool-call index/ID, terminal usage, continuation metadata; common result semantics |
| Forecast and calculation | Model formulas, rate cards, reserve/settlement, cache exist | Remove estimated_actual OpenAI/Anthropic whitelist; preserve financial policy |
| Tokenizer | o200k_base, cl100k_base, utf8_upper_bound | Family tokenizers/chat templates or explicitly approximate estimates |
| Errors and retries | FailureKind, sent/safe_to_retry, outcome_unknown, deadlines | Parse new-API errors; preserve post-dispatch retry restrictions |
| Quotas | Shared queue and admission exist | Model/account limits; do not transfer OpenAI tier templates to other providers |
| Cost reconciliation | Reconciliation module; OpenAI/Anthropic administrative-report import | Separate collectors for new providers where documented APIs exist |
| API/SDK/admin | Common invocation and catalogs exist | New capabilities, provenance, billing source, unknown fields, parameters, precise UI labels |

Files checked: [registry](../packages/providers/src/registry.ts), [contracts](../packages/providers/src/contracts.ts), [HTTP adapters](../packages/providers/src/index.ts), [parameters](../packages/providers/src/parameters.ts), [text input](../packages/providers/src/text-input.ts), [structured transport](../packages/providers/src/structured.ts), [invocation](../packages/contracts/invocation.ts), [schema](../packages/contracts/schema.ts), [catalog](../packages/catalog/src/index.ts), [quoting](../packages/quoting/src/index.ts), [cache](../packages/quoting/src/cache.ts), [tokenization](../packages/model-pricing/src/tokenization.ts), [runtime](../packages/execution/src/default-runtime.ts), [reports](../packages/reconciliation/src/reports.ts), [demo models](../packages/model-pricing/src/demo-models.ts).

## 5. Shared changes A–E

### A. Transport and adapters

Propose shared Responses and Chat Completions handlers with independent provider wrappers. The shared layer serializes messages and parses protocols; wrappers determine endpoints, auth, parameters, and error/limit/usage specifics. Do not create one unconditional “OpenAI-compatible” adapter promising identical semantics for every provider.

The baseline for Cerebras/Groq is Chat Completions. For Kie Kimi/DeepSeek, use `/openai/v1/responses`. Kie Gemini uses its own compatible Chat Completions path. Google Cloud needs native Gemini transport. Do not use transport changes as automatic retries after unknown outcomes.

Parameters must not pass through an uncontrolled generic spread. Each route needs permitted fields, enums, required values, and an output-limit policy. Unsupported parameters must error before dispatch rather than being silently ignored.

### B. Model capabilities

Instead of only tools/schema flags, describe:

- Native/emulated forced tool choice; auto, none, required, named.
- One or multiple calls, parallel calls, whether text alongside calls is allowed.
- JSON object or JSON Schema mode, strict, supported keywords, tools/streaming combinations.
- Image formats and bounds, allowed message roles, detail handling.
- Reasoning controls, budget/effort, continuation metadata availability.
- Context, maximum output, and whether the output limit is actually enforceable.
- Cache, available usage counters, cost-reconciliation capability.
- Preview status, alias/snapshot, verification date.

Checks apply to every permitted route variant. A fallback text-only route must not accept image requests. Tool-choice emulation is allowed under agreed LF-D07 with execution method recorded. It does not imply arbitrary-schema support or override refused.

### C. Estimation and calculation

Estimate the representation actually sent: instructions, messages, tools, transformed JSON Schema, images, and expected output. `JSON.stringify(input)` plus universal overhead is not an exact tokenizer for a specific provider. Pay particular attention to differences between original and compiled schemas when reserving funds.

Qwen/Kimi/Gemini need exact counters where available and API-compatible, or measured estimators with stated error margins. `utf8_upper_bound` may provide a cautious text estimate, but proves no bound for image cost or hidden framing. Return forecast source, version, assumptions, and confidence.

Publish model prices as immutable versions. Include uncached input, cache read/write where available, output, reasoning, and separate paid actions. Do not add reasoning twice if provider completion/output tokens already include it. Do not turn a missing counter into zero.

Groq Qwen documents 2048 input tokens per image and up to three images. This rule is unproven for Cerebras. Kie image accounting needs separate confirmation. Do not transfer OpenAI image-token formulas to Gemini even with compatible request formatting. [Groq Qwen](https://console.groq.com/docs/model/qwen/qwen3.8-27b).

Current `inputTokens` limits serialized input to 2 MB. Before promising 1M context, check the whole chain: HTTP body, assets, message schemas, storage, quoting, queue, timeouts, SDK. A provider's maximum window does not automatically become UAI's limit.

Permit `estimated_actual` according to published capabilities and policy rather than provider name. Forecast reservation, user-consent maximum, enforceable provider limit, and installation risk are distinct quantities. For Kie DeepSeek, where `max_output_tokens` has no effect, a mode requiring that parameter as a bound is invalid. An explicitly suitable financial policy is required; do not merely remove validation and claim capped billing.

### D. Full tool dialogue

The existing “exactly one function call” mode remains useful for typed results. Full history requires tool-call/result blocks, stable call IDs, tool-error support, and multiple calls wherever permitted.

Tool execution remains in the application under the current decision. UAI transfers history and accounts for each model call. An autonomous agent loop is excluded. A shared dynamic-chain reservation was later implemented as a [reserve pool](QUOTING.md#reservation-for-compound-work): each model call remains a separate request.

For Gemini, preserve provider-returned continuation data, such as thought signatures, when required by the selected protocol. Do not reconstruct signatures from text or send one provider's internal data to another. Verify that each Gemini route's transport preserves these data. Otherwise restrict support accordingly or use another documented transport.

### E. Execution, limits, and acceptance

For each adapter, define auth/quota/invalid/transient/refused/defect/unknown. A post-dispatch timeout does not prove absence of costs. HTTP 200 does not guarantee success either: check error bodies and terminal events. Do not automatically retry unknown paid outcomes.

SSE must parse argument fragments, text, and control events separately. Disconnection after text delivery, missing final usage, and disconnection after a tool call are separate cases. Do not execute tools from incomplete streamed JSON. Save generation ID as early as possible, before the final response.

Set request, token, and concurrency limits at available account/connection/model scope. For unknown limits, use an explicitly selected conservative mode rather than copying OpenAI Tier 4. Retry-After and limit-header observations must update admission without another financial charge.

## 6. Kie.ai specifics

Kimi and DeepSeek have Responses-like interfaces; shared transport is reusable, but parameters and billing differ. Kimi documents auto and named function choice. General required is undeclared. For one tool, named can be used; selection among several can use agreed schema emulation after confirming schema support. Kimi's built-in web_search is unsupported and, according to documentation, ignored; UAI must reject such a request if it promises that capability. [Kimi API](https://docs.kie.ai/market/kimi/kimi-k3).

DeepSeek does not support `max_output_tokens`, `temperature`, or `top_p`. Reasoning is on by default, so forecasting a response without it may underestimate cost. [DeepSeek API](https://docs.kie.ai/market/deepseek-v4-1-flash).

Kie Gemini's schema describes Chat Completions, while its response example shows Gemini `candidates`, `usageMetadata`, and `thoughtSignature`. This is a documentation contradiction. Before live verification, status must be “candidate,” and the parser must follow a confirmed contract. Do not treat all forms as interchangeable or claim full schema support from a marketing page. [Gemini API](https://docs.kie.ai/market/gemini/gemini-3-8-flash-openai).

Store `credits_consumed` separately from tokens, USD, and UAI customer credits. Confirmed Kie prices, provider-credit conversion, and rounding semantics are needed. A decrease in total balance is not an exact single-request cost during concurrent work. Gemini card rates are confirmed in section 11; Kimi/DeepSeek remain open. Each route's financial acceptance requires usage, rate, and actual-charge checks even if the technical call works.

## 7. File changes and compatibility with the current plan

| Area | Proposed work | Overlap with existing work |
|---|---|---|
| `packages/providers/src` | Shared Responses/Chat and native Gemini transports; Cerebras/Groq/Kie/Google Cloud wrappers; usage/errors/limits; vision mapper | Do not overwrite current OpenAI/Anthropic/structured changes |
| `packages/contracts` | Capability combinations; provenance; tool history and continuation metadata if extended scope accepted | Reuse existing schema transformations and execution_method |
| `packages/catalog` | New adapter_ref and parameter validation, capabilities, pricing readiness | Same version-publication process |
| `packages/model-pricing` | Tokenizers/estimators, vision accounting, pricing thresholds, reasoning | Do not duplicate LF-I05 batch estimates |
| `packages/quoting` | Capabilities instead of provider whitelist; actual-transport estimation; every fallback checked | Preserve reservations and separate customer pricing |
| `packages/execution` | Metadata transfer, early generation ID, aligned deadlines/retries | Do not add tool executor; shared chain reservation resides in quoting (reserve pool) |
| `packages/queue` | New quota profiles, header feedback, provider-account grouping | Interactive/background priorities remain separate LF-I04 work |
| `packages/reconciliation` | Usage/cost normalization, Kie credits; collectors where APIs exist | Do not treat existing report importers as universal |
| `apps/api`, SDK, admin/demo | Capabilities, new results/parameters, cost-source display | Update contracts together without compatibility-only legacy modes |
| `configurations/ai`, documentation, tests | Model, rate, route/profile versions; sources and verification dates | Do not change live settings during research |

Before the joint UAI/LogoPanel launch, backward compatibility is unnecessary. API, SDK, and configurations may change together. Financial invariants and safety of already accepted operations remain mandatory. A legacy file's presence does not justify new compatibility branches.

## 8. Acceptance

Statuses below remain “not completed for new routes.” Repeat every positive check separately for each model and transport; unsupported combinations must have a negative predispatch test.

| Research ID | Check | Readiness evidence |
|---|---|---|
| AMS-A01 | Catalog, adapter_ref, auth, model ID | Permitted request succeeds; unknown model/parameter rejected before payment |
| AMS-A02 | Text and SSE | Full and streamed results align; terminal event and finish reason parsed |
| AMS-A03 | Vision | One/multiple assets at correct positions; format, size, count, text-only refusal checked |
| AMS-A04 | Native tools | required/named/auto checked only where declared; arguments and names validated |
| AMS-A05 | Tool emulation | Exactly one result, execution_method, correct optional/null reconstruction and refusals |
| AMS-A06 | Tool history | Tool response returns with call ID; parallel results not confused; metadata preserved |
| AMS-A07 | JSON Schema | Subset and tools/streaming combinations defined; invalid output not declared success |
| AMS-A08 | Estimation | Includes tools/schema/images/reasoning; assumptions and error margins shown; no hidden truncation |
| AMS-A09 | Usage and cost | Cache/output/reasoning not duplicated; unknown does not become zero; correct rate version applied |
| AMS-A10 | Overrun/cancellation/disconnection | Checked before dispatch, after dispatch, after partial output; no unjustified free retry |
| AMS-A11 | Idempotency | Repeated command, event, or lookup creates no new paid attempt or posting |
| AMS-A12 | Fallback | Every branch preserves tools, schema, vision, financial and policy constraints |
| AMS-A16 | Pricing boundaries | Before/at/after threshold; cold/cache; service tier and region; exact monetary arithmetic |
| AMS-A18 | API/SDK/admin | Actual support status visible; no promise of full tool loop or exact estimation without evidence |

Prepare real checks as a separate set with an explicit maximum budget. Until all Kie rates and exact scenarios are known, no numerical total live-run budget can be published. Local mocks do not confirm provider billing or model quality.

For quality assessment, use the same Russian-language application tasks: schema extraction, function selection, short classification, complex reasoning, interface/logo analysis, multistep history with tool results. Compare cost per successful task, valid-response, retry, and refusal rates, TTFT, and total latency. Do not rank models solely by marketing benchmark scores or token price.

## 9. Sequence and effort estimate

1. Capture the current parallel-work baseline; pin exact Gemini IDs and financial modes. Reuse existing schema/tools improvements after verifying them.
2. Implement shared transport/capabilities/pricing. Remove estimated_actual coupling to two provider names without weakening policy.
3. For Gemini, prepare Google Cloud Standard PayGo first under section 13.
4. Connect Cerebras and Groq, starting with Qwen and inexpensive GPT-OSS. Verify vision and schema combinations.
5. Connect Kie Kimi/DeepSeek after confirming rates and output-limit policy; connect Kie Gemini after clarifying the wire contract.
6. Separately accept expanded tool history if included in the selected delivery scope.

| Package | Engineering estimate | Result |
|---|---|---|
| Shared transports, capability matrix, generalized calculation | 4–6 working days | Reusable foundation for all four providers |
| Cerebras + Groq | 3–5 days | Two models each with limitations and local acceptance |
| Kie, four models | 4–6 days | Adapters, credit accounting, confirmed modes |
| Google Cloud Standard including auth/routing | 4–7 days | Native Gemini, Cloud connection, profiles prepared for Priority |
| Overall integration acceptance, SDK/admin/docs | 3–5 days | End-to-end scenarios and prepared live run |
| Extended history and parallel tools | Additional 3–5 days | Full tool calls/results exchange; application retains executor |

Main-scope estimate: **18–29 working days**; with extended tool history: **21–34 days**. The total covers the common foundation, Cerebras/Groq, four Kie models, Google Cloud Standard, and integration acceptance. This is preliminary rather than a calendar commitment. Actual Priority connection, the alternative Developer API, and OpenRouter are excluded. Access, provider responses, and paid acceptance may add waiting. Already completed and accepted LF-I02/LF-I03 work reduces the total and must not be counted twice.

## 10. Remaining facts to establish before implementation

- Exact Gemini IDs in the external application and selected-model availability on Google Cloud.
- Kimi/DeepSeek rates and Kie provider-credit rules; Gemini rates are clarified in section 11, but availability and billing require acceptance.
- Whether full tool dialogue is required now or the agreed “exactly one” mode suffices.
- Permitted preview models, debt/risk under estimated_actual, installation limits, and a separate live-check budget.

This document approves no new settings. The next concrete implementation result is an agreed route set and AMS-Axx criteria accounting for current parallel work.

## 11. Gemini access options: speed, quotas, and cost

Supplement dated 2026-09-25. Key.ai means Kie.ai from the original request. Official Google/OpenRouter documents and Kie's catalog UI were checked; no paid requests were made. Speed and error rates under application load were not measured. An account page in a browser was not treated as evidence of a specific account's quotas.

### 11.1. What “fast access” means

Distinguish time to first token, generation speed, total throughput, and capacity availability. AI Studio tiers control quotas; a low tier does not imply deliberately slow generation of each answer. Long thinking and queueing may increase waiting even with sufficient RPM.

Direct Gemini API Tier 1 usually activates immediately after billing linkage. Currently Tier 2 requires $100 paid and 3 days since the first successful payment; Tier 3 requires $1000 and 30 days. Spending on the linked Google Cloud billing account counts. Check specific RPM/TPM/RPD in AI Studio: they depend on model and account. Quotas are project-bound; extra keys do not multiply them. Increases may be requested without approval guarantees. [Google: rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

Therefore, first check the actual paid tier of the existing billing account. Assuming “a new key necessarily has minimum quota” may be wrong. Public tables do not replace account-specific available values.

### 11.2. Connection-method comparison

| Connection | Getting started / obtaining speed | Limits and constraints | Additional intermediary and accounting | UAI additions |
|---|---|---|---|---|
| Gemini Developer API Standard | API key, billing; minimal settings | Project/model quotas, shared pool, possible 429 | None; Google billing and our accounting only | Native Gemini adapter, usage, images, tools/schema, pricing |
| Gemini Developer API Priority | Interactions API with `service_tier: priority`; preview | Own quota defaults to 0.3 of Standard; total traffic also counts; does not remove Tier 1 restrictions | None; higher Google rate | Separate Interactions transport, actual served tier, downgrade rules |
| Google Cloud Vertex / Gemini Enterprise Agent Platform Standard PayGo | Cloud project, IAM, global endpoint | Shared pool; baseline depends on usage tier; overage and bursts best effort | None; Google Cloud billing, more complex setup | Cloud auth/refresh, project/location, native adapter, global quotas |
| Google Cloud Priority PayGo | Prioritized request class without fixed-capacity purchase | Shared capacity, model/location availability; no guaranteed dedicated capacity | None; separate Google rates | Priority headers, tier pricing, actual served-class accounting |
| Google Cloud Provisioned Throughput | Order capacity for a selected model | Predictable dedicated throughput; commitments/availability depend on order | No gateway; fixed capacity cost appears | Capacity/overage accounting, separate fixed-cost allocation |
| OpenRouter | Add funds, select Gemini; AI Studio/Vertex providers | No general platform request cap for paid models, but upstream 429, safeguards, and in-flight spending budget remain | Own balance and routing | OpenRouter wrapper, costs/route, usage, errors; separate intermediary integration |
| Kie.ai | Key and credits, separate Gemini endpoints | Public chat-specific RPM/TPM/concurrency unconfirmed | Own credits; intermediary accounting cannot be eliminated | Kie wrapper, credits/usage, tools/continuation, reconciliation and load acceptance |

Developer API Priority documentation shows Interactions API rather than merely adding a parameter to existing GenerateContent. Insufficient Priority capacity may downgrade to Standard at the corresponding price; actual class is identified by `x-gemini-service-tier`. Thus Priority addresses latency but does not guarantee greater volume. [Priority inference](https://ai.google.dev/gemini-api/docs/priority-inference).

Google Cloud Standard PayGo publishes Tier 1 for organization eligible spend of $10–250 over the past 30 days: baseline Pro 500k TPM, Flash/Flash-Lite 2M TPM. This is not a guaranteed limit for a completely new account without spending. Furthermore, that page's supported-model list omits 3.8 Flash and excludes preview: do not transfer these numbers to the newest models without checking. The global endpoint is recommended for access to the shared pool. [Standard PayGo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/standard-paygo).

Unlike that page, the Priority PayGo list already includes 3.8 Flash and 3.1 Pro Preview. It supports global and US/EU multiregion rather than individual regional endpoints; it provides header `X-Vertex-AI-LLM-Shared-Request-Type: priority`. Determining “what volume is available immediately” requires confirmation for the specific model and Cloud account. [Priority PayGo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo). Dedicated capacity is purchased separately through [Provisioned Throughput](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/purchase-provisioned-throughput).

OpenRouter may be simpler than a new Cloud project, but does not meet the wish to remove intermediaries: balance, upstream routing, and financial reconciliation remain. “No platform limit” does not mean “no 429.” Passing your Google key through any BYOK proxy does not itself remove Google's original quotas. [OpenRouter limits](https://openrouter.ai/docs/api/reference/limits).

### 11.3. Confirmed Gemini prices

USD per million tokens, input / output, excluding cache, paid search, taxes, and top-up bonuses. Long context and special modes require separate rates.

| Route | Model | Input | Output | Conditions |
|---|---|---:|---:|---|
| Google Developer API Standard | Gemini 3.8 Flash | 0.75 | 3.75 | Promotional rate through 2026-12-31; published 1.50 / 7.50 from 2027-01-01 |
| Google Developer API Priority | Gemini 3.8 Flash | 1.35 | 6.75 | Promotional rate; +80% over current Standard; after promotion 2.70 / 13.50 |
| Google Developer API Standard | Gemini 3.1 Pro Preview | 2.00 | 12.00 | Up to 200k input context; above that 4.00 / 18.00 |
| Kie.ai, native Gemini variant | Gemini 3.8 Flash | 0.225 | 1.125 | 45 / 225 credits; 50% discount shown through 2026-12-31 06:00 UTC |
| Kie.ai | Gemini 3.1 Pro, UI ID `gemini-3.1-pro-openai` | 0.50 | 3.50 | 100 / 700 credits; card does not describe long-context threshold |

Sources: [Google pricing](https://ai.google.dev/gemini-api/docs/pricing), [Kie Flash](https://kie.ai/gemini-3-8-flash), [Kie Pro](https://kie.ai/gemini-3-1-pro). Kie prices were read in model-card UI rather than a comparative marketing table. Card ratios correspond to $0.005 per credit; actual debit rounding still requires checking. Flash rates are confirmed for the native variant; equal OpenAI-compatible variant pricing needs separate verification.

Kie Flash is currently **70% cheaper** than current Google Standard in both directions. Kie's “15% of official price” compares with Google's full $1.50 / $7.50 and ignores Google's current promotion. Pro savings against Google's short-context rates are 75% on input and about 70.8% on output.

Example without reasoning beyond the stated output: 10,000 input and 2,000 output Flash tokens cost $0.015 on Google Standard, $0.027 on Priority, and $0.0045 on Kie. This is a rate calculation rather than measured average task cost. Top-up bonuses are excluded: account for them through purchased-credit cost rather than automatically lowering every rate.

### 11.4. Kie failure rate: what was actually established

Flash has a 24H Status Monitor. At inspection, the interface displayed **Success 100%** for **2026-09-25 22:00:16–22:10:16**, in a timezone the widget does not explain. This means 0% unsuccessful events only within the displayed ten-minute interval under Kie's unknown methodology. It is not a daily aggregate, independent estimate, SLA, or evidence of zero errors for our requests. Sample count is absent. No confirmed aggregate failure statistics were found for Pro; the card rating is not such a metric.

Do not combine these into one percentage without a breakdown: HTTP 429, 5xx, timeout/broken stream, unknown post-dispatch outcome, safety refusal, invalid schema/tool call, unsatisfactory quality. HTTP 200 with model refusal also does not mean a successful application task.

Kie's general documentation mentions 20 new generation requests per 10 seconds and 100+ concurrent tasks. The context describes asynchronous task creation, so these numbers cannot be transferred to synchronous Gemini chat. Model RPM, TPM, concurrent streams, queue, deadline, and failed-chat billing rules remain unknown. [Kie getting started](https://docs.kie.ai/1973359m0).

Before primary use, confirm those limits and conduct a bounded paid run. Proposed protocol: identical task sets, separate text/vision/tools/schema groups, concurrency steps, multiple time windows; measure first-attempt error rate and final success after allowed retries, p50/p95 TTFT and total time, and cost per successful result. Zero errors in 100 requests does not prove 99.9% reliability; an approximate 0.1% upper bound with zero observed errors needs about 3000 independent observations, while correlated failures still require checks over time. No such run occurred here.

### 11.5. UAI improvements and recommended choice

**Direct Google** best meets the wish to avoid additional intermediary accounting. Provider billing remains in every paid option; direct connection needs no additional credits, upstream routing, or intermediary reconciliation.

1. Following the owner's selection, begin with Google Cloud Standard PayGo. Check model availability and Cloud-account quotas. Developer API through AI Studio remains an alternative rather than the selected first connection.
2. Plan Cloud Priority PayGo as a separate profile over the same Cloud connection. Enablement and acceptance belong to the next phase. Verify exact-model capacity rather than substituting the word Priority for this check.
3. If guaranteed capacity is needed, assess Provisioned Throughput against real load. This is a separate financial decision rather than an ordinary API-key change.
4. Keep Kie as an economical-route candidate after verifying restrictions and results. Confirmed low pricing does not prove good availability.

Additional work beyond section 5's common foundation: native Gemini `contents/parts`, function-call/result serialization, `thoughtSignature` preservation, inline/file images, schema and thinking settings; prompt/candidates/thoughts/cache token counting without duplication; safety/finish reasons and broken streams. For Cloud: project/location, IAM/OAuth, credential refresh. For Priority: supported transport, requested/actual service tier, downgrade, different rates and quotas. Built-in Google Search needs a separate financial profile before enablement.

Additional engineering estimate: direct Standard with full local acceptance 3–5 days after the shared foundation; Cloud auth/routing another 1–2 days; Interactions/Priority another 2–4 days with capability checks for the chosen API. Do not count section 9's common tool history again. Waiting for quotas/capacity purchase and paid checks is estimated separately. Google Cloud Standard is already in section 9's total; do not add that package again. The Interactions estimate applies only to the alternative Developer API, not Cloud Priority.

Additional criteria: AMS-A19 — Gemini continuation metadata preserved; AMS-A20 — actual tier and correct downgrade rate; AMS-A21 — separate safety/HTTP/transport/schema errors; AMS-A22 — published limits confirmed for model/account, capacity checked under agreed load. These criteria are proposed rather than passed.

## 12. Cloud: SLA and load example

Clarification dated 2026-09-25. Gemini has a [separate SLA](https://cloud.google.com/vertex-ai/generative-ai/sla): baseline monthly availability 99.5%; designated shorter-availability models 95%. Preview and quota errors are excluded unless documentation says otherwise. This is contractual availability rather than measured successful-request percentage. Provisioned Throughput has an additional latency SLO only for covered models/endpoints and conditions. Priority alone does not imply a separate higher SLA.

For user-capacity planning, propose `RPM = TPM × 0.7 / T`, where T is average quota-counted tokens per request and 0.7 is a selected engineering margin rather than a Google guarantee. Confirm the exact TPM counter and include its contribution for input, images, output, and reasoning according to model rules. Below, T is an assumed value already in that counter's units.

| Assumed request T | Flash at 2M TPM: requests/min | Pro at 500k TPM: requests/min |
|---|---:|---:|
| 2,000 | 700 | 175 |
| 10,000 | 140 | 35 |
| 30,000 | 46 | 11 |

At one request per minute per user, figures equal simultaneously active users with evenly distributed load. At one request per two minutes, users double. At 15-second average response time, concurrent requests equal RPM/4: for example, 140 RPM means about 35 concurrent generations. This model does not cover all requests starting abruptly together. Three model calls per user action reduce available action count roughly threefold for equal T per call.

These calculations use section 11's Standard baseline and establish no Priority or Gemini 3.8 Flash quota. Actual throughput for a new account and newest model remains to be checked. [Standard PayGo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/standard-paygo).

[Cloud Priority](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo) is available without advance Provisioned Throughput purchase. Priority-only mode requires headers `X-Vertex-AI-LLM-Request-Type: shared` and `X-Vertex-AI-LLM-Shared-Request-Type: priority`. The 0.3-of-Standard rule belongs to Developer API and is not established for Cloud by this source. The public Cloud Priority page has no separate numeric quota table.

[Cloud pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing): global Priority Flash 3.8 through the end of 2026 is $1.35/$6.75 per million input/output tokens; Pro 3.1 Preview up to 200k is $3.60/$21.60, above that $7.20/$32.40. Output includes reasoning. This is +80% over corresponding Standard. Non-global Flash costs 10% more. The Cloud Priority page specifies no minimum spend or mandatory wait for activation; this does not promise automatic availability on every new account.


## 13. Selected first phase: Cloud Standard prepared for Priority

Recorded at the owner's direction on 2026-09-25. Current scope is future-implementation requirements.

| Area | Build for Standard PayGo | Prepare for future Priority PayGo |
|---|---|---|
| Connection | Google Cloud provider/adapter, project, location initially using global endpoint, IAM/OAuth, credential refresh | Reuse Cloud auth and native transport; no separate Priority provider needed |
| Model profiles | Selected Gemini Pro/Flash after exact-ID and availability confirmation | Service mode as explicit route-profile setting; separately check model/location Priority support |
| Capabilities | Text, vision, streaming, tools/schema, thinking, continuation metadata according to confirmed capabilities | Preserve the same external API/SDK contracts wherever capabilities match |
| Rates and quoting | Cloud rate cards, context thresholds, reasoning/cache/image usage, reservation and settlement | Separate Standard/Priority rate versions; mode in quote and attempt evidence, expensive mode never silently enabled |
| Queue and quotas | Confirmed account/model limits, burst smoothing, deadlines, 429 classification | Per-mode limits; do not transfer Developer API's 0.3 factor to Cloud |
| Routing | Selected Standard profile only | Switch to Priority through a newly published profile with its rates; automatic paid fallback disabled by default |
| Observability | Requested model, endpoint, service mode, usage, cost, attempt outcome | Preserve actual service class where confirmed data exists; do not replace missing metadata with assumptions |
| Checks | Local text/vision/tools/schema/stream scenarios, errors, financial invariants; then a separate agreed live run | Contract checks for mode parameters and rate selection now; real Priority acceptance when connected |

The first phase does not require Gemini Developer API's Interactions API, Provisioned Throughput purchase, or Priority enablement. Reuse section 5's common foundation and tool history. Confirm exact quotas and SLA for the chosen model separately; the public Standard table does not replace account verification.

Architecture-readiness criterion: Priority is added through a Cloud profile, rates, request parameters, and its own acceptance, without a second independent Gemini adapter or financial-accounting redesign. Priority-specific implementation may wait until the next phase.
