# Model catalog and pricing methods

[Contents](README.md) · [Quoting](QUOTING.md) · [Architecture](ARCHITECTURE.md)

Define how a model's cost is calculated, choose how customers will be charged, then publish the pricing profile. Set safety factors, markup, and limits for your installation. The values in examples are starting points, not mandatory policy.

## 1. Goal and boundaries

For an already supported provider, configure the model's request parameters, estimation method, rates, and test cases centrally, then publish it. Client applications read the catalog instead of keeping their own model tables and formulas.

Most models don't need a formula. Use the standard fields for token pricing or prices per image, second, character, or request. Reserve formulas for calculations those forms cannot express.

Treat estimated cost, maximum provider exposure, final customer price, and actual spending as four different amounts. Agreeing a final price does not mean you can predict the provider cost exactly.

The catalog connects estimation and billing with quotes, API/SDK calls, execution, and the admin interface. Models are configured explicitly; discovery is not automatic. A new provider protocol or fundamentally new meter may require adapter or evaluator code.

## 2. Two independent choices

### Model cost estimation method

| Type | Admin form | Use |
|---|---|---|
| `tokens` | Tokenizer, input rules, input/output categories, output estimation policy | Text models; known additional categories are configured separately |
| `per_unit` | Unit, quantity source, step, and rounding rule | Images, seconds, characters, requests; constant call cost is quantity 1 |
| `lookup` | Selection parameters, value rows, result unit | Size × quality; duration × resolution; price or token quantity from a table |
| `formula` | Restricted expression, available fields, result unit, test cases | Unusual dependencies not expressible through a predefined form |

Build a calculation from named components. Start with one form, then use “Add cost component” when the model bills for several things, such as text tokens, reference processing, and image generation. Each component returns billable quantities or an explicitly typed base monetary cost from a table. Convert between quantities and money explicitly; never add them together as if they were the same unit.

### Required scenario: output table plus input tokens

An administrator can configure three independent components for one model simultaneously:

| Component | Type | Result |
|---|---|---|
| Output image | `lookup` | Base cost per result by size and quality, multiplied by the permitted result count |
| Input text | `tokens` | Input text token quantity under selected rules, multiplied by the text rate |
| Input references | `formula`, `lookup`, or registered meter | Total input image tokens of prepared files, multiplied by the image input rate |

Total cost equals the sum of these components' monetary results in one settlement currency. Model buffer and markup apply once to the total, followed by final rounding. A table containing monetary cost is not multiplied again by a token rate. Mandatory provider rounding rules, where present, are configured separately from retail rounding.

Choose a type for each component in “Add cost component,” not one type for the whole model. Preview shows each row's cost and adds the total for you. You don't need a formula just to sum the rows.

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

The output forecast predicts length; it does not know the future token count. With final pricing, a shorter answer doesn't reduce the price and a longer permitted answer doesn't increase it. Execution uses the same maximum limit that passed the risk check.

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

Models can share a method. Copy one to make an independent draft; editing a draft leaves published versions alone. Each published dependency is pinned to an exact version, including the provider model when snapshots exist. Floating aliases carry an explicit risk of behavior changes.

Provider rates do not contain our markup. Configure buffer and markup separately for each model. The catalog stores the method together with a separate pricing block containing safety_factor, markup_percent, and rounding_units. Publishing a catalog version pins both blocks. The recipe specifies charging mode.

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

For GPT Image, use only dimensions covered by the pricing method’s validation. The formula ceil(width/16) × ceil(height/16) is unsuitable for arbitrary large inputs. Do not publish it as universal. Method statuses: `documented`, `empirically_validated`, `approximate`; retain validation scope, date, examples, and limitations alongside them.

## 7. Final price calculation and execution

Order:

1. Validate parameters against the published model schema and prepare input.
2. Obtain quantities from the method and estimated cost from rates.
3. Independently estimate maximum exposure and platform budget availability, including permitted retries/fallback. Without a justified bound, do not label an estimate a guaranteed maximum.
4. Apply billing: estimate × buffer factor × markup factor; convert to the immutable credit unit and round under policy.
5. Save a quote snapshot with final price, TTL, and result/cancellation terms.
6. On confirmation, atomically hold exactly this customer amount. Repeated confirmation is idempotent.
7. For a technically valid available result, charge the agreed amount once. Save actual usage and cost separately for every attempt.

Accepted quotes keep their saved rates, billing, tokenizer, and rules. If an unaccepted quote expires, calculate it again. Separate risk limits can stop work that hasn't been submitted, but can never silently raise the accepted price.

The platform pays for technical defects and retries within its budget. The error buffer is not guaranteed coverage for all retries. Cancellation before an available valid result and final failure are not charged in `quoted_final`; cancelling an already successful result does not create an automatic refund. Cancellation/success races are resolved by existing transactional state serialization, not notification delivery order. Unknown outcomes follow existing investigation and the prohibition on late charging after financial closure.

Unknown actual cost does not become zero and is not recalculated from the forecast. Reports show incomplete data. For a successful result, it does not prevent charging the agreed price.

## 8. Admin and client interfaces

Admin remains in English, demo in Russian.

The model card contains Parameters, Cost calculation, Provider rates, and Test cases tabs/sections. The main Calculation type selector switches ordinary Tokens / Per unit / Lookup table / Formula forms. Do not show a formula editor for simple types. Multiple components use a compact expandable list.

Each model card separately edits Safety factor, Markup, and Rounding. Settlement mode is set in the recipe. Do not ask administrators to duplicate provider rates or formulas for each rate card.

Before publication, use the calculator to follow normalized input → quantities → cost → buffer → markup → final price. Validation makes no paid API calls. A real-provider test is a separate paid action that needs explicit authorization; publishing never runs it automatically.

Publication shows coverage errors, incompatible parameters, unsupported categories, and test results. Copy from existing, version diff, and activation of a new version for future quotes are available. Switching type cannot silently lose another type's configuration.

API/SDK return charging mode and a separate final price, such as `price_units` for `quoted_final`. Read the final price from its dedicated field rather than treating `estimated_units` as a final price. Provider cost and internal markup are not automatically exposed to public clients: detailed calculation is available to administrators. Demo displays “Price: X credits,” launch confirmation, and the same final charge.

Subtracting provider cost from wallet credits does not tell you monetary profit. That also depends on how the credits were sold or granted. Admin shows differences in accounting units and platform costs separately; monetary profit needs data from the external payment service.

## Addendum: text forecasting with actual charges

The new recipe mode `estimated_actual` uses the same central method for forecasting but preserves `pricing` in the accepted route for final usage-based calculation. The `estimated_parameter` output component takes expected length from `expected_output_tokens`; this is not an enforced limit. Support is limited to single OpenAI text.generate. Actual charges apply markup without the safety multiplier. Final image pricing remains separate as `quoted_final`.

Negative balances are permitted only when settling an already accepted request. The initial reservation must be backed by available credits. Debt does not alter prepaid lot balances: separate `debt` and `debt_consumed` postings are reconciled with `capture_debts` through a deferred PostgreSQL constraint. Repayment links the amount to the original capture and top-up lot, retaining the ability to refund the paid portion. See [estimated-actual charging](QUOTING.md#estimated-text-billing-estimated_actual).

## Original images

Preparation preserves original JPEG/PNG/WebP bytes by default, including EXIF. Decoding validates the file without writing a new container. `preparation.mode=transform` explicitly enables resize and format; auto_orient permits EXIF rotation only in this mode. Calculation-input dimensions and digest come from transmitted bytes. Exceeding max_edge or violating allowed_dimensions gives explicit rejection when the method does not cover that size. A 1024×1024 table forecast does not permit hidden resizing of an arbitrary original.
