# Jev System One

[Contents](README.md)

## Setup

Configure Jev with capability `api.call`, provider `typesafe`, adapter `typesafe@1`, operation key `typesafe.systemone`, and profile `typesafe.jev-1.13.0`. The HTTP request always specifies `jev-1.13.0`. The response must include the actual `model`; a mismatch is a technical defect. UAI saves usage and the returned model before validating the response.

Publish [the example bundle](../configurations/api/typesafe/jev.json) through the [configuration CLI](FILE_CONFIGURATION.md), binding it to a TypeSafe connection and installation budgets. The file alone does not activate a connection in your database.

## Provider capabilities and limits

The [API](https://docs.typesafe.ai/api), [OpenAPI](https://api.typesafe.ai/openapi.json), and [model card](https://docs.typesafe.ai/models) were checked on September 26, 2026, local date. The public contract covers evaluation and model listing. It describes no tokenizer, count endpoint, lookup, cancellation, or provider idempotency. Balance and cost reporting are disabled.

The input rate is $0.042 per million tokens; output is free. The model card specifies 64k for the entire request and 32k for state together with the longest question, but does not define the exact integer value of k or the relationship between the limit and `usage.input_tokens`. The example profile uses a maximum of 32768 input tokens for reservation and quota admission. This is a chosen financial admission limit, not a proven provider limit or price forecast. `estimateUsage` returns `unavailable`.

TypeSafe receives no token-limiting parameter: 32768 is used internally by UAI. Actual consumption may exceed the selected maximum; the full cost is recorded, and the installation absorbs any amount above the customer cap. Verify the provider contract and choose an acceptable financial risk budget before enabling this connection.

## Contract and limits

`state` accepts a string, JSON object, or array. Nested values may include null, booleans, strings, finite numbers including negative numbers, arrays, and objects. Instructions are required and must be meaningful. Choice criteria may be null; the true/false keys in Noul are optional. Score contains 2–10 levels. Choice contains 1–255 options.

UAI's local limits are: 32 questions; 128 characters per key; 32768 characters per string; 131072 bytes of input JSON; depth 12; 8192 nodes. Responses are limited to 1048576 bytes. Cycles, nonstandard JS objects, dangerous keys, and non-JSON values are forbidden. These are UAI limits, not claimed TypeSafe limits.

The common API-schema subset has been extended with bounded dictionaries, anyOf, const, minProperties/maxProperties, and explicit `x-uai-bounded-json`. The latter enables JSON validation with the specified bounds rather than allowing arbitrary schemas. External references and recursive schemas remain forbidden. Existing closed input objects continue to reject unknown fields.

The response is matched against the original batch: keys and types must match, Choice must select one of the supplied options with the highest probability, and Score uses zero-based indices. Probabilities must be finite and within 0–1. The sum tolerance is 0.001; the Score expected-value tolerance is 0.001 × the number of levels. For text levels, legend matches the original scale. For structured levels, the provider's string-description format is undefined, so keys and bounded legend strings are checked. Noul contains only type and noul, without confidence. Low confidence does not trigger a retry.

## Execution and money

UAI sends each batch in one HTTP POST, with no hidden retries. The call is limited by both the 60-second transport timeout and the overall deadline. A 401/403 means an access problem; 422 means invalid input; 429/529 allow normal UAI backoff using Retry-After. Other server errors, connection loss, or a lost response leave the outcome unknown. Stopping the wait does not cancel the computation.

Nothing is charged before dispatch. After dispatch, confirmed consumption for the active attempt is charged within the cap under the shared actual_usage policy. If consumption stays unknown, the reservation closes under the common rules after one hour.

Exact costs use the existing decimal arithmetic: input_tokens × 0.042 / 1000000 USD. In UAI, 1 USD = 1000000000 units. Output is retained in diagnostics, with an explicitly configured zero rate. Missing/invalid usage is recorded as unknown. A defective response with known usage retains its provider cost. Monetary integers travel as strings.

The example customer policy is cost_plus with multiplier 1, markup 0, and actual_capped. Reserving 1376256 units covers the selected maximum of 32768. After a successful result, UAI charges actual cost up to that cap and releases the rest. Any provider cost above the cap is still recorded, but creates no customer debt. The wallet must cover the full reservation even if you expect a short request to cost less.

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

If the manifest is unavailable, the helper returns the request's normal status/reason with value=undefined. Supply persist to validate the JSON, save it, and send ACK automatically in that order. The helper keeps literal question and Choice keys, uses the standard services.run, lifecycle SSE, and ACK, and has no separate token stream. Publish the profile and configure the connection before running this example.

## Local demo

The “Paid APIs” section contains a mixed Jev batch. In a normal installation, the button is disabled until a separate demo profile is configured. `scripts/run-jev-fixture.ts` creates an isolated example on ports 4345–4347 with a substituted transport, test wallet, and public fixture password. The script accepts only a local database with the `uai_jev_` prefix; migrations are applied beforehand. Existing connections are unchanged. The response, model, and usage appear in the interface, and returned content is saved before ACK.
