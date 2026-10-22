# Plan for Paid API and Provider Allowance Support

[Contents](README.md) · [Decisions](DECISIONS.md) · [Accounting](ACCOUNTING.md) · [Execution](EXECUTION.md)

Date: 2026-09-22. Status: PA-I00–PA-I08 implemented and verified in a local installation; PA-A22 confirmed by real Firecrawl calls on 2026-09-23. [PA-I00 design and acceptance](FILE_CONFIGURATION.md). Product decisions below were chosen by the owner. Technical design and phase order are implementation proposals. This document does not establish integration or production readiness.

## 1. Goal

Route ordinary paid APIs through the same operations, wallets, quotes, reservations, queue, and financial history as AI. Support per-call prices, formulas, and attachment charges; account for provider rate limits and monthly packages; display tariff status and send warnings through the existing notifications mechanism.

Provider cost, customer price, allowance usage, and call-frequency restrictions are different quantities. One call may consume one request, several provider credits, and several documents while having an independent customer price.

## 2. Agreed Product Decisions

| ID | Decision |
|---|---|
| PA-D01 | The first version accounts for AI/API provider allowance. User subscription limits are outside scope. |
| PA-D02 | Package-exhaustion behavior is selected per tariff: stop, or permit paid overage with a monetary limit. Overage is disabled by default. |
| PA-D03 | Tariff terms are entered manually; local usage is supplemented by provider reconciliation when a suitable API exists. |
| PA-D04 | A package belongs to a provider account and may span multiple connections, keys, and operations. |
| PA-D05 | A tariff may contain multiple independent counters, each with its own limit. One call may consume several counters. |
| PA-D06 | Calendar months and months from subscription date are supported, with time zone and tariff renewal date. |
| PA-D07 | Unused balance rollover is enabled according to provider terms; disabled by default. Rollover has a cap and expiry. |
| PA-D08 | Owner clarification: service definitions and complex configurations live in Git. The admin visualizes them without editing. This replaces the previous decision to configure integrations through UI. |
| PA-D09 | Provider cost inside a paid package may count only incremental costs or an allocated package cost. Select the method per tariff; do not count the subscription fee twice. |
| PA-D10 | Customer price may derive from provider cost with markup or be set independently as a fixed amount or formula. The choice belongs to the operation. |
| PA-D11 | An operation uses a final price before launch or charges actual volume within a maximum agreed in advance. |
| PA-D12 | Allowed file types are defined per operation. Basic measurements are count and size; processors add pages, duration, and other characteristics. |
| PA-D13 | Warnings appear in the UAI admin and are delivered by webhook. The application determines email, Telegram, and user-notification recipients. |
| PA-D14 | Separate limit shares are allocated to UAI installations. A shared installation coordinator is outside the first version. |
| PA-D15 | New ordinary APIs in the first version retrieve and process data. Sending SMS, creating orders, and changing external records are outside scope. |
| PA-D16 | UAI adapters connect synchronous and deferred calls. Obtaining job_id, polling, webhook handling, and state normalization belong to UAI. The application submits a request, receives SSE, restores current state, and retrieves the result without provider-specific logic. |
| PA-D17 | Notifications include configurable balance thresholds in percentages and units, exhaustion, and period renewal. Exhaustion-date forecasting is deferred. |
| PA-D18 | When statistics are unavailable, calls continue within the local balance. Data is marked stale and a warning is sent; failure neither increases balance nor resets usage. |
| PA-D19 | Acceptance includes Serper, a test API with files and errors, AI compatibility, and a new Firecrawl integration. |
| PA-D20 | Firecrawl includes ordinary scrape and search, USPTO patent search through Alexandria, and patent-document retrieval. |
| PA-D21 | The application controls the research chain. UAI neither selects patents nor starts independent multi-step research. |
| PA-D22 | With exhausted allowance and forbidden overage, a new request is rejected before financial reservation. The response gives the reason and renewal date when known. Waiting for a short rate limit remains queued. |
| PA-D23 | The admin retains full service cards, rate tables, formula breakdowns, calculator, recipe components, and routes. File definitions show the active published version and provenance. Raw JSON does not replace these views. Operational settings remain editable in the admin. |

Existing AI rules, including explicitly permitted `estimated_actual` for OpenAI text, remain in force. PA-D11 neither cancels old modes nor permits debt for new APIs. Provider allowance rollover in PA-D07 does not change user credit-lot expiration rules in [ACCOUNTING](ACCOUNTING.md).

## 3. Verified Original Implementation

| Area | Reused | Extension required |
|---|---|---|
| [Provider contracts](../packages/providers/src/contracts.ts) | Adapter, usage, attempts, outcome classification | Closed AI-capability list, text input, fixed `LimitUsage` metrics |
| [Providers](../packages/providers/src/index.ts) | Serper as an existing paid tool | API-operation adapter registry and Firecrawl |
| [Pricing](../packages/pricing/src/index.ts) | Decimal arithmetic, arbitrary dimension/unit in billable items, rate versions | Separate representation of tariff package, subscription fee, and calculated cost allocation |
| [Model pricing](../packages/model-pricing/src/index.ts) | `per_unit`, `lookup`, `formula`, safety, markup, rounding | Document/page/byte/credit units, actual measurements, independent customer formula |
| [Asset preparation](../packages/quoting/src/prepare-model-assets.ts) | Ownership and content-hash checks, image preparation | Shared file path without mandatory sharp transformation |
| [Provider quotas](../packages/queue/src/quota-create.ts) | Shared groups, admission rules, concurrency | Arbitrary registered metrics; monthly allowance as a separate mechanism, since current windows are limited to one day |
| [Reconciliation](../packages/reconciliation/src/index.ts) | Balance snapshots, provenance, data freshness | Nonmonetary-counter reconciliation tied to tariff period |
| [Notifications](../packages/notifications/src/index.ts) | Rules, incidents, cooldown, outbox, signed webhooks, retry delivery | Allowance signals, resource/metric filters, event content |
| [Monitors](../packages/runtime-operations/src/index.ts) | Periodic observation and incident recovery | Balances in credits/requests/pages; existing snapshot low-balance calculation is limited to USD |
| [Catalog publication](../packages/catalog/src/index.ts) | Version publication, dependency and pricing-example validation | Shared file publication tool, provenance, preview, and prohibition of a second editing source |

Existing pricing, model-pricing, notifications, and monitor tests were run for analysis: 51 passed, 9 PostgreSQL checks skipped. This is a baseline check, not acceptance of new functionality or verification of configured notification delivery.

## 4. Proposed Design

### 4.1. Service and Operation Catalog

Add a versioned service-operation description with AI or API kind, input/output schemas, allowed files, measurement, pricing, and execution rules. AI models connect to the shared model gradually; mass renaming of existing keys is unnecessary.

Separate identities: a provider account owns the package; a connection provides access; an operation defines a call and measurements; a tariff defines period terms. A provider account is not a client `account_id` or UAI wallet.

Proposed file split: JSON with schemas for model/service definitions, allowed parameters, calculation components and formulas of the existing engine, rates, safety, markup, verification examples, recipes, and route templates. Tariff templates and allowance rules also use JSON. Do not create a separate complex programming language for provider protocols.

TypeScript modules implement request/response, authentication details, usage normalization, errors, safe retries, submit/job_id/polling/webhook, and specialized file processors. Shared HTTP helpers may support query, JSON, form, and multipart, but a new API does not require a universal builder for all protocols. JSON references a registered adapter; arbitrary JSON code is not executed.

The adapter and validated file settings determine the endpoint; the connection selects the credential reference. Clients send only published-operation parameters. Check destination addresses and redirects, bound response size and time, and exclude secrets from logs and quotes. The operation contract defines success: HTTP 200 with an error body is not a billable successful result.

Proposed process: files → schema, reference, and example validation → diff preview → immutable database-version publication. Execution reads the published snapshot, rather than a mutable disk file. Publication and activation are separate: creating a new version alone neither switches the active profile nor changes accepted operations.

The shared publication tool uses current CatalogService and recipe checks instead of separate demo setup scripts. It resolves logical references into dependency versions and installation bindings, validates everything before switching the active bundle, and returns the same result when the same content is republished. Deleting a file does not delete published history. A single configuration change must not leave an active profile mixing old and new dependencies.

Version provenance includes path, Git revision, content hash, schema version, publication author, and linked versions. Pin a compatible implementation version for TypeScript adapters: a price snapshot does not automatically pin executable code. Worker updates must preserve support for accepted operations or wait for their completion.

Define field ownership before implementation. Files own definitions and templates. Database/UI-editable data includes connections and secret references, selection/binding of published configurations, enable/disable, budgets, installation quota share, concurrency, specific subscription parameters, notification thresholds/recipients, and current operational data. A binding selects an allowed version or connection without creating a hidden formula or rate copy. Import does not overwrite operational settings. One parameter is not independently editable in Git and UI; for migrated profiles this prohibition applies to backend APIs too, rather than buttons alone.

### 4.2. Measurements, Files, and Price

Use a shared measurement registry with unit, source, allowed range, rounding, and acquisition time: before dispatch or after response. Do not equate calls, provider credits, and attachments. An operation rule explicitly defines which measurements consume allowance and which contribute to price.

The server determines the count and size of actually accepted files. Store identifiers, hashes, and calculation-required metadata in the quote; do not store content in financial records. Page and duration measurements come from a trusted processor, rather than arbitrary client fields. An unknown measurement is not replaced with zero. First-version acceptance must cover file count and size; specific additional processors ship with the service requiring them.

Examples of allowed rules, not real provider prices:

```text
price = call_price
price = call_price + attachment_count × attachment_price
price = processed_page_count × page_price
price = ceil(record_count / block_size) × block_price
```

Price version, measurements, limits, and rounding rules are fixed in the accepted quote. New publication does not recalculate accepted work. API monetary values are strings; calculation uses existing exact arithmetic.

When allocating package cost, fix the method and denominator for the period and display calculated costs separately from actual provider payment. For tariffs with several independent counters, define an explicit allocation basis: one subscription fee cannot be fully allocated to each counter and then summed. Customer price may be nonzero when incremental provider cost is zero.

### 4.3. Tariff, Periods, and Allowance Ledger

Proposed entities: provider tariff version, provider-account subscription, period, measured limit, allowance allocation/rollover, reservation, confirmed usage, reconciliation adjustment, and provider snapshot. The ledger lives in PostgreSQL; Redis remains a recoverable short-rate-limit mechanism.

For each counter:

```text
available = current-period allowance
          + valid rolled-over balance
          + confirmed adjustments
          − confirmed usage
          − open reservations
```

One SQL transaction checks and reserves all required counters together with the user's financial reservation. Failure of any condition rolls back admission entirely. A preliminary quote does not guarantee the current balance remains available until acceptance.

A period has exact boundaries; a subscription start date does not become a fixed 30 days. Proposed rule for days 29–31: use the last available day of a short month while retaining the original calendar anchor for the next. Acceptance fixes a specific period; the worker rechecks its validity before dispatch. If waiting crosses a period boundary, unused allowance moves atomically between reservations without changing customer price. If the new period cannot admit the work, the request closes without dispatch and releases unused financial reservation.

Rolled-over allocations retain provenance and expiry. Proposed consumption order: earliest-expiring balance first. A closed period is not zeroed with UPDATE; the new period is created idempotently. Changing a tariff or installation share does not erase old usage or open reservations.

For permitted overage, store separate rates and a monetary limit per provider-account period in this installation. Rates and limit must be known before admission; an empty limit does not mean infinity. When overage is prohibited, exhaustion of any required counter blocks a new request before money is reserved.

Usage unknown before execution requires a conservative maximum or a provider-enforced work limit. A forecast does not guarantee a hard ceiling. Without such a bound, configuration must not promise no overruns; publication of a hard-cap mode is rejected. Existing AI exceptions remain and are explicitly shown as estimates. Unexpected confirmed usage above the reservation is recorded in full, reduces availability, opens an incident, and does not authorize charging the customer above the accepted maximum.

### 4.4. Execution, Retries, and Reconciliation

Use existing operation/request/attempt, leases, fencing, durable queue, result, and ACK. Admission combines period allowance, monetary overage limit, rate limits, and concurrency. PostgreSQL and Redis have no shared transaction: extend existing admission intents and recovery rather than assuming two-store atomicity.

For an asynchronous provider, UAI stores the remote job_id, performs observation itself, and publishes normalized SSE events. Application reconnection reads current status and resumes events; it does not start a new provider job. Losing SSE does not stop observation, and result retrieval does not require LogoPanel to know the polling endpoint, provider token, or webhook format. This observes one job, rather than the independent multi-step researcher excluded by PA-D21.

Replaying a client command returns the original result. A real new attempt may consume provider allowance again even when it is not charged to the customer. Define error, cancellation, and retry usage for each adapter. Do not count internal upstream provider requests as separate UAI calls unless its tariff works that way.

For an uncertain outcome, a new paid call is forbidden without evidence of safe retry. The one-hour deadline for closing the customer's monetary dispute remains; releasing the customer's reservation does not establish zero provider usage. Uncertain allowance usage is conservatively retained until reconciliation or an audited decision, separately from the customer's monetary reservation.

Snapshots are reconciled by provider account, metric, period, and coverage time. Do not assign `remaining` directly over local dispatches after the snapshot. Preserve discrepancies and adjustments without rewriting history. Stale or out-of-order data does not increase availability. If the API reports no coverage time or has unclear lag, show the balance as estimated; automatic increases require sufficient confirmation.

Distinguish the provider account's full balance from the current installation's share. Overall statistics must not subtract local usage twice. Warn about limited reliability when external usage is unknown; no absolute multi-installation total-limit guarantee is claimed without a coordinator.

### 4.5. Notifications and Tariff Metrics

Extend the current mechanism without creating a second dispatcher. Proposed new signals:

- `allowance.low`: balance below a threshold in units or percent;
- `allowance.exhausted`: available package exhausted;
- `allowance.renewed`: a new period begins;
- `usage.snapshot_stale`: statistics freshness expired;
- `allowance.discrepancy`: material reconciliation discrepancy;
- `overage.budget_low` and `overage.budget_exhausted`: state of permitted monetary overage.

Exact names are proposals. Threshold warnings and period renewal are agreed; discrepancy and overage signals supplement technical control of already selected rules. Rate-limit settings and waiting must be visible in tariff metrics; usage forecasting is outside this phase.

A rule defines resource, metric, comparison operator, unit, threshold, recipients, and cooldown. For percentages, explicitly define the basis, including rollover. Events include limit, used, reserved, remaining, unit, period, renewal date, source, and freshness. Available-balance calculation includes reservations; the interface separately shows actual usage.

Deduplication includes rule, provider account, counter, period, and threshold. Crossing a threshold creates an event, recovery closes the incident, and a new period permits a new warning. `allowance.renewed` is an event rather than a perpetual alarm incident.

Administrative metrics and webhooks are not exposed to ordinary account-scoped tokens. UAI reports provider state; the application determines who receives a user notification. A separate snapshot API returns current metrics independently of webhook delivery success. SSE may update an authorized administrative screen.

### 4.6. Admin and SDK

Preserve visual AI screens and add API-operation views with parameters, input/output examples, measurements, rate tables, formula breakdowns, and calculator. For file configurations this is a published-snapshot view with provenance and version comparison; editing happens in Git. The calculator allows changing test inputs without changing the price definition. Recipes and routes are displayed as understandable composite structures, rather than JSON alone. A fixture-check button does not call the provider; a real check must be visibly distinct.

The tariff screen shows provider account, connections, period, installation share, every counter and reservation, rollover with expiry, overage, reconciliation freshness, rate limits, and related warnings. The UI distinguishes file templates from editable specific-subscription parameters. Operational settings remain in the database with revision and audit, including wallets, queue, reconciliation, and incidents. The admin remains in English according to [DECISIONS](DECISIONS.md); documentation is maintained in English under the [2026-10-22 decision](DECISIONS.md#documentation-language-2026-10-22).

SDK proposal: add neutral service-call methods over existing invocations/quotes/requests while preserving `ai.*` as a compatible interface. Do not move provider credentials to the client. Allowance errors contain a stable code, blocking metric, and `resets_at` when known; do not suggest endlessly creating new operations. Accepted idempotent replays continue returning their prior state even after package exhaustion.

## 5. Firecrawl: Verified Integration Points

Checked on 2026-09-22 against official documentation and the Alexandria UI. No paid requests were executed. Recheck this information before adapter implementation; tariffs are not permanent UAI core constants.

| Operation | HTTP | Details |
|---|---|---|
| Page scrape | `POST https://api.firecrawl.dev/v2/scrape` | Ordinary URL and selected extraction parameters |
| Web search | `POST https://api.firecrawl.dev/v2/search` | Query, result limit, separate cost of additional scrape options |
| Patent search | `POST https://api.firecrawl.dev/v2/scrape` | `alexandria.provider=uspto-gov`, `capability=intellectual-property/patent_search` |
| Patent document | `POST https://api.firecrawl.dev/v2/scrape` | `alexandria.provider=uspto-gov`, `capability=intellectual-property/patent_document` |
| Balance and period | `GET https://api.firecrawl.dev/v2/team/credit-usage` | `remainingCredits`, `planCredits`, `billingPeriodStart`, `billingPeriodEnd` |

Example search body, without calling the service:

```json
{
  "alexandria": {
    "provider": "uspto-gov",
    "capability": "intellectual-property/patent_search",
    "options": {
      "query": "\"quantum computing\".ti.",
      "page_size": 5,
      "start": 0
    }
  }
}
```

Patent search uses a BRS query and returns a result page and `next_start`. The UI describes a limit of 1000 documents for anonymous search. Patent retrieval accepts a number or guid and may include full text. At inspection time, both patent operations displayed 5 Firecrawl credits per call; this is a UI observation, not confirmation of actual charges or an immutable price. Pin workflow version and billing terms in the adapter/profile where the API permits; do not assume a UI version can be passed through an arbitrary API field.

For UAI these are separate operations with different input schemas, even when the HTTP endpoint is identical. The application controls pagination, document selection, and call order. Discovering available Alexandria tools with `sources=["alexandria"]` does not replace executing patent search; automatic discovery of every tool is not required for first acceptance. The mechanism must allow registering other permitted Alexandria capabilities without changing the financial core.

Documentation confirms shared team rate limits across its API keys. Firecrawl balance is stored in provider credits, separately from UAI credits. The difference between two overall snapshots does not establish a specific call's price when concurrent or external usage exists. For each operation, check the confirmed-usage field, success and error responses, surcharge options, and absent usage.

The official Alexandria implementation describes `x-request-id`, completed-response replay, and the uncertain `request_unresolved` outcome. During implementation, check applicability to the hosted API and each operation; do not extend an Alexandria guarantee to ordinary scrape/search without separate confirmation. In UAI the ID links to the stored attempt and body hash.

Sources:

- [Alexandria](https://docs.firecrawl.dev/features/alexandria).
- [Scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape).
- [Search](https://docs.firecrawl.dev/api-reference/endpoint/search).
- [Credit usage](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage).
- [Rate limits](https://docs.firecrawl.dev/rate-limits).
- [Billing](https://docs.firecrawl.dev/billing).
- [Alexandria implementation](https://github.com/firecrawl/firecrawl/blob/main/apps/api/src/controllers/v2/scrape-alexandria.ts) and [request identity description](https://github.com/firecrawl/firecrawl/blob/main/apps/api/src/services/alexandria/README.md).

## 6. Implementation Order

Proposed order after the Git clarification: a small shared preparatory phase, then new APIs and allowance, then complete migration of remaining configurations. After PA-I00 completion, the owner authorized continuing the entire remaining plan without stopping between phases; file definitions and a visual admin have already been chosen. Full migration of every AI profile is not a prerequisite for Firecrawl.

In the preparatory phase, define JSON/TypeScript/operational-database boundaries, reference and provenance formats, shared validate/preview/publish, and file-managed profile viewing. Demonstrate the path on one existing AI profile with its rates, recipe, and route. The format anticipates API operations and future tariff templates, but allowance accounting, all adapters, and migration of the entire catalog are outside this phase.

Building APIs before this phase is risky: configuration, publication, and UI would need reworking. Fully migrating configurations before the first API is also risky: the shared format would not be tested on new operations and monthly tariffs. A small working publication path provides this foundation without blocking all work on migration.

| Phase | Work | Completion condition |
|---|---|---|
| PA-I00. File publication | Ownership boundaries, JSON schemas, TS adapter registry, validate/preview/publish, version provenance, and read-only visualization. One existing AI profile completes the whole dependency path. | Republication is idempotent; UI cannot change file definitions; operational settings survive; old accepted work executes on its own terms. |
| PA-I01. Contracts | Align schemas for operations, measurements, tariffs, periods, reservations, reconciliation, and events. Update ARCHITECTURE, ACCOUNTING, QUOTING, EXECUTION, API/OpenAPI, OPERATIONS, and acceptance matrix. | An unambiguous path from input and files to price, allowance, and result; existing financial invariants preserved. |
| PA-I02. Allowance accounting | New additive migrations, period ledger, reserve/settlement/release, rollover, overage, manual adjustment, and snapshots. | Transactional tests for concurrency, retries, month boundaries, unavailable statistics, and recovery. |
| PA-I03. Universal operation | API catalog, new measurements, files, independent prices, conservative maxima, quote expansion. | A test service settles through the same financial core; old AI quotes and prices remain unchanged. |
| PA-I04. Execution | TypeScript adapters and shared HTTP helpers, provider-account binding, allowance admission, short quotas, intents and recovery; asynchronous observation and SSE remain in UAI. | No external dispatch without full admission; no duplicate charge or unsafe retry after failure; the application does not implement provider protocols. |
| PA-I05. Firecrawl and Serper | Four Firecrawl operations, balance reconciliation, usage/error normalization; adapt existing Serper to the shared model. | Contract fixtures cover endpoints, pagination, credits, timeout, missing usage, and paid options. |
| PA-I06. Notifications, API, and SDK | New observations and rules, payload, snapshot API, webhook, compatible SDK methods and scopes. | Notifications are isolated by resource/period; redelivery does not repeat effects. |
| PA-I07. Admin | Visual cards for file AI/API configurations, rates, formulas, calculator, recipes, and routes; editing operational tariff/counter/reconciliation, rate-limit, and notification settings. | Aside confirms file-version visualization and provenance, calculator operation, preserved operational settings, and revision conflicts. |
| PA-I08. Acceptance and migration | Move remaining active definitions into the shared file process preserving history; remove duplicate editing/setup paths. Full set below, generated API, builds, documentation, separate real-integration report. | Local and real evidence are separated; omissions listed; file definitions have one owner; no mandatory omission is marked successful. |

Phases describe the full extension scope. PA-I01–PA-I08 execution is authorized. Real paid calls require separate agreement on inputs and budget. Before execution, check exact table and migration names against current HEAD; do not rewrite applied migrations.

## 7. Acceptance Criteria

| ID | Check |
|---|---|
| PA-A01 | Fixed per-call price, parameter formula, multiple attachments, bytes, and rounding produce the expected charge. The client cannot substitute measurements. |
| PA-A02 | Independent customer price and provider cost with markup work separately; subscription fee and allocation do not double the total. |
| PA-A03 | Actual charging is bounded by the accepted maximum; missing usage does not become zero. Excess provider usage does not create an unauthorized customer charge. |
| PA-A04 | Concurrent requests consume the last balance without double admission. Failure of one of multiple counters rolls back every new reservation. |
| PA-A05 | Multiple connections of one account share allowance; a new key does not create a new package. Other accounts and organizations remain isolated. |
| PA-A06 | Month changes, days 29–31, time zones, scheduler replay, delayed renewal, and late responses neither lose usage nor duplicate allocation. |
| PA-A07 | Rollover is disabled by default; when enabled, its cap, expiry, and balance provenance are honored. The old period remains in history. |
| PA-A08 | Stop and permitted overage follow the tariff; the monetary overage limit includes concurrent reservations. |
| PA-A09 | A new exhausted request is rejected before money or dispatch. Replaying a previously accepted command returns the original result. |
| PA-A10 | A short rate limit causes waiting with a finite deadline. Crossing a period while waiting does not use expired allowance. |
| PA-A11 | Failure between SQL, Redis, and HTTP recovers through intents. Unused admission is released; possibly used admission is not declared free. |
| PA-A12 | Errors, cancellation, technical retries, and outcome_unknown account for provider usage separately from customer payment; callback/usage replay is idempotent. |
| PA-A13 | Unavailable or stale statistics preserve local control; snapshots account for period, external usage, and local calls after coverage. |
| PA-A14 | Percent/unit thresholds, exhaustion, recovery, and period renewal produce correct events, cooldown, and retry delivery without repeated effects. |
| PA-A15 | Administrative metrics and provider details are inaccessible to another organization or an ordinary customer account-scoped token. |
| PA-A16 | A registered TS adapter executes a published file configuration with files; unsafe destinations/redirects, unsupported parameters, and error bodies do not bypass constraints. JSON executes no arbitrary code. |
| PA-A17 | Firecrawl scrape, search, patent_search, and patent_document have separate parameters, usage, and pricing profiles. Pagination does not hide additional calls. |
| PA-A18 | Firecrawl reconciliation accepts credit-usage fields, distinguishes provider and UAI credits, and does not derive request price from overall balance changes. |
| PA-A19 | Serper and existing AI adapters preserve behavior; old catalog/quote versions are not recalculated; AI receives new allowance metrics when a tariff is explicitly connected. |
| PA-A20 | Aside confirms visual cards, rate tables, formulas, calculator, recipes/routes, and provenance without file-definition editing; operational settings remain editable, and multiple counters and incidents are displayed. |
| PA-A21 | Clean databases and existing-database upgrades pass new migrations; typecheck, relevant PostgreSQL/Redis tests, OpenAPI, builds, and docs:check succeed. |
| PA-A22 | A separate real Firecrawl run verifies all four operations' availability and observed usage on an agreed input set. Required access and budget are determined before launch; fixtures do not replace this result. |
| PA-A23 | The shared publisher validates schemas, references, and pricing examples, shows a diff, creates no second version for identical content, and leaves no partially activated bundle. UI/API cannot change file-managed fields or overwrite them independently. |
| PA-A24 | An asynchronous test adapter returns job_id; UAI completes observation after worker restart and SSE disconnection. The application receives current state and result without new submit or provider-specific requests. |
| PA-A25 | New publication, binding changes, and TS adapter updates do not change accepted-operation terms. Provenance and old snapshots remain available; import does not reset installation operational parameters. |

Skipped integration checks do not count as completed. Do not use private provider responses or user files as Git fixtures. Local tests require synthetic data; real-run reports include only safe identifiers, statuses, quantities, and financial totals.

## 8. Transition and Limitations

New tariffs connect explicitly. For an existing connection, absence of a new tariff preserves previous configuration rather than inventing unlimited allowance. The admin marks such a connection as not connected to package accounting. A published new API operation must explicitly define allowance mode: a limited package or no such provider restriction.

Migration does not recreate wallets, change UAI credit value, or rewrite usage and postings. Disabling new profiles stops new acceptance but retains settlement, result retrieval, and reconciliation for accepted attempts. Open reservations prohibit destructive tariff-binding changes without a defined transfer or work completion.

During transition, explicitly marked legacy DB-managed and file-managed profiles are allowed, but one profile cannot have two independent owners. Migration proceeds by profile: export/reconcile content, publish a version with provenance, check prices and dependencies, switch binding, disable old editing. Active metadata, including display names, receive an explicit owner; the old rename endpoint cannot bypass file-managed mode. Secrets and installation-specific values are not exported to Git. The shared publisher gradually replaces one-off demo scripts while preserving fixture reproducibility.

Scope excludes user subscriptions, a shared installation coordinator, exhaustion forecasting, an independent researcher, external CRUD/SMS, a visual asynchronous workflow builder, and the entire Firecrawl catalog. Website crawl is unnecessary for the agreed patent scenario. Preparing the plan alone authorizes neither deployment nor paid calls.


## 9. Implementation Status as of 2026-09-23

PA-I00 is complete. PA-I01–PA-I07 are implemented and verified locally. PA-I08 includes prepared export of all 20 local profiles, atomic adoption, migrations, UI, and regression acceptance. The primary local demo's 20 profiles were migrated and activated with a backup and checks that connections/wallets remained unchanged. PA-A22 completed after separate approval of up to 50 credits: 8 successful Firecrawl calls spent 26 credits, including 4 calls through the demo. Real checks are summarized in [provider checks](REAL_PROVIDER_CHECKS.md).
