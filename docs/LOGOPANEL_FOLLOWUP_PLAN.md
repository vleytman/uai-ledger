# UAI Follow-up Plan for LogoPanel Requests

Date: 2026-09-25. Status: LF-I00–LF-I08 implemented and verified locally. Matrix LF-A01–LF-A18. Paid live acceptance was prepared separately but has not been run.

[Contents](README.md) · [Decisions](DECISIONS.md) · [Universal Invocations](UNIVERSAL_INVOCATION_PLAN.md) · [Integration](UNIVERSAL_INVOCATION_INTEGRATION.md) · [Local Run](LOCAL_RUN.md)

## Basis and Boundaries

Source: LogoPanel document `docs/UAI-REQUESTS.md` dated 2026-09-25, based on UAI `ebf3396`, and subsequent discussion with the owner. This plan preserves the agreed scope independently of the external document.

Changes concern UAI: API, SDK, adapters, catalog, estimation, queues, accounting, tests, and documentation. LogoPanel product logic remains in the application. Backward compatibility is not required before the first joint launch. Idempotency, separate accounting for provider cost and customer charges, and prohibition of automatic retries for unknown outcomes are preserved.

Outside this phase:

- A shared reservation for composite work with dynamically added calls. Later implemented by a separate decision of 2026-10-20: [composite work reservation](QUOTING.md#reservation-for-compound-work).
- Streaming strings from array elements, for example `/checks/*/note`.
- Storing and reusing Recraft styles.
- Deployment, changes to active connections, and paid calls without separate approval.
- SVG animation generation and standalone product SVG-editing scenarios.

Do not treat existing uncommitted changes as part of this plan or overwrite them. Check the current state before each phase: parallel work already affects streaming, input preparation, and cache calculation.

## Agreed Decisions

| ID | Decision |
|---|---|
| LF-D01 | Embeddings: OpenAI `text-embedding-3-small`, `text-embedding-3-large`, and Voyage `voyage-4`. Do not connect Voyage Large or Lite now. |
| LF-D02 | Capabilities, dimensions, string and batch limits, and input types are model-specific, with a shared installation safety ceiling. Support `query/document` when the provider distinguishes them. Reject overlong text without truncation. |
| LF-D03 | An embeddings result contains model identity and dimensions. Return an exact revision only when a trustworthy source exists; do not substitute a model alias for an unknown revision. |
| LF-D04 | Support optional JSON Schema properties and conversion to the provider format. Remove only internal absence values. Preserve `null` explicitly permitted by the original schema. Distinguish missing fields from explicit `null`, including optional nullable fields. |
| LF-D05 | Include the requested `enum`, `const`, `anyOf/oneOf`, string and array constraints, `pattern`, nested arrays of objects, and local `$ref/$defs`. Document the exact subset and limits. Reject unsupported constructs before a paid call. |
| LF-D06 | Result validation errors contain field path and reason. Streaming strings inside arrays is deferred; supported paths are explicitly described. |
| LF-D07 | If a model lacks forced tool choice but supports the required structured response, automatically emulate the call through a schema. Return a unified `tool_call` and execution-method marker. A model refusal remains a refusal. |
| LF-D08 | Priorities `interactive/background`, default `background`. Limit background work to preserve concurrency capacity for live calls. The application explicitly marks live calls. |
| LF-D09 | Estimate a list of planned calls using profiles and expected volumes without registering a recipe or making a financial reservation. Return forecast, range, assumptions, and a confidence category with reasons. The range is not a guaranteed charge ceiling. |
| LF-D10 | Connect Recraft V4 Styles SVG and V4 Styles Pro SVG through Replicate with reference images, plus Recraft Vectorize for raster-to-SVG conversion. |
| LF-D11 | Do not store or reuse `style_id`. Send references during generation; account for any style-creation cost in provider cost. |
| LF-D12 | Connect `arrow-2` and `arrow-2-telos` through Quiver's direct API for SVG generation from descriptions and raster-to-SVG conversion. Account for actual tokens under the applicable tariff. |
| LF-D13 | Perform local acceptance and prepare live acceptance with a separate budget calculation. Approve the paid run itself after preparing a concrete scenario. |

### Recraft Names

During discussion the owner called the variants “4.1 and 4.1 Pro with styles.” The verified routes with references are published as `recraft-ai/recraft-v4-styles-svg` and `recraft-ai/recraft-v4-styles-pro-svg`. The agreed selection refers specifically to these Styles variants. Regular V4.1 SVG and V4.1 Pro SVG do not replace them: their checked input schemas have no reference images.

Styles references define visual style. This does not promise exact preservation of the source logo's geometry. Converting an existing raster uses the separate Vectorize operation.

## Implementation Phases

Each phase ends with checks and a record of actual results. The next phase uses the previous phase's verified contract.

| Phase | Work | Completion condition |
|---|---|---|
| LF-I00 | Check current implementation, uncommitted changes, schemas, and provider APIs. Record DTOs, capability matrix, SVG pricing model, and resource limits. | A change map and technical decisions exist without invented provider capabilities or prices. |
| LF-I01 | Extend the embeddings contract, catalog, and OpenAI adapter; add the Voyage adapter, limits, and result identity. | Small, Large, and Voyage pass positive and negative contract tests; API/SDK/configurations agree. |
| LF-I02 | Implement the JSON Schema subset, conversion and optional/null restoration, complexity limits, and errors with paths. | Local validation of the original schema and result agrees with conversion; nested variants and references are covered. |
| LF-I03 | Add forced tool choice emulation on top of LF-I02. | Exactly one required call, correct name and arguments, unified result format, metadata, and preserved refusal/defect rules. |
| LF-I04 | Add API/SDK priority and queue scheduling with interactive capacity reserve. | Background work does not occupy the reserved capacity; concurrent admission checks pass on real local infrastructure. |
| LF-I05 | Add batch preliminary estimation without a recipe or reservation. | Estimation is explainable and reproducible from profile/tariff versions, with no financial or execution side effects. |
| LF-I06 | Connect three Recraft routes through Replicate, references, SVG delivery, and accounting for all applicable price components. | Generation and Vectorize pass the complete local path; SVG is validated and safely delivered to the application. |
| LF-I07 | Connect Quiver Arrow 2 and Telos, generation and vectorization, usage, and token pricing. | Token accounting, SVG delivery, cancellation, errors, and unknown outcomes pass contract/integration tests. |
| LF-I08 | Align documentation and overall acceptance; prepare live-run scenarios, measurements, and budget. | A report with LF-Axx is issued, distinguishing local evidence from real checks not yet performed. |

## Acceptance Criteria

| ID | Verified behavior |
|---|---|
| LF-A01 | Embeddings: valid dimensions, including 3072 for OpenAI Large, are not constrained by the former shared ceiling of 1536; invalid values and limit overruns are rejected before dispatch. |
| LF-A02 | Embeddings: vector order and count, finite coordinates, dimensions, model, and available revision are checked; `query/document` are passed according to the model contract. |
| LF-A03 | Embeddings: usage, accounting, and idempotent command replay do not create duplicate charges; long text is not truncated. |
| LF-A04 | Schemas: required/optional and nullable/non-nullable are distinguished, including nested objects and variants. Original semantics survive provider conversion. |
| LF-A05 | Schemas: declared keywords and local references are covered; external references and unsupported constructs do not cause network fetches or paid dispatch. Size, depth, and property count are bounded. |
| LF-A06 | A defective result returns a path and reason without disclosing private content in shared logs. Streaming and final result agree; array wildcard paths are not declared supported. |
| LF-A07 | Native and emulated tool choice produce a unified format. Wrong name/arguments/call count are not success; refusal does not trigger bypass through another model. |
| LF-A08 | Priority: an omitted parameter means background; under background load, capacity remains reserved for interactive within shared quotas. Running requests are not interrupted for priority. |
| LF-A09 | Priority does not bypass provider rate limits, budget, backpressure, authorization, deadline, or total attempt limit. Concurrent workers and prevention of double admission are checked. |
| LF-A10 | List estimation creates no reservation, recipe, operation, or provider call. Empty/invalid volumes and unsupported profiles are handled explicitly. |
| LF-A11 | Forecast is separate from maximum budget, and provider cost from customer charge. Confidence explains uncertainty sources without an unsupported accuracy percentage. |
| LF-A12 | Recraft Styles: images reach the correct route; style ID is not stored for reuse. Style-creation cost is not lost when applicable. |
| LF-A13 | Recraft Vectorize and Quiver vectorization accept raster input and return SVG. SVG generation from descriptions is checked separately from vectorization. |
| LF-A14 | SVG passes existing security validation. If real formats require `<style>`, any expansion is agreed with safe CSS parsing, without allowing external loads, `url()`, or `@import`. |
| LF-A15 | Quiver: tariff and usage account for regular input, cache, and output, including reasoning without double counting. Unknown usage does not become zero cost. Responses without a cache breakdown are priced at the cache-write rate (decision of 2026-10-20). |
| LF-A16 | New adapters preserve cancellation, no automatic retry for unknown outcomes, idempotent charging, result persistence before ACK, and cleanup under the existing contract. |
| LF-A17 | API, SDK, catalog, configuration schemas, and documentation describe the same capabilities, constraints, and tariff units. |
| LF-A18 | The live-run plan lists models, inputs, call counts, cost estimates, and stop conditions. It measures UAI latency separately from provider time; p50/p95 include sample size and methodology. |

## Technical Details for LF-I00

These details are not grounds for reopening the agreed product scope. Determine them from code and documentation; bring material scope changes to the owner.

- Choose concrete configurable concurrency-reserve values and queue limits. State their scope: installation, application, connection/quota group. Prevent background queue starvation.
- Establish safe JSON Schema limits and local-reference rules. When a provider cannot express a keyword directly, explicitly define conversion and local validation without silently losing semantics.
- Choose a representation for optional nullable that distinguishes absence from explicit `null`.
- Define forecast-range and confidence-category calculations. Return assumptions and tariff versions with the estimate.
- Check that Quiver token pricing matches the existing calculation policy. Do not extend negative-balance permission to new profiles without checking the current contract and obtaining a separate decision if needed.
- Check tariffs for the selected Replicate Styles routes specifically; do not transfer regular SVG-model prices to Styles.
- Define trustworthy embedding-model identity when the provider does not expose an exact revision. Do not promise automatic detection of hidden model updates.

## Checks and Report

Use commands from [LOCAL_RUN](LOCAL_RUN.md), current repository scripts, and an isolated test database. For each enhancement, run targeted tests followed by shared type, API, configuration, documentation, and build checks. Verify financial and concurrent scenarios through integration tests; do not count skipped tests as passed.

Record results separately from this plan with LF-Axx references. Use Aside for interface checks when affected. Do not store credentials, private provider responses, or databases in Git.

Previously completed real OpenAI checks are described in the [summary](REAL_PROVIDER_CHECKS.md). They do not establish readiness of new adapters or changed contracts. Prior approval of their budget does not authorize new paid calls.

## Verified External Sources

Information reviewed on 2026-09-25; recheck tariffs and availability before publishing configurations and live acceptance.

- [Voyage: models and parameters](https://docs.voyageai.com/docs/embeddings), [pricing](https://docs.voyageai.com/docs/pricing).
- [Replicate Recraft Styles SVG](https://replicate.com/recraft-ai/recraft-v4-styles-svg), [Styles Pro SVG](https://replicate.com/recraft-ai/recraft-v4-styles-pro-svg), [Vectorize](https://replicate.com/recraft-ai/recraft-vectorize).
- [Quiver Arrow 2](https://quiver.ai/models/arrow-2), [Arrow 2 Telos](https://quiver.ai/models/arrow-2-telos), [API pricing](https://docs.quiver.ai/developers/pricing), [vectorization](https://docs.quiver.ai/api-reference/vectorize-svg/vectorize-svg).
