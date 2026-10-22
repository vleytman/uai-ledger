# Discussion decisions

[Contents](README.md)

Version 0.3 preserves answers to Q1–Q17 and adds Q18–Q21 decisions on interfaces and the immediate development scope. This is the product contract. Verified local implementation status is described in the [acceptance matrix](ACCEPTANCE_RESULTS.md).

## Compatibility before first launch, 2026-09-25

The owner clarified that UAI and LogoPanel are developed in parallel and will enter service simultaneously. Before the first joint launch, backward compatibility with earlier APIs, SDKs, configuration formats, or local implementation behavior is not required. Affected parts are updated together. Legacy branches, adapters, extra format versions, or transition modes should not be created solely for such compatibility. This clarification overrides earlier recommendations to preserve old interfaces during development.

In particular, switching to original-image delivery by default does not require a separate compatible mode for earlier automatic preparation. Transformations must be explicitly enabled; LogoPanel prepares the required dimensions itself. Preserving the earlier request format is not an independent condition of this change.

The absence of a backward-compatibility requirement does not remove financial idempotency, separation of provider cost and customer charges, or the prohibition on automatically retrying unknown outcomes. This entry records a development decision; it does not claim that image-preparation changes are already implemented.

## Agreed with the owner

| Question | Decision | Consequence |
|---|---|---|
| Q1 | Owner-operated projects only; a separate installation for each | Shared codebase, independent runtime and data; public SaaS is unnecessary |
| Q2 | Choose a simple integration method | Single call through API/SDK with an internal standard recipe; a custom recipe is optional |
| Q3, Q5 | We pay for technical model defects | Invalid SVG, corrupt files, and violations of specified structure do not consume credits; subjective dissatisfaction with a valid result does not trigger automatic refunds |
| Q4 | Calculate from published rates | Late provider discounts do not recalculate wallets; calculator overcharging is corrected through compensation |
| Q6 | Simple charging for successful parts is acceptable | v1 selects successful_parts; whole-action-only charging is deferred |
| Q7 | Overall UI-D02 limit: four attempts by default, maximum eight | Route changes do not reset the counter; early success completes the request |
| Q8 | Separate installation keys | Keys are not presented as independent provider limits or balances |
| Q9 | UI-D03: long recovery disabled by default | Explicit finite delays use the shared attempt limit |
| Q10 | Do not automatically retry unknown outcomes | First lookup or continued original-job observation; a new call requires explicit risk authorization |
| Q11 | Cancellation after submission is charged | Confirmed active-attempt spending is charged within the maximum; earlier defective attempts remain platform expenses |
| Q12 | Long recovery only for temporary unavailability | Defective content does not trigger three additional cycles; invalid keys and missing funds require intervention |
| Q13 | Job waits in the background with cancellation | Client sees the reason, next attempt, and deadline; the application may choose a shorter duration |
| Q14 | Final lock is removed manually | A free check does not automatically enable new generation; independent routes continue |
| Q15 | Close disputed reservations after one hour | Includes unknown usage and inability to deliver results; closed amounts are not automatically charged later |
| Q16 | Lots must have expiry, including monthly lots without rollover | Payment service supplies period end; remainder expires while financial history is retained |
| Q17 | AI service retains content briefly for delivery only | Application saves the result permanently and acknowledges delivery; temporary copies are then deleted |
| Q18 | Admin uses shadcn/ui; both interfaces use TanStack Start | Shared components and theme in packages/ui; API, workers, and financial core remain independent |
| Q19 | Visual design is part of acceptance | Before mass page construction, prepare shell, overview, operation, and wallet; check responsiveness, accessibility, and data states |
| Q20 | Build a separate test client before Logo Panel | Immediate scope: phases 1–5 and 6a; chat, images, compound action, costs, and balances through SDK |
| Q21 | Test client permits self-granted credits | Form calls a real grant through a protected backend; enabled only in test environments, with no browser key exposure |

## Addendum 2026-09-19

At the owner's direct instruction, the entire apps/admin interface is translated into English. No Russian version or language switcher is needed. This includes navigation, forms, statuses, errors, loading states, aria-labels, page title, dates, and amount formatting. User data, connection names, and previously saved audit records are not translated. Demo and documentation remain in Russian.

At the owner's request, demo also allows setting an exact available balance to test insufficient credits. Adjustment is available only in the test environment: increases use grants, decreases revoke available credits, and financial history is preserved. Adjustment is rejected when reservations are open.

At the owner's request, rate cards have a separate `display_name`. It may change after publication without changing rates, technical key, version number, or recipe references. The name belongs to a specific version and is copied into a new-version form; without a name, the interface displays the technical key.

At the owner's request, a general quantity estimator was added for tokens, images, seconds, characters, and requests. Forecast and maximum reservation are separate. Rules and rates are bound to published versions; new logic is enabled for new recipe versions. Numeric assumptions about answer length and headroom are settings, not guaranteed spending. See [estimation rules](QUOTING.md).

## Selected settings and technical clarifications

These details are proposed to implement agreed rules. They are not presented as numerical values literally approved by the user.

- The earlier 16 attempts are replaced by the shared UI-D02/UI-D03 policy: four by default, maximum eight, including the first. Default overall duration is 300 seconds from acceptance.
- During an outage, one recovery lease controls checks of the affected scope. The queue does not launch separate paid checks for each job.
- Delivery acknowledgement means durable result storage by the application, rather than merely HTTP 200. It authorizes content deletion and is not a condition for charging an already available valid result.
- Proposed ready-result TTL without acknowledgement: 3 600 seconds from ready_at, configurable before operation acceptance. It is independent of the agreed one-hour financial investigation period. Multi-day retention by default is excluded.
- Compensation for captured spending after original-lot expiry creates a 30-day refund lot. This is the initial compensation policy proposed under Q16; its duration was not discussed separately. It does not roll over unused subscription credits. Policy is fixed in terms before grant and does not change retroactively.
- expires_at is required in grant: a timestamp sets expiry; explicit null means no expiry. Monthly subscriptions supply the specific period end rather than a universal “30 days.”
- Dedicated keys may use a shared provider account. Without a central coordinator, each installation receives a conservative share of total quota and spending. Shared-quota changes require configuration updates.

## First-version boundaries

A constant credit unit, immutable lot terms, and a separate payment service remain the model's foundation. The first version has no public platform-client registration, cross-installation wallets, arbitrary workflow language, or guarantee of an aesthetically suitable result.

At the owner's 2026-09-19 request, fixed charging for successful results was added for selected components. Cancellation without a delivered result is not charged. Price parameters are separated from other model settings. Markup remains in the billing layer; examples are created without an additional percentage multiplier. All_or_nothing is not enabled. Semantic refinement of a valid result is new paid work; technical defect repair belongs to bounded recovery at platform expense.

Hosting, specific models, numerical loss budgets, external notification channels, and financial archive retention remain deployment settings. They are mandatory before production. They do not require revising credit and execution rules.

## Planned pricing development

The owner selected a final price for a specific request, calculated before launch from estimated costs, a separate error buffer, and rate-card markup. The model is stored centrally; the method is selected from predefined types, with formula as an advanced type. An [implementation specification](MODEL_PRICING_SPEC.md) was prepared. The local implementation for explicitly connected new single-call profiles passed acceptance. Legacy actual_usage, fixed tables, and accepted quotes are not recalculated. Exact percentages and text-answer-length forecast policy remain explicit settings.

Owner clarification for central pricing: the error buffer and markup percentage are configured separately for each model and pinned by the published catalog version. They are stored in pricing separately from methods and provider rates. A recipe selects the charging mode and published model.

For the updated local demo, the owner selected a 10% buffer and 100% markup for each of seven models. Final price equals estimated costs × 1.1 × 2, rounded in accounting units. Images allow ten aspect ratios across three resolution levels and all explicit qualities. Exact dimensions are bounded by API capabilities. These values apply to new demo versions, not old quotes or baseline settings of all installations.

## Text: estimation separate from generation limits

At the owner's instruction, demo text models use `estimated_actual`: default `expected_output_tokens` of 4096 is used only for forecasting. UAI sends neither this parameter nor `max_output_tokens` to OpenAI. Provider limits and the operation deadline apply. The mode is currently intended for single OpenAI text requests.

The forecast uses the central method with a 10% buffer and 100% markup. The forecast amount is reserved at launch. Final charge uses actual normalized usage at accepted rates with model markup and rounding; the error buffer is not applied to actual spending. The forecast is not a charge ceiling. An explicit fixed budget is incompatible and rejected.

The owner explicitly authorized a negative balance when actual spending exceeds reservation and available credits. Settlement uses reservation, then free credits, then records debt through separate postings. Prepaid lots do not become negative. Top-ups and released credits first repay debt; new operations with unpaid debt are rejected. A refund first cancels the unpaid portion of its charge, then returns paid credits. A duplicate event does not charge again.

This exception to the earlier maximum rule applies only to new `estimated_actual` profiles. Final-price images, legacy actual_usage, and accepted quotes retain their terms.

## Unified product and UAI admin

The owner selected a reusable structure: UAI can be connected to another owner-operated application and built into one admin with product settings and financial sections. Product modules connect at build time; UAI does not depend on LogoPanel entities. Current administrative entry remains installation-owner access. Moving modules does not constitute integration of a specific product, user roles, or external payment acceptance. See the [integration contract](MODULAR_ADMIN.md).

Owner clarification: LogoPanel's regular-user frontend is completely separate from the administrative build. Shared admin includes only UAI and product administration with settings and payments. Shared UAI changes must propagate from one source repository; product code copies are not an integration mechanism. Source integration through a pinned Git submodule with verifiable updates has been prepared.

## Backpressure before financial reservation

The owner approved initial limits: 20 waiting jobs per user, 200 per application. If the application's oldest waiting job has waited 15 minutes or longer, new operations are temporarily rejected. The check runs before creating or increasing reservation and counts not-yet-created requests in accepted multistep operations. Repeating an accepted idempotent command returns its earlier result. These limits neither cancel accepted work nor replace provider concurrency or quotas.


## External authorization and teams

The owner approved a general server adapter independent of the product's login system. Better Auth is planned for LogoPanel, but its integration, registration, sessions, invitations, and memberships are implemented separately in the parent. One person with a permanent user ID may belong to several teams. Email is not the key. Each team maps to a separate UAI account and shared wallet; there are no personal wallets in this integration.

The parent checks the session, current membership, and product permissions. Team levels are cumulative: view; view and chat; view, chat, and generation. A project role may expand the general role. Members see the available shared balance and spend it only through permitted product actions. A team administrator manages members and permissions but receives no service admin access. Application staff have separately assigned `admin` or `viewer` roles.

AI chat, artifacts, researcher, approver selection, request/round/project permissions, and notifications belong to LogoPanel. UAI does not contain these entities. Verified server-to-server identity restricts service-token scope and enables personal audit. Accepted tasks continue at the original team's expense after a member is removed; team switching, background retries, and late results do not change the payer. Refunds belong to the original charge. Old history cannot be assigned to a new person.

The local implementation is described in the [integration contract](EXTERNAL_AUTH.md) and [acceptance matrix](ACCEPTANCE_RESULTS.md). It is not actual LogoPanel or Better Auth integration or a production deployment.

## Paid API extension plan, 2026-09-22

The owner selected shared execution and accounting for AI and ordinary paid APIs. Agreed PA-D01–PA-D23 decisions, proposed phases, and acceptance criteria are recorded in the [paid API and allowance plan](PAID_API_PLAN.md). The owner authorized continuing PA-I01–PA-I08 after [PA-I00](FILE_CONFIGURATION.md). The local implementation and boundaries are described in the [plan](PAID_API_PLAN.md); on 2026-09-23, the owner separately authorized real Firecrawl calls up to 50 credits and an interactive demo. Real acceptance completed with 26 credits spent. Accepted terms of existing work are preserved.

The first version accounts for provider packages, groups connections sharing an account, supports multiple counters, monthly periods, and configurable rollover. User subscription limits remain outside scope. Provider allowance rollover does not imply rollover of user credit lots. New APIs support fixed pricing or actual charging within the accepted maximum; the existing estimated_actual exception for OpenAI text remains separate.

Owner clarification replaces the earlier choice of configuring integrations through admin: service definitions and complex configurations live in Git; admin retains full visualization without editing them. Operational settings are editable in the database. Proposed split: JSON with schemas for data, formulas, and templates; TypeScript for adapters, provider protocol, and file processing. A shared validation, preview, and publication process creates an immutable database version with provenance. One parameter does not have independent Git and UI editors. The preparatory phase is authorized separately. Work stops after its local acceptance; API integrations and migration of remaining configurations remain later plan phases.

UAI receives an async provider's job_id, performs polling/webhook handling itself, and informs the application through SSE. LogoPanel retains request submission, status display, reconnection, current-status reads, and result retrieval. The adapter integration method does not move provider-specific logic into LogoPanel.

Firecrawl includes scrape, search, USPTO patent search through Alexandria, and patent-document reading. The application controls the research chain. Notifications are delivered to admin and through webhook. When allowance is exhausted without authorized overage, a new request is rejected before monetary reservation; short rate limits are still handled by the queue.

## Universal invocations, 2026-09-25

The [universal invocation plan](UNIVERSAL_INVOCATION_PLAN.md) is being implemented. UI-D02/UI-D03 replace earlier Q7/Q9: default overall duration 300 seconds from acceptance, four attempts including the first, absolute installation limit eight. Long recovery is disabled by default and uses the same counter when enabled. Original-job observation and financial reconciliation of unknown spending remain independent of retries.

The owner separately confirmed the default model-refusal charge policy `refused=platform`. An authorized profile policy may specify `actual_usage`; refusal remains terminal and does not permit bypass through another model.

## LogoPanel follow-ups dated 25.09.2026

Agreed LF-D01–LF-D13 are implemented in the [follow-up contract](LOGOPANEL_FOLLOWUP_INTEGRATION.md). New Quiver SVG profiles use `actual_capped`: token billing does not allow overdraft. List forecasting is a read without financial reservation; its range is not a cap. The embedding aliases revision remains unknown. Initial interactive headroom is 1 slot while retaining at least one possible background slot; settings do not imply a latency promise.


## Jev, 2026-09-26

The owner instructed implementation of the [Jev plan](JEV_IMPLEMENTATION_PLAN.md). Local integration uses api.call, direct TypeSafe transport, typed questions, and actual_capped with cost_plus, factor 1, and markup 0. All JSON API services return a structured manifest with value and text. Low confidence is a successful result. Following the owner's “set it to 32k” clarification on 2026-09-26, the reservation and quota maximum is 32768 input tokens, cap 1376256 units. This is a selected UAI constraint, not a confirmed provider billable maximum. Actual cost exceeding it is retained in full and is not charged to the customer above the cap. The file profile is active, live_validation=not_run; this decision removes the original block pending maximum proof. There was no separate authorization for paid acceptance or changes to active connections. See the [contract](JEV.md).

## LogoPanel requests dated 20.10.2026

The owner instructed completion of two LogoPanel requests. This changes the earlier exclusion of shared reservation from the follow-up plan.

**Reservation for compound work.** The application opens a reservation pool: a `kind=pool` quote with single-call profiles, each profile's call limit, and an overall limit. The quote budget is held on operation acceptance. Calls are created as work proceeds through `POST /v1/invocations` with the pool's `operation_id`. Each is estimated as an ordinary call of its profile and takes its claim from the pool reservation. Profile versions are pinned when the pool opens. Reservation guarantees funds but does not cap charges. If a call claim does not fit the remaining pool, the shortfall comes from free credits, as for a call without a pool. Without free credits, the call is rejected and pool state is unchanged. `estimated_actual` spending beyond the claim is covered first by the pool reservation's free portion, then free credits or debt. Closing the pool releases the remainder after all calls settle. A pool cannot be amended, and `POST /operations/{id}/requests` does not work in it. See [quoting](QUOTING.md#reservation-for-compound-work).

**Quiver spending without cache breakdown.** If a Quiver response has neither `cached_tokens` nor `cache_write_tokens`, all input is rated as cache write, the highest input rate in Quiver rate cards. Spending becomes known, the attempt is priced, and `breakdown` records `input_cache_split=absent_priced_as_cache_write`. This is a conservative bound, not Quiver's exact price. A response containing only one counter or contradictory counters remains unknown.

## Documentation language, 2026-10-22

The owner requested that all documentation in the UAI Ledger repository, including README.md, AGENTS.md and generated API descriptions, be maintained in English. This supersedes earlier documentation-language instructions. Historical decisions and acceptance statuses remain as recorded; the language of product interfaces, API field names and runtime behavior is not changed by this translation.
