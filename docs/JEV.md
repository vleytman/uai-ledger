# Jev System One

[Contents](README.md)

## Setup

The local implementation uses `api.call`, provider `typesafe`, adapter `typesafe@1`, operation key `typesafe.systemone`, and profile `typesafe.jev-1.13.0`. HTTP requests always send `jev-1.13.0`. The actual `model` is required; a mismatch is a technical defect. Usage and the returned model are saved before response validation.

Publish [the example bundle](../configurations/api/typesafe/jev.json) through the [configuration CLI](FILE_CONFIGURATION.md), binding it to a TypeSafe connection and installation budgets. The file alone does not activate a connection in your database.

## Provider capabilities and limits

On September 26, 2026, local date, the [API](https://docs.typesafe.ai/api), [OpenAPI](https://api.typesafe.ai/openapi.json), and [model card](https://docs.typesafe.ai/models) were checked. The public contract includes only evaluate and model listing. It does not describe a tokenizer, count endpoint, lookup, cancel, or provider idempotency. Balance/cost reporting is disabled.

The input rate is $0.042 per million tokens; output is free. The model card specifies 64k for the entire request and 32k for state together with the longest question, but does not define the exact integer value of k or the relationship between the limit and `usage.input_tokens`. The example profile uses a maximum of 32768 input tokens for reservation and quota admission. This is a chosen financial admission limit, not a proven provider limit or price forecast. `estimateUsage` returns `unavailable`.

TypeSafe receives no token-limiting parameter: 32768 is used internally by UAI. Actual consumption may exceed the selected maximum; the full cost is recorded, and the installation absorbs any amount above the customer cap. Verify the provider contract and choose an acceptable financial risk budget before enabling this connection.

## Contract and limits

`state` accepts a string, JSON object, or array. Nested values may include null, booleans, strings, finite numbers including negative numbers, arrays, and objects. Instructions are required and must be meaningful. Choice criteria may be null; the true/false keys in Noul are optional. Score contains 2–10 levels. Choice contains 1–255 options.

UAI's local limits are: 32 questions; 128 characters per key; 32768 characters per string; 131072 bytes of input JSON; depth 12; 8192 nodes. Responses are limited to 1048576 bytes. Cycles, nonstandard JS objects, dangerous keys, and non-JSON values are forbidden. These are UAI limits, not claimed TypeSafe limits.

The common API-schema subset has been extended with bounded dictionaries, anyOf, const, minProperties/maxProperties, and explicit `x-uai-bounded-json`. The latter enables JSON validation with the specified bounds rather than allowing arbitrary schemas. External references and recursive schemas remain forbidden. Existing closed input objects continue to reject unknown fields.

The response is matched against the original batch: keys and types must match, Choice must select one of the supplied options with the highest probability, and Score uses zero-based indices. Probabilities must be finite and within 0–1. The sum tolerance is 0.001; the Score expected-value tolerance is 0.001 × the number of levels. For text levels, legend matches the original scale. For structured levels, the provider's string-description format is undefined, so keys and bounded legend strings are checked. Noul contains only type and noul, without confidence. Low confidence does not trigger a retry.

## Execution and money

One batch is sent in one HTTP POST without hidden retries. Transport is limited to 60 seconds and the overall deadline signal. 401/403 indicate an access problem, 422 invalid input, and 429/529 permit normal UAI backoff with Retry-After. Other server errors, connection loss, and a lost response have an unknown outcome. Canceling the wait does not mean canceling computation. No charge occurs before dispatch. After dispatch, confirmed consumption by the active attempt is charged within the cap under the common actual_usage policy; when consumption is unknown, the reservation is closed under the common rules after one hour.

Exact costs use the existing decimal arithmetic: input_tokens × 0.042 / 1000000 USD. In UAI, 1 USD = 1000000000 units. Output is retained in diagnostics, with an explicitly configured zero rate. Missing/invalid usage is recorded as unknown. A defective response with known usage retains its provider cost. Monetary integers travel as strings.

The customer policy is cost_plus: multiplier 1, markup 0, actual_capped. A reservation of 1376256 units corresponds to the selected maximum of 32768. After a successful result, actual cost is charged within the cap and the remainder is released. Full provider cost above the cap is recorded; no customer debt is created. A small balance may not cover the full reservation even if a short request would cost less.

The quota template has separate RPM 1200 per 60000 ms and TPS 250000 per 1000 ms. These are public, changeable values; the specific account's allocation is required before connection. All keys for an account bind to one quota group. `unmetered` means there is no allowance package, not that service is free.

## SDK and JSON

All `application/json` results are returned in a manifest with `type=structured`, `value`, and the original `text`. This is the common JSON-service format, including Firecrawl and Serper. Other text results retain `type=text`. The SDK exports `serviceJson`, Jev types, and `jev`.

```typescript
const evaluator = jev(client, { account_id: accountId });
const input = {
  state: 'My invoice was charged twice.',
  questions: {
    urgent: { type: 'noul', instructions: 'Is there an urgent deadline?' },
    team: {
      type: 'choice', instructions: 'Choose the team.',
      criteria: { billing: null, technical: null }
    }
  }
} as const;
const quote = await evaluator.quote(input, 'jev-quote-1');
// After the application confirms the maximum:
const result = await evaluator.run(input, {
  key: 'jev-run-1', budget: { max_units: quote.max_units }
});
if (result.value) {
  await saveResult(result.value);
  await result.acknowledge();
}
```

If the manifest is unavailable, the helper returns the request's normal status/reason and value=undefined. When persist is supplied, JSON validation occurs before saving and automatic ACK. The helper preserves literal question and Choice keys and uses standard services.run, lifecycle SSE, and ACK. Jev has no separate token streaming. The example requires an explicitly published profile and configured connection.

## Local demo

The “Paid APIs” section contains a mixed Jev batch. In a normal installation, the button is disabled until a separate demo profile is configured. `scripts/run-jev-fixture.ts` creates an isolated example on ports 4345–4347 with a substituted transport, test wallet, and public fixture password. The script accepts only a local database with the `uai_jev_` prefix; migrations are applied beforehand. Existing connections are unchanged. The response, model, and usage appear in the interface, and returned content is saved before ACK.
