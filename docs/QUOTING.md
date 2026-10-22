# Action quoting and spending rules

[Contents](README.md)

## Purpose

The application registers a bounded action, such as a discussion round, four images, or SVG preparation. The platform estimates its credits, fixes a maximum budget, and checks actual requests during execution.

A recipe does not execute the domain workflow. It defines which requests are authorized and how much they may consume. The application still chooses participant order, passes answers between rounds, and constructs prompts.

For one call, the application does not register its own recipe. POST /invocations and SDK ai.run use a built-in versioned single-call configuration: model/profile, capability, bounded parameters, technical result requirements, and a user limit in credits. The server estimates the request and atomically accepts an operation with a reservation. If the calculated maximum exceeds the client limit, the call is rejected before dispatch. To display the price beforehand, obtain a quote for the same built-in recipe through POST /quotes with kind=single_call.

## Recipe version

### Final price from the central model

For new single-call recipes with `pricing_mode: quoted_final`, the method and rate version come from the published model. The `tokens`, `per_unit`, `lookup`, and `formula` components return quantities or monetary cost. The system adds costs, applies that model's separate buffer and markup once, converts the amount to credit units, and rounds. The forecast is not presented as exact future provider spending.

The quote fixes configuration versions, normalized parameters, input hash, prepared attachment metadata, cost breakdown, and final price. Prepared bytes are stored separately with limited retention. Quote acceptance checks that input is unchanged; execution receives the bytes prepared during calculation. A new model or rate version affects only new quotes.

In this mode, the customer reservation equals the agreed price. It is internal security for an atomic charge, not a promise of subsequent usage-based pricing. Provider spending and platform risk limits are checked separately. One call is supported; compound legacy recipes are not automatically migrated. The actual-spending estimation rules below apply to the earlier mode unless explicitly stated otherwise.

RecipeVersion contains application_id, recipe key, version, input schema, components, route references, constraints, technical validators, partial policy, settlement policy, and a user-facing description. A published version is immutable. In v1, partial_policy is always successful_parts; the configuration validator rejects all_or_nothing.

Each component specifies capability, route, call count, expected quantities, and hard limits. A small set of quantity calculations is permitted: a constant, reference to a numeric parameter, sum, and product of these values. Inputs are constrained by schema minimum/maximum. Arbitrary JavaScript, network calls, or a recursive expression language in recipes are prohibited.

`limits.parameter_values` defines the exact list of permitted JSON values for a parameter, including objects and arrays. Objects are compared by content regardless of key order; missing, extra, and changed fields are rejected before the provider call. This allows an entire Cartesia audio format to be explicitly authorized. Rate-coverage validation represents a structured value as canonical JSON, not `[object Object]`.

The server recalculates values itself. A price submitted by the browser or application backend does not authorize a charge.

This configuration example describes two passes by four participants and one final answer. It is not an exact description of all existing Logo Panel passes:

~~~json
{
  "key": "logopanel.discussion",
  "version": 1,
  "settlement": "actual_usage",
  "inputs": {
    "participants": { "type": "integer", "minimum": 1, "maximum": 4 },
    "passes": { "type": "integer", "minimum": 1, "maximum": 2 },
    "context_tokens_upper": { "type": "integer", "minimum": 1, "maximum": 30000 }
  },
  "components": [
    {
      "key": "participants",
      "capability": "text.generate",
      "route": "text.medium",
      "count": { "product": [{ "input": "participants" }, { "input": "passes" }] },
      "limits": { "input_tokens": 30000, "output_tokens": 1500 }
    },
    {
      "key": "decision",
      "capability": "text.generate",
      "route": "text.reasoning",
      "count": { "constant": 1 },
      "limits": { "input_tokens": 40000, "output_tokens": 2500 }
    }
  ]
}
~~~

context_tokens_upper is a declared upper bound used for estimation. The platform independently checks each actual request on submission. Subsequent answers may increase context; if it exceeds the permitted size, the application must shorten it or obtain a new quote. Silently dropping content is prohibited.

## Required estimation parameters

Text requires call count, input-context limit, output limit including reasoning according to the provider, result schema, and presence of images. If the full prompt is known, an available tokenizer or counting endpoint is used. Without an exact count, a conservative estimate with explicitly stated accuracy is used.

Images require model or route, generation/edit, result count, size, quality, and input file information. A fixed image count does not guarantee fixed cost when the provider bills tokens and input images.

Four images are represented as four separately estimated units. In v1, each image request creates one result. A single provider batch with indivisible usage is prohibited when the exact cost of each billable unit cannot be obtained. This permits refunding a defective unit without inventing a proportional calculation.

Speech requires text or an upper bound on characters/duration, model, format, and extra paid features. Replaying a ready audio asset is not new synthesis.

For SVG, the recipe must distinguish:

- Native vector generation at the provider.
- Vectorization of an input raster image.
- SVG code generation, validation, and bounded repairs.
- Deterministic assembly of ready vector elements by an internal worker.

Internal computation may have a registered compute.seconds or fixed operation rate. Without such a rate, the UI must not present internal rendering as an AI call with invented cost. User code from SVG is not executed as trusted platform code.

## Forecast and maximum

A quote returns two different quantities:

- estimated_units: the most likely spending for the inputs and available statistics.
- max_units: the agreed user charge limit.

Confidence is measured, modeled, conservative, or unavailable. Statistics are grouped by recipe version, model/route, context size, operation type, and parameters. With insufficient observations, the service uses a spending model instead of inventing an exact percentile.

Forecasts may account for caching. The maximum uses the most expensive permitted cache outcome: no read, a write with the required TTL, and other applicable rates. Authorized failover is included in the bound. A reservation is not an automatically charged surcharge.

The user maximum includes the price of one valid result per unit, not all failed attempts combined. Before acceptance, the system checks for a configured separate platform budget for defects and technical retries. The returned execution policy explains attempt and waiting limits; retries do not automatically increase the user price. Proposed temporary-retention periods and cancellation charging rules are part of the quote terms.

Each route states whether a cost upper bound can be justified from bounded parameters. If not, it is unavailable for guaranteed bounded actions in the first version until an administrator configures a conservative limit and platform risk budget. A P95 forecast alone is not a hard bound.

Estimation includes every paid component: input, output, cache, images, speech, tools, and registered compute. Unauthorized automatic tool loops are prohibited. Authorized loops have max calls and a separate amount.

## Quote response

This example uses synthetic amounts, not real model prices:

~~~json
{
  "id": "quote_123",
  "wallet_id": "wallet_123",
  "recipe": { "key": "logopanel.discussion", "version": 1 },
  "credit_unit_id": "ai-credit-usd-v1",
  "estimated_units": "120000000",
  "max_units": "180000000",
  "display": { "estimated_credits": "120", "max_credits": "180" },
  "confidence": "modeled",
  "settlement": "actual_usage",
  "partial_policy": "successful_parts",
  "expires_at": "2026-09-18T12:15:00Z",
  "warnings": ["cache_hits_not_guaranteed"],
  "breakdown": [
    { "component": "participants", "estimated_units": "100000000" },
    { "component": "decision", "estimated_units": "20000000" }
  ]
}
~~~

UI wording: “Usually about 120 credits. Maximum 180.” An estimated remaining balance may be shown. If cost is unknown, the launch button must not promise free execution.

## Acceptance and pinned terms

A quote is bound to organization, application, account, wallet, input hash, recipe version, route versions, and customer rate card versions. An unaccepted quote expires after 15 minutes by default.

Acceptance atomically creates an operation, pins versions, and reserves max_units. A quote can be accepted only once. A retry returns the existing operation. Changed inputs require a new quote.

The platform does not reserve provider funds when a price is merely viewed. At acceptance, it checks current availability; before every dispatch, it obtains a separate internal provider exposure claim. User credits do not guarantee funds in the provider account.

A route in recovery_wait/probing may be accepted for background waiting if policy and the overall deadline allow it; the quote displays a warning and next_retry_at. Locked, auth_failed, and budget_exhausted without a working authorized alternative are not accepted as a ready path. Shared recovery waiting does not consume the initial 15-minute normal-queue budget but counts toward the immutable overall deadline.

In the first version, the client cannot set the final price or increase max_units without renewed authorization. An operation extension accepts a new quote and adds reservation only for the increase in the overall maximum. Completed requests and captures are preserved. Reducing the maximum below captures and open claims is prohibited.

Before every request, the service checks component, call number, actual parameters, capability, files, token maxima, and available claim. Bypassing a recipe with arbitrary direct provider payload is prohibited. Experiments use the built-in single-call recipe with explicit limits and permissions; manually registering a new recipe is unnecessary.

## Reservation for compound work

A recipe requires advance knowledge of components and their counts. The application describes a chain whose next call depends on the previous answer as a reservation pool. The pool names single-call profiles, each profile's call limit, the overall limit, and the amount to hold.

```json
{"account_id":"acct_example","kind":"pool","pool":{"profiles":[{"profile":"logopanel.persona","max_calls":12},{"profile":"logopanel.moderator","max_calls":4}],"max_calls":14,"deadline_seconds":3600},"budget":{"max_credits":"2.5"}}
```

`POST /v1/quotes` with this body returns a `kind=pool` quote: `max_units` equals the held amount, `breakdown` is empty, and `pool` contains profiles with pinned versions. `POST /v1/operations` accepts the quote and reserves the full amount. The default operation duration is 3600 seconds, no more than 86400.

Each call goes through `POST /v1/invocations` (or `/v1/invocations/stream`, SDK `ai.run`) with the pool's `operation_id` and a `profile`. It is estimated as an ordinary invocation of that profile at the pinned version, receives its own quote, and takes a claim from the pool reservation. A separate call `budget` is optional; if supplied, it limits that call. Repeating the same key returns the same request. A profile outside the pool, exhausted profile limit, or overall limit returns `request_exceeds_recipe` without reservation or a call. The call deadline is no later than the pool deadline.

The pool reservation guarantees funds but does not cap charges. If a claim does not fit in the pool's free portion, the shortfall is reserved from free credits, and `accepted_max_units` grows by that amount. Without free credits, the call receives `insufficient_credits`; pool and wallet remain unchanged. Actual `estimated_actual` spending above the call claim is covered first by the pool's free portion, then free credits, then debt, as for a standalone call.

`complete` closes call admission; the remainder is released once all accepted calls settle. `cancel` and `finish-partial` behave as for a normal operation. The scheduler cancels the pool at its deadline. `amend` is rejected for a pool; `POST /operations/{id}/requests` does not accept a component in a pool. Backpressure counts each pool call when created; predeclared limits are not counted as waiting calls.

## Price changes during an operation

Customer rating is bounded by the accepted quote's published price version. If a lower applicable price is published before dispatch, both totals are calculated from actual usage and the lower is charged. Provider cost uses the applicable known provider price. History preserves both versions and the selection reason.

For a known provider price increase before a new dispatch, the service checks whether its cost fits the approved platform risk budget. Additional subsidy is disabled by default. New requests then pause with requote_required, while completed work remains available until content expiry. The user may accept a new quote or call finish-partial, cancelling requests not yet submitted. Complete only closes new-request admission and does not replace finish-partial. Active attempts' reservations are released only through settlement.

If the provider reports a new price only after execution, the discrepancy is recorded in cost and an incident. A closed wallet capture is not automatically increased. New quotes use the updated rate card.

Quote expiry after acceptance does not cancel a running operation. An operation has a separate deadline and duration limits fixed on acceptance. It cannot be extended indefinitely without checking budget and route validity.

## Charging modes

Actual_usage is mandatory in the first version. The amount equals chargeable rated cost converted to the immutable credit unit. There is no additional hidden margin.

Successful_parts means each valid part is charged independently of overall action success. If three images are ready and the fourth defective, three are charged. If a discussion's final answer fails, preceding valid answers remain billable. The UI discloses this before acceptance. Invalid SVG attempts and their technical repair do not become separate billable parts: the customer pays only for the final valid attempt. A new composition based on a valid result is new work.

Fixed_units is provided by the contract but enabled only for a recipe with bounded execution and validated economics. Examples: one result at a fixed provider rate or a fixed verified internal operation. Partial-success charging rules must be specified in the recipe; arbitrary proportional charging is not assumed.

Fixed_units cannot be enabled merely because average cost looks small. It requires a cost bound, tests of expensive permitted inputs, accounting for technical retries, and a separate loss limit. The mode stays disabled until these conditions are met.

## Margin and economics

The AI platform limits the cost of issued budget. The payment service determines its sale price. For example, 10 000 credits provide $10 of accounted spending whether sold for $30 or granted free.

The payment service calculates sales margin including revenue, fees, bonuses, internal technical losses, and infrastructure. The AI platform provides the necessary provider cost, charged credits, and platform-funded cost reports.

Changing retail price or credit quantities in new packages does not require a new credit unit. Introducing markup inside the AI platform is a separate future policy requiring versioning and disclosure; it is excluded from the described baseline model.

## Refining estimates for a specific request

New recipe versions may include `components[].estimation` with `version: 1`, a rules `source`, optional `tokenizer`, and a `rules` array. Each rule specifies a billing dimension, unit (`tokens`, `images`, `seconds`, `characters`, or `calls`), quantity source, maximum quantity, and optional expected quantity. Quantity sources: `input_tokens`, `output_tokens`, `characters`, `duration`, `fixed`. Rate conditions are retained with the rule. These are general algorithms; models are connected through rate and boundary configuration.

For `single_call`, the forecast considers specific input. The tokenizer counts serialized input with message overhead allowance; this is an estimate, not an exact counter for the provider's internal format. Reservation uses a conservative input byte bound and the submitted `max_output_tokens`. Expected answer length is explicit and is not a promise. Unknown assets and future compound-operation steps use full recipe bounds. Characters are counted in UTF-16 units, as in the current speech adapter; another billing method requires consistent adapter normalization. Duration is used only when known, or as a specified maximum.

`estimated_units` may now be less than `max_units`. For a recipe with an estimator, reservation equals the cost of the maximum permitted quantity; the route cap bounds admission above. Exceeding the cap returns `route_cost_limit`. Without an estimator, the earlier conservative calculation remains. Previously published recipes, accepted quotes, and reservations are unchanged.

Actual charging still uses terminal usage and the accepted rate version within the agreed reservation. Technical-retry risk is accounted separately. Cache is not included as an advance discount. Rules must cover every permitted model parameter; if price depends on quality, size, or another setting, profile boundaries must match the selected table.

Calculation methods are described in the [specification](MODEL_PRICING.md).

## Fixed result price

A component may have `billing.mode: fixed`. `price_parameters` lists only price-affecting parameters. `prices` contains unique `parameters` and `units` rows; each may have its own cost `estimation`. Parameters outside `price_parameters` are still validated against `limits` but do not create new price rows. Publication requires complete coverage of allowed price-parameter combinations and prohibits duplicates.

A quote returns `settlement: fixed`, `actual_usage`, or `mixed`. With fixed pricing, the user maximum and expected charge equal the selected price. A future compound-operation step reserves the highest fixed price of allowed variants; a specific request pins its selected combination's price. All single-call parameters are hash-bound to the accepted quote.

User credits and provider exposure are separate. Provider exposure is determined by estimated provider costs, not user price. A successful technically valid available result is charged once at the fixed price. Technical retries do not increase it. Cancellation before result delivery and confirmed failure are not charged; confirmed provider costs remain platform expenses. An unknown outcome retains reservation pending investigation; late charging after financial closure is prohibited. Unknown cost for an already confirmed available result does not prevent a fixed charge but remains unknown in provider accounting. An automatic refund for lower provider rates does not apply to fixed pricing.

Markup is not added in an adapter or cost estimation algorithm. The fixed base price is stored in billing settings separately from actual provider usage. Financial return also depends on credit sale terms in the external plan service.

## Estimated text billing `estimated_actual`

For a single OpenAI text.generate, a published recipe may select `pricing_mode: "estimated_actual"`. The central model contains `expected_output_tokens` and an output component with `policy: "estimated_parameter"` referencing that parameter through `limit_parameter`. The value is not sent to the provider; `max_output_tokens` is prohibited in a model using this mode.

The quote returns `settlement: "actual_usage"`, `estimate_only: true`, `overdraft_allowed: true`, `confidence: "modeled"`. `max_units` and `accepted_max_units` are retained for compatibility and in this mode mean the initial estimated reservation, rather than the final charge maximum. The client must honor `estimate_only`, display approximate cost, and disclose the possibility of a negative balance. `price_units` is absent. A fixed `budget` is rejected because its ceiling cannot be guaranteed without limiting generation.

The initial forecast includes the published model's buffer and markup; actual charges include only markup and rounding. A 4096-token forecast does not truncate the answer at 4096. The provider API's own limits and deadline still apply. Reservation estimates user spending; risk limits and execution budgets are stored separately.

## Paid API extension

See the [paid API contract](PAID_API_CONTRACT.md) for provider accounts, usage units, periods, allowance reservations and supported HTTP endpoints.

## Universal call terms

Policy is resolved before reservation: UAI default, selected profile, call parameters. Resulting execution, billing, and file-policy ID enter the snapshot. Installation operational limits cannot raise max_attempts above eight. An invalid override rejects the transaction without reservation. Later activation of another version does not change accepted work.

## Call-list forecast

See [model capabilities](MODEL_CAPABILITIES.md) for embeddings, structured responses, SVG support, limits and example configurations. Publish compatible profiles and configure connection budgets before making real calls.
