# Model capabilities and input limits

## Embeddings

All three models use `embeddings.generate`, `input.texts`, and the shared `type: embeddings` result. Indices are normalized to input string order. The result contains `model`, `revision`, `dimensions`, and `data`. Current adapters return `revision: null`: an alias does not establish the exact revision or allow detecting a hidden model update.

| Model | Dimensions | Default | Tokens: string / batch | Input type |
|---|---|---|---|---|
| OpenAI text-embedding-3-small | 1–1536 | 1536 | 8192 / 300000 | Not sent |
| OpenAI text-embedding-3-large | 1–3072 | 3072 | 8192 / 300000 | Not sent |
| Voyage voyage-4 | 256, 512, 1024, 2048 | 1024 | 32000 / 320000 | `query`, `document`, or unset |

Installation safety limits intersect with model limits: 128 strings, 16384 total coordinates, and a 512 KiB serialized result. For Large 3072, this means at most five strings per call. OpenAI is additionally limited to 32768 UTF-8 bytes per string; total prepared batch text is limited to 128000 bytes. Published profiles/catalog return `embedding_features` with model and shared limits.

OpenAI uses `cl100k_base`. Voyage has no exact local tokenizer: validation uses UTF-8 byte count plus a margin of 64 per string with `input_type`. Some texts acceptable to the provider are therefore conservatively rejected. The adapter always sends `truncation: false`, `output_dtype: float`; `dimensions` maps to `output_dimension`. There is no hidden truncation. The example profile forecast adds a shared margin of 8192 tokens per batch; actual accounting uses provider usage.

The batch remains an atomic work item. A defect in one vector makes the entire result defective. The application stores vectors permanently; repeating a command with the same key and repeating ACK do not create a new request or charge.

## Structured Responses and Tools

A limited JSON Schema subset is supported:

- `type`: object, array, string, number, integer, boolean, null, including an array of types.
- `properties`, `required`, `additionalProperties: false`, `items`; optional properties are allowed. For provider API conversion, every object must explicitly forbid unknown properties.
- Scalar `enum`, `const`; `anyOf`, `oneOf`. A union node permits only variants, `$defs`, `title`, and `description`; assertion siblings are rejected. `oneOf` is locally checked for exactly one matching variant.
- `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`; nested arrays of objects.
- Root `$defs` and `$ref` of the form `#/$defs/name` with JSON Pointer escaping. Cycles, external references, and `$ref` siblings other than annotations are rejected without network requests.

Limits: 64 KiB schema, depth 16, 2048 expanded nodes, 256 properties, 16 branches per union, 256 enum values, and patterns up to 256 characters. Numeric lengths/sizes are capped at 1000000. Regex uses Unicode JavaScript without groups, lookaround, alternation, backreferences, or repeated quantifiers. At most one repeated atom is permitted; repetition requires `^` and `$`; numeric repetition is at most 10000. For example, `^[a-z]+$` is supported. This is an intentionally restricted language without dangerous backtracking. Other keywords, including `format`, `allOf`, `not`, and `patternProperties`, are rejected before dispatch.

In the wire schema, an optional field becomes an internal object `{present:false}` or `{present:true,value:…}`. The client never sees this wrapper. After restoration, an absent field is removed while explicit user `null` is preserved. Constraints are checked against the original schema; the provider receives a simpler strict schema. Root scalars/arrays and unions also receive an internal wrapper.

For transformed schemas, intermediate deltas are buffered until complete restoration and validation. Unchanged schemas retain streaming. `delivery.field_paths` supports declared string properties of objects, including nested ones; array indices and wildcards are unsupported. The final result remains authoritative. A defect contains `usage.attempts[].validation_error` with a JSON Pointer `path` and short `reason`, without the field value.

The catalog may declare `text_features.forced_tool_choice: false` or `tools: false, schema: true`. UAI automatically requests a structured single-tool-call envelope, validates the name, arguments, and call count, and returns a standard `tool_call` with `execution_method: schema`. Native tools use `native`. For registered Anthropic Opus 5.5, Fable 5.1, and Mythos 5.1 families, forced calls switch to schema mode. Published structured-output capability is required. A refusal remains a refusal; emulation neither creates an extra attempt nor executes the tool itself.

## Priority and Concurrency Reserve

`priority: interactive | background` is accepted in quote/invocation; the default is `background`. The application explicitly marks user requests. An existing quote's priority cannot be changed when using it.

The initial `interactive_reserve` is one slot. Background work may occupy at most `max(1, total - reserve)` slots. The reserve applies to executing queue, application, and account tasks; publishing queue/application/account jobs; provider quota groups; and the legacy limiter. Total active account capacity continues to constrain both classes. Queue, group, and limiter settings are available through existing admin APIs and forms. The legacy lease API accepts `interactive_reserve`; the worker process uses `UAI_WORKER_INTERACTIVE_RESERVE` (default 1), and `UAI_WORKER_CONCURRENCY` defines total capacity.

At capacity 1 there is no separate interactive slot. Running work is not preempted. Rejection by the local worker gate leaves the durable request queued; the reconciler republishes it. Task age raises selection order; the difference between new interactive/background tasks equals ten minutes of waiting. Fairness across accounts is preserved. This does not promise a start time when demand continuously exceeds available capacity.

Priority does not change budget, authorization, rate windows, backpressure, deadline, attempt cap, or unknown outcomes. It cannot bypass provider quota.

## Call-list Forecast

`POST /v1/forecasts`, scope `ai:quote`, SDK `client.ai.forecast(body)`. The call reads published single-call profiles; no new recipe is registered. It creates no wallet, reserve, allowance, operation, execution request, or provider call. Account authorization is preserved.

```json
{
  "account_id": "account-example",
  "calls": [
    {
      "profile": "files.logopanel.text-embedding-3-large",
      "count": 20,
      "parameters": {"dimensions": 3072},
      "volumes": [
        {"dimension": "input.uncached", "unit": "tokens", "quantity": "500", "low": "400", "high": "700"}
      ]
    }
  ]
}
```

`quantity/low/high` are the expected volume of one call; `count` multiplies it. All monetary values and quantities are transmitted as strings. Limits: 100 items, 1000 repetitions per item, 32 dimensions. All billable profile dimensions are required; an empty list, zero total volume, duplicates, unknown dimensions, and unordered ranges are rejected. Profiles with quantity components or declared `maximum_items` are supported; USD-formula and multi-component recipes require concrete input and are explicitly rejected here.

The response separates `provider_cost` and `customer_charge`, each with `expected_units/low_units/high_units`, and records profile/route/catalog/rate-card versions, time, and `method_version: lf-forecast-1`. For tokens without user boundaries, it uses a heuristic range from half to twice the volume, with `low` confidence. Otherwise confidence is `modeled`; an `approximate` calculation also yields `low`. No accuracy percentage is claimed. Reasons and assumptions are returned in the response. Additional attempts, fallback, free allowance, and hidden discounts are excluded. Safety applies to the quoted-final profile price, and markup follows its policy; with actual pricing, safety does not increase the actual charge.

`range_is_charge_cap: false`: the forecast upper bound neither authorizes spending nor guarantees a maximum. A separate quote/invocation still authorizes work.

## Recraft and Quiver SVG

| Provider / model | Capability | Input |
|---|---|---|
| Replicate recraft-ai/recraft-v4-styles-svg | image.generate | prompt, 1–10 raster references |
| Replicate recraft-ai/recraft-v4-styles-pro-svg | image.generate | prompt, 1–10 raster references |
| Replicate recraft-ai/recraft-vectorize | image.vectorize | Exactly one raster asset, no prompt |
| Quiver arrow-2, arrow-2-telos | image.generate | prompt, up to 16 references |
| Quiver arrow-2, arrow-2-telos | image.vectorize | Exactly one raster asset, no prompt |

Images are uploaded through the standard assets API first, then passed as `input.asset_ids`. SVG profile preparation requires `mode: preserve`; bytes are not reduced or transcoded without the client knowing. PNG/JPEG/WebP, one frame, up to 4096 per side and 16777216 pixels are allowed. Replicate allows up to 5000000 bytes per file, Quiver up to 12 MiB, and the prepared UAI batch up to 20000000 bytes. Recraft Vectorize requires at least 256 per side. Validation decodes the exact bytes to be sent before the provider call. Prompt size is up to 10000 bytes.

Replicate receives `style_reference_images`, the field name in the input schema; the provider README uses another name. Styles allows `size` from the published list and `style_match: precise | flexible`; Pro uses doubled dimensions. A native prediction is created and its ID stored before polling; lookup and cancel use a fixed API host. Results are downloaded only from HTTPS `replicate.delivery` and its subdomains, without redirects or forwarding Authorization. `style_id` is not stored in result or usage and is not accepted as input.

Successful-result pricing: `output.image/images=1`, plus `style.creation/calls=1` for Styles. In prices checked on 2026-09-25, Styles costs $0.05, Pro $0.12, and Vectorize $0.01 per output image; no separate style-creation surcharge is published. The files **explicitly include** it as a separate zero rate rather than omitting it. If the applicable tariff changes, a new rate card with the required surcharge is needed. A failed/canceled prediction does not establish zero usage: usage remains unknown.

Quiver uses direct `/v1/svgs/generations` and `/v1/svgs/vectorizations`, `n:1` for generation, and mandatory `max_output_tokens` (1–65536). Generation supports `reasoning_effort`, `temperature`, and `top_p`; vectorize supports `auto_crop`, `temperature`, and `top_p`. The result is one `image/svg+xml`.

Real generation requires a Quiver production key. `sk_test_` keys return synthetic SVG without running the model or incurring costs; the adapter rejects them before dispatch with `quiver_sandbox_key`. A response with `x-quiver-environment: test` is also not delivered as real generation. [Sandbox documentation](https://docs.quiver.ai/developers/guides/sandbox-and-test-keys).

| Quiver, USD / 1M tokens | Regular input | Cache read | Cache write | Output |
|---|---|---|---|---|
| arrow-2 | 4 | 0.4 | 5 | 20 |
| arrow-2-telos | 6 | 0.6 | 7.5 | 30 |

`input_tokens` includes cache: regular input = input − cached − cache_write; each of the three portions is billed once. Reasoning is included in `output_tokens` and stored only as a breakdown, without a second charge. Inconsistent counters or only one of the two cache counters yield `unknown`, rather than zero cost. **Quiver's native SVG reference does not guarantee cache breakdown fields**; their names are confirmed in Responses API documentation. A response with no breakdown at all prices all input at the cache-write rate, the highest input rate, with `input_cache_split=absent_priced_as_cache_write` in the breakdown. Cost becomes known and the call is settled. This is an upper bound, rather than Quiver's exact price.

The amount shown in a provider dashboard is not a replacement for per-request billing counters.

New Quiver profiles use `actual_capped`: an explicit customer cap is reserved, actual usage is priced with markup, and capture is limited to the accepted maximum. Overdraft permission is passed as a separate flag only for `estimated_actual`; token pricing alone does not enable it. Actual provider cost is stored in full even when above the customer cap. Transport failure/5xx/408 after dispatch means unknown, without automatic retry. Quiver declares no native lookup/cancel: abort after dispatch does not establish provider cancellation.

SVG follows the existing storage/manifest/ACK/TTL path and local validation. Script, foreignObject, style, animation, event handlers, external href/src, `url()`, `@import`, entities/DOCTYPE, and processing instructions are prohibited. `<style>` support has not been expanded without a real verified format. Safety is established by rejecting unsupported SVG, rather than silently “repairing” it.

## Configurations

`configurations/ai/logopanel/` contains ten separate unactivated bundles: three embeddings, three Replicate, and generate/vectorize for each of two Quiver models. The installation owner sets symbolic bindings `primary` and `period` at publication. These files do not change active connections. Prices have a source and date; recheck them before use. Markup 0 and one attempt in examples are example settings, not universal product policy. Generator: `pnpm exec tsx scripts/generate-logopanel-examples.ts`.
