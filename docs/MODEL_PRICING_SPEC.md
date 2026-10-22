# Specification: central model catalog and price calculation types

[Contents](README.md) · [Decisions](DECISIONS.md) · [Quoting](QUOTING.md) · [Architecture](ARCHITECTURE.md)

Status: local single-call implementation and acceptance are complete. Evidence and boundaries appear in the [MPC01–MPC16 matrix](ACCEPTANCE_RESULTS.md). Basis: an agreed final price for a specific request and configuration of different calculation methods through admin. Entity and API names below describe the implemented technical contract. This document does not approve buffer percentages, markup, or numerical limits.

## 1. Goal and boundaries

Adding a model on an already supported provider is centralized through admin: request parameters, estimation method, rates, test cases, and publication. Client applications receive settings from the catalog and do not maintain their own model tables or formulas.

Formula is one calculation type. Ordinary token models and prices per image, second, character, or request do not require entering a formula.

Estimated cost, maximum provider financial exposure, final customer price, and actual spending are distinct quantities. A final price does not imply exact cost prediction.

Scope includes catalog, estimator, billing policy, quote/API/SDK, execution, admin, demo, migration compatibility, and checks. Logo Panel integration, production deployment, and automatic model discovery are excluded. A new provider protocol or fundamentally new meter may require adapter or evaluator code.

## 2. Two independent choices

### Model cost estimation method

| Type | Admin form | Use |
|---|---|---|
| `tokens` | Tokenizer, input rules, input/output categories, output estimation policy | Text models; known additional categories are configured separately |
| `per_unit` | Unit, quantity source, step, and rounding rule | Images, seconds, characters, requests; constant call cost is quantity 1 |
| `lookup` | Selection parameters, value rows, result unit | Size × quality; duration × resolution; price or token quantity from a table |
| `formula` | Restricted expression, available fields, result unit, test cases | Unusual dependencies not expressible through a predefined form |

A calculation has one or more named components. Simple mode shows one form; “Add cost component” can combine text tokens, reference processing, and image generation, for example. Each component returns billable quantities or an explicitly typed base monetary cost from a table. Mixing money and quantities without conversion is prohibited.

### Required scenario: output table plus input tokens

An administrator can configure three independent components for one model simultaneously:

| Component | Type | Result |
|---|---|---|
| Output image | `lookup` | Base cost per result by size and quality, multiplied by the permitted result count |
| Input text | `tokens` | Input text token quantity under selected rules, multiplied by the text rate |
| Input references | `formula`, `lookup`, or registered meter | Total input image tokens of prepared files, multiplied by the image input rate |

Total cost equals the sum of these components' monetary results in one settlement currency. Model buffer and markup apply once to the total, followed by final rounding. A table containing monetary cost is not multiplied again by a token rate. Mandatory provider rounding rules, where present, are configured separately from retail rounding.

In “Add cost component,” each component selects its own type, rather than selecting one type for the whole model. Preview shows every row's cost and the total. An administrator must not be required to write a summation formula: the system performs the sum.

Each component declares the expense categories it covers, such as text input, image input, or image output. If a table rate already includes text or references, this is explicit in its coverage; separate rows for the same expenses are prohibited. Overlapping coverage blocks publication. Rates with a limited included input quantity and paid excess require an explicitly supported quantity-splitting scheme; arbitrary overlap is forbidden.

Without attachments, the image input component costs zero. If attachments are permitted but have no method or rate and are not covered by another row, publication is blocked. Input cost is not automatically multiplied by result count: the multiplier follows the actual provider contract.

### Customer charging mode

- `quoted_final`: final price is calculated before launch; a successful result charges exactly that amount.
- `actual_usage`: existing actual authorized spending charges remain for older or explicitly selected rate cards.
- Existing fixed tables remain for compatibility; they are not automatically replaced.

The `tokens` method does not require actual-usage charging. It may supply estimates for `quoted_final`. Charging mode belongs to the rate card/recipe, not the model type.

## 3. Text models without user formulas

The ordinary case uses fields for tokenizer version, message/role/instructions/schema accounting rules, input rate, and output rate. All transmitted context is counted, not only the latest prompt. Protocol overhead differs across APIs; experimental GPT Image constants cannot be transferred to chat.

Future answer length is unknown. For final pricing, an administrator must select an output policy:

- `configured_expected`: a configured profile-length forecast with an explicit enforced maximum;
- `requested_maximum`: estimation from the permitted output limit, understandable but usually more expensive for the customer.

The forecast is not presented as an exact future token count. A short answer does not reduce the final price; a long permitted answer does not increase it. The model executes with the same maximum limit that passed risk estimation.

Cached input, reasoning tokens, paid tools, and additional modalities are separate categories only if the provider actually bills them. Avoid double counting, such as reasoning already included in output. Do not assume a cache hit in the final price without a guaranteed basis. Publication is prohibited if a profile permits a paid tool without estimation rules and bounds.

## 4. Central storage model

Use existing PostgreSQL and catalog versioning infrastructure. Do not create a second independent model list. Recommended shape: relational identifiers and foreign references plus validated JSONB for variable configuration.

| Entity | Contents |
|---|---|
| Model version | Provider, exact model ID/snapshot, capability, adapter, permitted parameter schema, defaults, and limits |
| Method version | Typed calculation components, language/evaluator version, input preparation, tokenizer, bounds, rule source, confirmation level |
| Rate version | Expense category, currency, unit and unit size, rate, applicability conditions, and effective dates |
| Model pricing settings | Separate buffer factor, markup percentage, and rounding for each model; versioned with the catalog |
| Recipe version | Charging mode and reference to a published model |
| Test cases | Input parameters/metadata, expected quantities and cost, expectation source, and tolerance |

`samples` require expected values for all components in `expected`. Optional `tolerance` specifies absolute deviation for individual components; without it, comparison is exact. `expected_cost_usd` checks total cost under the selected rate version; `cost_tolerance_usd` specifies its absolute tolerance. A cost tolerance is prohibited without expected cost. `expected_price_units` checks the final rounded price exactly, including buffer and markup. `source` specifies the origin of a particular expectation; general method provenance is stored separately. Failure of any specified expectation blocks publication.

Decimal values and tolerances are strings. `half_up` rounds halves away from zero: 2.5 → 3, −2.5 → −3. Negative final quantities are prohibited regardless of intermediate rounding.
| Quote snapshot | Versions of all dependencies, specific input, calculated quantities, estimated cost, exposure limit, coefficients, and final price |

Several models may reuse a method. Copying creates an independent draft; editing a shared draft does not change published versions. All published dependencies resolve by exact version, including the provider model where snapshots exist. Floating aliases explicitly display behavior-change risk.

Provider rates do not contain our markup. Following the owner's latest clarification, buffer and markup are configured separately for each model. The catalog stores the method together with a separate pricing block containing safety_factor, markup_percent, and rounding_units. Publishing a catalog version pins both blocks. The recipe specifies charging mode.

Transmit monetary values and monetary coefficients as strings; calculate with integer units/exact decimals or rational numbers, without money floats. Markup is markup on cost, not gross margin; the interface must distinguish them. Rounding follows a documented order and produces reproducible results.

## 5. Advanced formula type

Store normalized typed AST in JSONB, not executable JS/Python/SQL. If admin provides a text editor, it compiles expressions into the same AST. JSON remains an additional mode.

Minimum operations:

- numeric constants, references to permitted parameters and earlier component results;
- `add`, `subtract`, `multiply`, `divide`, `min`, `max`, `ceil`, `floor`, rounding to a step;
- comparisons and `if`, lookup in a versioned table;
- bounded summation over input files;
- calls to registered tokenization operations and verified metadata reads.

Direct access to network, files, database, secrets, and system functions is prohibited. The evaluator receives only prepared typed context. Set limits on AST size, depth, operation count, and collection length. Prohibit circular dependencies. Define half rounding, overflow, missing values, and division by zero. Invalid/negative quantities and unknown rates produce explicit errors, not zero prices.

The formula itself is deterministic. “Empirically validated” refers to correspondence with provider billing, not evaluator arithmetic.

The AST `lookup` operation stores selected parameters, the full combination table, and result unit inside the method version. There is no separate mutable external pointer. Publication checks coverage of finite parameter values and absence of duplicates; arithmetic checks unit compatibility. `tokenize` calls only registered o200k_base/cl100k_base with prompt or messages_json mode. With messages/instructions/schema, prompt mode is rejected to avoid missing context. Tokenization inside file summation is prohibited; an identical call within an expression is evaluated once.

For central methods, publication checks parameters against the registry shared with HTTP adapters. Unsupported tools and unknown parameters are rejected before launch. Paid tool support requires an adapter, usage normalization, and enforceable bounds; arbitrarily adding a catalog parameter does not replace these. The current OpenAI image adapter generates one result, so count with a range above one cannot be published. The table evaluator still supports a multiplier for adapters with a corresponding contract.

In the model card, `identity_kind` specifies snapshot or alias. An administrator selects snapshot only when provider version pinning is confirmed. For alias or unspecified status, the interface warns that behavior and spending may change without a new catalog version. Status is not inferred automatically from the model name's shape.

## 6. Attachment preparation

A quote is calculated after verified file preparation: permitted format, actual dimensions, orientation normalization, resize rules, and count limits. These rules are stored centrally and executed by the backend.

Execution sends the same prepared bytes used for pricing. The quote binds to immutable asset IDs and content hashes, not a mutable URL. Replacing a file or parameters requires a new quote. Align temporary file lifecycle and deletion with existing storage TTLs.

For the initial GPT Image phase, use a limited set of verified reference dimensions. Experiments show that ceil(width/16) × ceil(height/16) is unsuitable for arbitrary large inputs. Do not publish it as universal. Method statuses: `documented`, `empirically_validated`, `approximate`; retain validation scope, date, examples, and limitations alongside them.

## 7. Final price calculation and execution

Order:

1. Validate parameters against the published model schema and prepare input.
2. Obtain quantities from the method and estimated cost from rates.
3. Independently estimate maximum exposure and platform budget availability, including permitted retries/fallback. Without a justified bound, do not label an estimate a guaranteed maximum.
4. Apply billing: estimate × buffer factor × markup factor; convert to the immutable credit unit and round under policy.
5. Save a quote snapshot with final price, TTL, and result/cancellation terms.
6. On confirmation, atomically hold exactly this customer amount. Repeated confirmation is idempotent.
7. For a technically valid available result, charge the agreed amount once. Save actual usage and cost separately for every attempt.

Changes to published rates, billing, tokenizer, or rules do not recalculate an accepted quote. An expired unaccepted quote requires recalculation. Execution uses the accepted snapshot. Separate risk limits may stop work not yet submitted but do not permit silently increasing the price.

The platform pays for technical defects and retries within its budget. The error buffer is not guaranteed coverage for all retries. Cancellation before an available valid result and final failure are not charged in `quoted_final`; cancelling an already successful result does not create an automatic refund. Cancellation/success races are resolved by existing transactional state serialization, not notification delivery order. Unknown outcomes follow existing investigation and the prohibition on late charging after financial closure.

Unknown actual cost does not become zero and is not recalculated from the forecast. Reports show incomplete data. For a successful result, it does not prevent charging the agreed price.

## 8. Admin and client interfaces

Admin remains in English, demo in Russian.

The model card contains Parameters, Cost calculation, Provider rates, and Test cases tabs/sections. The main Calculation type selector switches ordinary Tokens / Per unit / Lookup table / Formula forms. Do not show a formula editor for simple types. Multiple components use a compact expandable list.

Each model card separately edits Safety factor, Markup, and Rounding. Settlement mode is set in the recipe. Do not ask administrators to duplicate provider rates or formulas for each rate card.

The prepublication calculator shows steps: normalized input → quantities → cost → buffer → markup → final price. Validation does not call paid APIs. A separate real-provider test is permitted only as an explicit paid action with separate authorization; publishing does not trigger it automatically.

Publication shows coverage errors, incompatible parameters, unsupported categories, and test results. Copy from existing, version diff, and activation of a new version for future quotes are available. Switching type cannot silently lose another type's configuration.

API/SDK return charging mode and a separate final price, such as `price_units` for `quoted_final`. Old contract fields remain during transition; final price must not be hidden solely under `estimated_units`. Provider cost and internal markup are not automatically exposed to public clients: detailed calculation is available to administrators. Demo displays “Price: X credits,” launch confirmation, and the same final charge.

Actual monetary profit cannot be calculated solely as credits minus provider cost: real revenue depends on credit sale/grant. Admin distinguishes differences in accounting units, platform costs, and monetary profit where external payment-service data exists.

## 9. Compatibility and phases

1. Catalog schema and versioning; predefined tokens/per_unit/lookup types; control cases.
2. Restricted formula evaluator with the same result interface and validation.
3. Billing policies, quote snapshots, existing fixed settlement, API/SDK.
4. Admin, parameter catalog for demo, reference preparation, and adapter edits for supported OpenAI API.
5. New demo profile versions and checks. Do not change old recipes, quotes, reservations, or postings.

Support existing `components[].estimation` and `billing.mode: fixed` through a compatible path or explicit conversion into new drafts. Do not translate published legacy definitions into new semantics on read. Old customer-price tables cannot automatically be renamed provider cost.

The first final-price release covers single_call. Preserve and explicitly label existing behavior for compound operations with unknown future-step inputs. Final pricing for an entire chain requires a separate bounded future-data profile; do not claim it ready in this task.

Implementation must update DECISIONS, QUOTING, catalog/API, OpenAPI, SDK, and acceptance results. Qualify outdated statements requiring actual_usage exclusively and excluding a billing layer by mode. Before implementation, this document is a specification; older sections describe the legacy contract.

## 10. Acceptance criteria

New identifiers do not replace existing A scenarios.

| ID | Check |
|---|---|
| MPC01 | A new text model on a supported API is added through admin without formulas or code edits; input, output, and different rates are calculated separately |
| MPC02 | per_unit checks integer images/requests, duration with a rounding step, and selected character semantics |
| MPC03 | Lookup covers all permitted price combinations; non-price parameters do not multiply rows; ambiguity/missing coverage blocks publication |
| MPC04 | Admin configures output-cost lookup + text tokens + image input calculation; preview shows three costs and their sum; buffer/markup apply once. Checks include no references, one and multiple references, result count, included input, and rejection of duplicate coverage. Formula and predefined types return one typed result |
| MPC05 | Invalid AST, cycles, unknown fields, wrong units, zero division base, and exceeded computation limits are safely rejected |
| MPC06 | Identical versions/input give identical price including rounding; money preserves precision through storage and editing |
| MPC07 | Text forecast policy and enforced output cap are checked separately; unknown future answers are not labeled exactly counted |
| MPC08 | Quote binds to prepared files; changes to bytes, prompt, model, or parameters after quoting cannot launch a different request at the old price |
| MPC09 | Publishing new rates/formula/billing does not change accepted quotes; resubmission does not duplicate charges |
| MPC10 | Success, defect with retry, fallback, cancellation, success/cancellation race, unknown, and late response after financial closure preserve agreed price and financial invariants |
| MPC11 | Concurrent requests and insufficient balance are checked with real PostgreSQL transactions; provider exposure is not replaced by customer price |
| MPC12 | Actual usage, unknown cost, and all attempt costs are retained separately; lower cost does not recalculate final price |
| MPC13 | Legacy actual_usage and fixed tables pass existing checks without changes to earlier postings |
| MPC14 | Browser verifies forms for all four types, multiple components, preview, publication errors, diff, and demo “Price”; ordinary scenarios do not require JSON |
| MPC15 | Control cases for different languages, dimensions, and attachment counts are retained; empirical accuracy scope is visible; accuracy on one sample is not presented as a provider guarantee |
| MPC16 | Publication checks do not call paid models; documentation, OpenAPI, and SDK agree; implemented and deferred parts are listed in the acceptance report |

## 11. Implementation materials

Existing extension points: packages/quoting/src/estimation.ts, packages/quoting/src/fixed-pricing.ts, packages/quoting/src/index.ts, packages/execution/src/index.ts, catalog and rate versions, admin structured editor, and demo profiles. These are guides, not a requirement to preserve the current internal structure.

Results of 15 manual calls are available in the current working session outside the repository. Before using them as regression cases, transfer only anonymized metadata and usage with provenance; do not add credentials, databases, or user images to Git. Record model and method versions; do not present observations as an official guarantee.

## Addendum: text forecasting with actual charges

The new recipe mode `estimated_actual` uses the same central method for forecasting but preserves `pricing` in the accepted route for final usage-based calculation. The `estimated_parameter` output component takes expected length from `expected_output_tokens`; this is not an enforced limit. Support is limited to single OpenAI text.generate. Actual charges apply markup without the safety multiplier. Final image pricing remains separate as `quoted_final`.

The owner permits negative balance only as settlement of an already accepted request. The initial reservation must be backed by available credits. Debt does not alter prepaid lot balances: separate `debt` and `debt_consumed` postings are reconciled with `capture_debts` through a deferred PostgreSQL constraint. Repayment links the amount to the original capture and top-up lot, retaining the ability to refund the paid portion. Detailed product contract: [decision](DECISIONS.md#text-estimation-separate-from-generation-limits).

## Original images

Preparation preserves original JPEG/PNG/WebP bytes by default, including EXIF. Decoding validates the file without writing a new container. `preparation.mode=transform` explicitly enables resize and format; auto_orient permits EXIF rotation only in this mode. Calculation-input dimensions and digest come from transmitted bytes. Exceeding max_edge or violating allowed_dimensions gives explicit rejection when the method does not cover that size. A 1024×1024 table forecast does not permit hidden resizing of an arbitrary original.
