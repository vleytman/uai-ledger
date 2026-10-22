# Implementation and acceptance

[Contents](README.md)

## Current status

The API, PostgreSQL migrations, financial core, workers, scheduler, admin interface, SDK, and independent demo have been created. Local evidence and limitations appear in the [acceptance matrix](ACCEPTANCE_RESULTS.md). Real OpenAI, Serper, and Cartesia runs passed. The owner deferred Anthropic; reporting requires a separate credential. Current Logo Panel logic has not been replaced.

Version 0.3 incorporates discussion Q1–Q21 from [DECISIONS](DECISIONS.md). The main deployment scenario is a separate installation for each owner-operated application, including Logo Panel. The local environment uses separate test data; no production deployment has occurred.

The phases below define implementation scope, and the scenarios remain acceptance criteria. Actual check results are maintained separately in the matrix and reports.

## Immediate scope and preparation

The immediate implementation includes phases 1–5 in full and phase 6a. Logo Panel integration remains separate phase 6b; its absence is explicit in the report. Phase 7 is not considered completed by a local demo.

Before parallel work, establish common API schemas, monetary types, states, errors, events, transaction boundaries, and the provider-adapter contract. Prepare the package skeleton, local PostgreSQL, migrations, CI, fake provider, and controlled clocks for recovery/expiry checks without real waiting.

During the same preparation, create apps/admin and apps/demo skeletons on TanStack Start and packages/ui on shadcn/ui. Prepare visual designs for the overview, operation, and wallet according to [OPERATIONS](OPERATIONS.md). Mockups may use explicitly test data; API connection and functional acceptance are mandatory in later phases.

When using subagents, the coordinator owns shared contracts, migration ordering, and integration. The first wave splits into accounting, providers/pricing, and execution. After checking their contracts, quoting/API, operational modules, and SDK/demo proceed in parallel; interfaces and end-to-end verification follow. Each module has its own tests, while overall acceptance verifies interfaces between modules. A neighboring module's ready stub does not count as end-to-end verification.

## Phase 1. Contracts and financial core

Implement identity scopes, credit unit registry, account/wallet, immutable lots, journal/postings, reservations, claims, grant/refund/revocation, expiry without rollover, account spending suspend/resume, idempotency, and transactional outbox. Create PostgreSQL migrations and typed error/monetary models. Separate customer reserve, provider exposure, and a bounded platform loss budget. Account for already expired lots during admission and balance reads without depending on timely scheduler execution.

For now, use a fake provider and synthetic prices. Do not make real requests to verify postings.

Deliverable: concurrent operations cannot create negative balances or duplicate grants, lot history is preserved, and balances can be reconstructed from the journal. Financial APIs are protected by separate scopes.

## Phase 2. Catalog, pricing, and adapters

Implement ModelVersion, Connection, RouteVersion, RateCardVersion, normalized usage, cost entries, and price validation. Initial integrations must demonstrate different usage schemes rather than merely different model IDs in one API.

Recommended sequence: text OpenAI API, text Anthropic API, OpenAI images, then Cartesia and Logo Panel's paid search integrations. This order does not confirm key or commercial-endpoint availability. Choose real model IDs according to current documentation and account access.

Each adapter ships with saved anonymized fixtures for successful responses, caching, errors, incomplete usage, rate limits, and unknown outcomes. Documentation rates are not hardcoded in workers.

Deliverable: the same application API accepts different providers, and calculations reflect their own usage semantics. An unknown format does not create zero cost.

## Phase 3. Queue, workers, and results

Implement durable requests/attempts, leases/fencing, rate-limit groups, dispatcher, provider exposure claims, budget claims, native-job polling, storage, and SSE.

Add cancellation, reconnect, and technical validation before ready. Apply the common accepted policy: four attempts by default, maximum eight, overall deadline 300 seconds; extended recovery is disabled by default. Defective content does not use extended recovery; unknown forbids automatic retry. Deadline and budget may stop attempts before the upper limit. A worker failure between dispatch and response persistence has a separate scenario.

Add a result manifest, acknowledgement after application persistence, short TTL, purge queue, project tombstones, and protection against late recovery of deleted content. Financial closure of unknown cost or delivery failure occurs after one hour. Early incident events are created here; operator-channel delivery is added in phase 5.

Deliverable: restarts cannot cause blind retries of paid calls, ready results are available through GET, and duplicate webhooks cannot cause double capture.

## Phase 4. Action quoting

Implement a bounded recipe format, input schemas, estimate/max, quote expiry, version pinning, operation acceptance, amend, and validation of actual requests against components.

Start with actual_usage and successful_parts. The 2026-09-19 supplement implemented fixed mode for selected components with separate provider cost; all_or_nothing is disabled. Define single calls and the composite “description → image” action for the demo. Logo Panel action boundaries based on its engine are refined in phase 6b. Add built-in single-call recipes and atomic POST /invocations without requiring a custom recipe. Composite actions retain explicit quote/operation/component boundaries.

Deliverable: the application can obtain quotes for a round, image batch, and registered SVG operation; the total stays within the agreed maximum. Unknown cost returns pricing_unavailable.

## Phase 5. Admin interface, reconciliation, and notifications

Complete styled apps/admin on TanStack Start and shadcn/ui, including visual and browser acceptance from [OPERATIONS](OPERATIONS.md). Implement all pages and actions, provider snapshots, reconciliation runs, incidents, notification rules, and webhook delivery.

Check read-only provider reports with available permissions. A missing endpoint or administrative credential appears as a limitation of the specific connection rather than being hidden behind an empty report.

Deliverable: an operator can publish new prices, see their effect, inspect the queue, expand provider costs by attempt, and see discrepancies and low balances. Notifications do not duplicate on every polling cycle.

## Phase 6a. SDK and test application

Finalize OpenAPI, release a typed SDK, and implement apps/demo on TanStack Start with shadcn/ui. Use separate client data and persistent storage; perform all UAI operations through the SDK. Check fake providers first, then agreed real connections with a limited budget.

Minimum interface:

- Streaming chat, image generation, and published model-profile selection.
- Composite “prepare description → generate image” action to verify the shared maximum and successful_parts.
- Estimate and maximum spending before launch; a card per step showing status, charge, and remaining balance after completion.
- Persistent available/reserved block and spending history. The balance comes from UAI; events trigger refresh considering wallet revision, and the browser does not compute authoritative balances itself.
- Action budget separately from known provider limits with source/freshness. Unknown limits are explicit; remaining generation count is not presented as an exact promise.
- Expandable details: model, attempts, usage/cache, provider cost, customer charge, platform-funded cost, and waiting reason. Access is limited to the test account and its permissions.
- Simple “Number of credits → Grant to myself” form using a real grant. Backend limits, idempotency, and disabling outside test environments are specified in [ARCHITECTURE](ARCHITECTURE.md).
- Cancellation, reconnect, conversation history, and result recovery after reload without new generation. Persistence before acknowledgement and content deletion are checked through the SDK.

Deliverable: an independent client performs text and image requests, shows budget changes at each step, and retains results after UAI's temporary copies are deleted. Grants appear in the journal and admin. Demo verification does not replace testing Cartesia, search, and other phase-2 adapters.

## Phase 6b. Logo Panel integration, later scope

Integrate Logo Panel through remote adapters after phase 6a. Use separate data and fake providers first, then agreed real checks.

Deliverable: Logo Panel product scenarios run through the new platform while preserving history, response streaming, participant management, images, and speech. The application saves results in its own storage, then acknowledges transfer and calls content deletion when deleting a project. The application stores no provider credentials for managed API mode. A second fake client connects to a separate installation without core changes.

## Phase 7. Operational readiness

Verify database/file recovery, isolation, integration tokens, absence of secrets in output, and budget reservations across multiple workers. Establish short content TTL, minimum financial archive/backup retention, RPO/RTO, real price cards, incident-handling owners, and operator risk limits. Check separate keys and conservative allocation of shared provider quota across installations. Apply tombstones and expiry before reopening the API after restore.

The payment service remains a separate integration. Its absence does not prevent platform checks using administrative grants, but this mode is not declared a launched commercial subscription.

## Logo Panel migration

Source paths in this section refer to the separate Logo Panel project. Its code is not included in UAI; these structural references are retained as migration context rather than files in this repository.

Integration points were confirmed against current source code. Old README and IMPLEMENTATION files may describe earlier execution details, so implementation must recheck source and rendered behavior.

| Current location | Migration action |
|---|---|
| `server/providers/contracts.ts` | Create remote implementations; transfer asset IDs and save results locally before acknowledgement |
| `server/providers/codex.ts` and `server/providers/codex-stream.ts` | Preserve an explicitly separate local subscription mode; add managed API mode |
| `server/providers/images.ts` | Move network calls and usage capture to the platform adapter; price calculation to Pricing |
| `server/providers/search.ts` and `server/providers/serper.ts` | Move paid calls and accounting; retain application filters and result presentation |
| `server/speech.ts` | Separate provider synthesis from playback ownership and speech sequencing |
| `server/engine.ts` | Retain orchestration, prompts, role state, and product validation; replace provider job execution |
| `server/applications.ts` | Send generation through common operations, preserving use-case versions |
| `server/store.ts` | Store references to external operations; remove responsibility for the authoritative credit balance |
| `server/app.ts` and `shared/types.ts` | Remove hardcoded provider literals from managed mode; add profiles and quote flow |
| `server/index.ts` | Connect SDK/remote adapters through server configuration |

Switching sequence:

1. Record baseline product behavior and back up local data.
2. Add remote adapters behind an explicit configuration mode. Only one backend handles each call.
3. Perform shadow calculation on already received usage. Shadow means comparing calculations, not duplicating paid requests.
4. Check a separate test project through the new platform.
5. Switch new operations to the platform. Existing operations retain their owner until completion.
6. Remove provider credentials from the application for managed mode.

Historical jobs may be imported for analytics with source=legacy and their original precision. They do not become new wallet captures. Do not automatically charge credits for old work or present calculated amounts as confirmed invoices.

In the current Store, deleting a project deletes its jobs. After migration, financial records reside in the platform and do not cascade-delete with the project. Project content and files still follow the product's deletion functionality.

Codex subscription usage remains a separate category if that mode is retained. It receives no fictitious API cost and does not automatically spend managed purchased credits. Switching to paid text API is an explicit user/admin mode.

## Acceptance matrix

| ID | Scenario | Required result | Requirements |
|---|---|---|---|
| A01 | Two identical purchase events | One lot and one grant | R09, R12 |
| A02 | One external reference with different amounts | Conflict, no second effect | R09 |
| A03 | Two operations simultaneously reserve the same entire balance | Only a permissible amount succeeds | R10 |
| A04 | Several requests use one reserve | Claims and captures total no more than max | R06, R10 |
| A05 | New-package price changes | Existing lots' budgets remain unchanged | R12 |
| A06 | Attempt to change the credit unit after a grant | Change forbidden | R12 |
| A07 | A package expires during an active reservation | Completion remains allowed; released remainder expires | R09, R10 |
| A08 | Refund of an already expired package | Linked refund lot for the compensation term, initially 30 days; original monthly remainder is not extended | R09, R12 |
| A09 | Repeated refund | No amount above the original capture | R09 |
| A10 | Purchase revocation races with a request | Credits are either blocked by revocation or reserved, without double use | R09, R11 |
| A11 | Monetary refund has an unknown outcome | Revocation is not blindly released by timer | R11 |
| A12 | Amounts near a rounding boundary | Exact units preserved and allocations equal | R02, R09 |
| A13 | OpenAI-style inclusive cache usage and Anthropic-style exclusive usage | Correct independent formulas | R02 |
| A14 | Cache writes with different TTLs and cache reads | Corresponding rates applied | R02, R05 |
| A15 | Reasoning included in output | No duplicate charge | R02 |
| A16 | Duplicate and cumulative usage events | Consumption not summed again | R02 |
| A17 | Missing usage or rate | Unknown/pricing_unavailable, without invented zero | R02, R05 |
| A18 | Schema or file-persistence error after successful generation | Provider cost preserved independently | R02 |
| A19 | Price changes after quote | Accepted maximum protected; new requests pause if necessary | R05, R06 |
| A20 | Unexpectedly long context or extra pass | Refusal/amend, no silent overrun | R06 |
| A21 | Three of four images ready | Results and financial status of each unit preserved | R06, R09 |
| A22 | SVG generation requires corrections | Recipe validation and cost limits not exceeded | R06 |
| A23 | Transient 429 with Retry-After | Job waits, worker slot free | R07, R08 |
| A24 | 429 due to billing quota | Connection blocked, no endless retry | R04, R08 |
| A25 | Two models share provider quota | Shared limiter accounts for both | R08 |
| A26 | Several keys on one account | No artificial capacity multiplication | R08 |
| A27 | Permitted failover without cache | Result within capabilities and budget | R06, R08 |
| A28 | Fallback lacks image input/schema support | It is not selected | R01, R08 |
| A29 | Timeout after possible dispatch | Outcome_unknown, no automatic second generation | R02, R08 |
| A30 | Worker dies after dispatch | Lookup of the same job or unknown | R07 |
| A31 | Lease expires and old worker returns | No second commit/capture | R07, R09 |
| A32 | User reconnects SSE | Snapshot/result available, generation not repeated | R01, R02 |
| A33 | Cancellation before and after dispatch | Distinct correct settlement scenarios | R09, R10 |
| A34 | Unknown remains unresolved for one hour | Disputed reservation closes without late debit; exposure preserved, release from an expired lot goes to expired | R02, R10 |
| A35 | Late result after financial closure | No new automatic debit | R09 |
| A36 | Provider report delayed or uses another scope | Incomplete/discrepancy, no false precision | R03 |
| A37 | Provider account includes external spending | Unattributed cost, no customer allocation | R03 |
| A38 | Balance API unsupported | UI distinguishes manual budget from provider balance | R03 |
| A39 | Low balance persists for several polling cycles | One incident, bounded notification retries | R04 |
| A40 | Provider recovers | Recovery event, correct route reopening | R04, R08 |
| A41 | Two administrators edit pricing | Revision conflict, no lost changes | R05 |
| A42 | Application key attempts to grant credits/read another account's request | Access denied, no data leak | R01, R09 |
| A43 | Project deleted | Content deleted, minimum financial journal preserved | R02, R09 |
| A44 | Backup restore and outbox replay | Balance matches; events cause no duplicate effects | R02, R09 |
| A45 | New application uses different recipes | Connects without core-code changes | R01 |
| A46 | Retail discounts and bonus packages | Unit provider cost unchanged; margin calculated externally | R11, R12 |
| A47 | Complete races with request creation | Request either atomically accepted before closure or rejected; released reservation not reused | R07, R10 |
| A48 | Revocation prepared but not yet confirmed | Amount visible in reserved and unavailable to AI operations | R09, R11 |
| A49 | Model becomes cheaper after quote acceptance but before dispatch | Lower applicable amount passes savings to the user | R05, R12 |
| A50 | Invalid SVG/JSON or corrupt image, then a valid response | Platform pays for defective attempts; user pays only for the valid attempt | R02, R06, R09 |
| A51 | User dislikes a valid result | Capture retained; a new variant needs new authorized spending | R06, R09 |
| A52 | Final discussion part fails | Successful preceding parts charged under successful_parts | R06, R09 |
| A53 | Model errors exhaust accepted max_attempts | Request failed; no hidden extra cycles or model disablement for one input | R02, R08 |
| A54 | Confirmed temporary unavailability | Retry bounded by overall max_attempts, deadline, backoff, and explicit recovery delays | R07, R08 |
| A55 | One hundred jobs wait simultaneously for a broken route | Quotas and limits bound dispatches; each request retains its own overall attempt limit | R07, R08 |
| A56 | Worker loses lease or is canceled during retry | Fence forbids stale writes; unknown outcome does not authorize new dispatch | R07, R08 |
| A57 | Overall attempt limit exhausted | Request ends with release; unrelated requests are not blocked by one request's exhaustion | R04, R08, R10 |
| A58 | Free health endpoint succeeds after hard lock | Paid calls do not resume without manual enable | R04, R08 |
| A59 | Success only on fallback | History stores actual model; fallback success does not change primary for future requests | R07, R08 |
| A60 | Restart or new incident during retries | Total no greater than accepted max_attempts and absolute limit 8; counters do not reset | R07, R08 |
| A61 | Short deadline or insufficient loss budget | Recovery ends before maximum; customer reservation is not multiplied by retries | R06, R08, R10 |
| A62 | Retries below the widespread-incident statistical threshold | Finite retry and failover create no hidden extra recovery cycles | R04 |
| A63 | Cost known, result cannot be delivered due to our error | Release or refund after one hour; known provider cost preserved | R02, R09, R10 |
| A64 | Lookup/worker restart near the one-hour deadline | unresolved_at does not move; financial closure idempotent | R02, R09, R10 |
| A65 | Monthly package expires, scheduler delayed | Balance and reserve immediately exclude expired available funds; new period carries no remainder | R09, R12 |
| A66 | Application saves the entire result and acknowledges manifest | Content no longer available; purge completes; amount and metadata remain | R01, R02 |
| A67 | No acknowledgement before content expiry | Content deleted; previously available valid result remains billable; no new generation | R01, R09 |
| A68 | Repeated acknowledgement or different result version | Repeat safe; mismatch returns conflict and does not delete another version | R01 |
| A69 | Project deleted during native job, late webhook, or restore | Tombstone prevents content restoration; financial settlement continues | R01, R02, R09 |
| A70 | Outbox/idempotency replay after content deletion | Does not return old prompts/results; preserves resource ID and current delivery status | R01, R02 |
| A71 | Single-call invocation repeated or SDK crashes | One reserve, operation, and request; no reservation without accepted work | R01, R06, R10 |
| A72 | Built-in estimate above client max_credits | Budget conflict before dispatch; no charge or provider cost | R06, R10 |
| A73 | SDK cannot persist result | No acknowledgement; recovery available until expiry without repeat generation | R01 |
| A74 | Purchase refund prepared; reconcile_after elapsed | Incident created, hold not released without commit/cancel | R09, R11 |
| A75 | Payment-service suspend during execution | No new admission/dispatch; unsent work canceled, active work accounted for; resume does not revive jobs | R09, R11 |
| A76 | Calculator overestimates or late discount received | Calculator error compensated once; discount does not rewrite closed captures | R02, R03, R05, R09 |
| A77 | Requote_required and user chooses finish-partial | Unsent requests canceled; completed results preserved until TTL; active work settles | R06, R07, R10 |
| A78 | Two separate installations use one provider account | Separate keys and local budgets; shared snapshot not presented as local balance, quota not multiplied | R01, R03, R08 |
| A79 | Corrupt result's cost cannot be isolated from a shared image batch | Single-unit mode selected before dispatch; no arbitrary proportional charge | R02, R06, R09 |
| A80 | New job accepted while route availability is limited | Initial waiting and overall immutable deadline bound queueing; quota wait creates no dispatch | R07, R08 |
| A81 | Defect on the last permitted attempt | Overall limit forbids a new dispatch; history and cost preserved | R02, R08 |
| A82 | Execution succeeded but usage unknown or subsidy present | Platform risk closes through settlement; uncovered/unknown portion not released prematurely | R02, R10 |
| A83 | Output asset passed as next request's input | Rejected before dispatch; after separate upload, new input independent of old-result acknowledgement | R01 |
| A84 | Admin and demo built on selected stack | TanStack Start and shadcn/ui, shared theme; interfaces use API/SDK without direct UAI database writes | R01 |
| A85 | Desktop and narrow-screen presentation | Navigation, tables, long values, loading, empty/error states, and keyboard access checked against OPERATIONS | R01, R05 |
| A86 | User submits the same test grant twice | One grant/lot, journal and balance refreshed; backend validates amount, scope, reason, and expiry | R09 |
| A87 | Test grant called outside test environment or without permission | Server refusal, wallet unchanged; privileged token absent from browser | R01, R09 |
| A88 | Chat and image pass through demo | Estimate, maximum, reserve, charge, and balance reflect API; preliminary values and unknown limits explicit | R02, R06, R10 |
| A89 | Description ready, image generation fails | successful_parts, overall maximum respected, completed text saved; platform retains cost of defective attempts | R02, R06, R09 |
| A90 | Demo reloads after result persistence or loses SSE | Waiting continues using existing IDs; acknowledge only after persistence, no new generation or charge | R01, R09 |
| A91 | Demo conversation deleted after result transfer | Client content deleted, UAI temporary-content deletion requested; minimum financial journal preserved | R01, R02 |

## Verification strategy

The monetary core is tested for invariants and concurrency on real PostgreSQL. Provider fixtures verify normalization and calculations without paid calls. Fault injection checks durable-write, external-dispatch, result-persistence, and capture boundaries.

Contract tests verify adapters, OpenAPI, and SDK. The UI is checked in a browser against real test-environment resources: pricing drafts, wallet history, queue states, reconnect, and incidents. Static components alone do not confirm functionality.

Small real provider checks run only in the selected environment with an authorized budget. Reports distinguish fixture, integration, and real checks, checked models/connections, and reporting-access limitations.

## Completion criterion

For the immediate scope, phases 1–5 and 6a pass corresponding A scenarios, including A84–A91; the report explicitly leaves phases 6b and 7 incomplete.

For the entire platform, every R01–R12 is covered by implementation and corresponding A scenarios. Each enabled adapter has recorded supported capabilities and real limitations. No open defect permits duplicate charges, negative available balances, uncontrolled paid retries, or cross-account access.

One ready text proxy does not mean the platform is ready. Missing models/financial APIs/operational checks are explicitly listed in the final report rather than considered complete because an interface exists.

## Decisions before operational launch

Select infrastructure, real providers/model routes, numeric technical-loss budgets, access to provider admin APIs, minimum financial archive retention, and operator notification channels. Published user terms must reflect already agreed rules for cancellation, defects, successful parts, one-hour financial closure, package expiry, and brief content transfer. Proposed numeric content-TTL and compensation-lot settings appear in DECISIONS; do not hide them in implementation.

Supporting a specialized SVG provider requires choosing a specific method and checking its price. The documentation does not declare any method already connected.

At this stage, selecting retail rates, connecting a payment gateway, and migrating all applications simultaneously are unnecessary.

## Paid API extension

The PA-I01 contract, measurement units, periods, allowance reservations, and compatibility boundaries are described in the [paid API contract](PAID_API_CONTRACT.md). Implementation status and stable PA-A01–PA-A25 scenarios appear in the [plan](PAID_API_PLAN.md). A draft contract does not confirm the availability of new HTTP handlers.
