# Universal AI platform

Agreed enhancements requested by LogoPanel on 25.09.2026: [implementation plan and acceptance criteria](LOGOPANEL_FOLLOWUP_PLAN.md).

Backend roles deployed separately and container templates: [deployment](DEPLOYMENT.md).

Date: 2026-09-18. Documentation version: 0.3, following discussion of product rules, interfaces and the test client.

Status: specification 0.3 and a local implementation. Validation results are recorded in the [acceptance matrix](ACCEPTANCE_RESULTS.md), and startup commands in [LOCAL_RUN](LOCAL_RUN.md). Real OpenAI and Serper/Cartesia runs passed; Cartesia's individual cost remains unknown. Anthropic was deferred by the owner, and financial reports await separate access. Discussion decisions and technical settings are separated in [DECISIONS](DECISIONS.md). Numerical settings are not operational measurements.

The platform executes AI and related paid-tool requests, accounts for cost, estimates application actions, and manages credits, reservations, queues, provider failover and reconciliation. A separate test application validates the API/SDK before Logo Panel integration. Logo Panel remains the first planned product client; the platform's domain logic does not depend on it.

## Accepted decisions

1. The AI platform is a standalone server with an API, SDK and admin interface. It is intended for the owner's applications; the main scenario is a separate installation per application with its own database, storage, settings and provider keys. Public SaaS is outside the first version.
2. Payments, subscriptions, taxes, package selling prices and commercial discounts belong to a separate payment service.
3. A credit has a constant internal spending budget. The first-version baseline is 1 credit = 0.001 USD of calculated cost at published applicable rates. The value is fixed before the first grant and never changes for that credit unit afterward.
4. Each grant creates a separate lot. The lot's original budget and terms are immutable. A new selling price affects only new purchases.
5. A model price increase raises the credit cost of future operations but does not reduce the remaining budget of previously purchased lots. A lot guarantees a budget, not a number of generations.
6. The main action payment mode is an advance estimate, an agreed maximum, a reservation and actual-usage settlement within the accepted settlement policy.
7. Provider cost, customer settlement and external payments are tracked separately. Platform errors remain in cost accounting even when the customer pays nothing.
8. The service persists every provider attempt. Repeating a client HTTP request does not create a new paid attempt.
9. Unknown does not mean zero. An unknown outcome does not permit automatically repeating a potentially executed request.
10. The first implementation uses one codebase, PostgreSQL, an API process, workers and a scheduler. Each module does not need its own microservice.
11. The service owner pays for technically defective model responses and platform errors. A valid result is payable even if the user dislikes it. In the first version, each successfully completed part of an action is settled separately.
12. A request has a default total deadline of 300 seconds and four attempts, with an installation maximum of eight. Long recovery is disabled by default; enabled delays use the same counter. Refused and unknown outcomes do not trigger automatic retries. See EXECUTION.
13. After recovery is exhausted, the affected route is blocked until manually enabled. Jobs wait in the background, have finite deadlines and support cancellation. Cancellation after dispatch is billed at confirmed usage.
14. A disputed reservation is closed no later than one hour after uncertainty or a delivery problem arises. The unresolved portion is released; no late automatic charge is made.
15. Each lot's expiration is set at grant time. Subscription credits can expire at the end of the paid period without rollover. Applications retain permanent results; the AI service removes temporary copies after delivery acknowledgment.

## Documents

| Document | Contents |
|---|---|
| [Discussion decisions](DECISIONS.md) | Agreed rules, selected settings and first-version boundaries |
| [Architecture](ARCHITECTURE.md) | Boundaries, modules, entities, application isolation, adapters and storage |
| [Accounting and credits](ACCOUNTING.md) | Units, lots, postings, reservations, caching, refunds and uncertainty |
| [Action quoting](QUOTING.md) | Recipes, model profiles, forecasts, maximums and quote acceptance |
| [Specification: catalog and pricing](MODEL_PRICING_SPEC.md) | Planned calculation types, formulas, rates and final request prices; not implementation status |
| [Paid API and allowance plan](PAID_API_PLAN.md) | File configuration and visual administration, AI/API extension, provider allowances, Firecrawl and notifications; local and real Firecrawl acceptance |
| [Jev contract](JEV.md) | Question types, validation, JSON results, financial limits and offline demo |
| [Jev System One integration plan](JEV_IMPLEMENTATION_PLAN.md) | Stages and criteria; local implementation, the owner-selected maximum of 32768 tokens, and separate live acceptance |
| [Distributed execution plan](DISTRIBUTED_EXECUTION_PLAN.md) | Discussion draft: BullMQ, Redis, quotas, concurrency, recovery and migration |
| [Execution](EXECUTION.md) | States, queues, rate limits, retries, failover, cancellation and recovery |
| [API](API.md) | Authorization, operations, requests, wallets, administrative methods and events |
| [Operations and interface](OPERATIONS.md) | Reconciliation, provider balances, notifications, admin pages and observability |
| [Implementation and acceptance](IMPLEMENTATION.md) | Stages, Logo Panel migration, validation matrix and readiness criteria |
| [Sources and limitations](SOURCES.md) | Reviewed provider documentation and limits of certainty |

The documents describe one system and use the same identifiers and units. ACCOUNTING defines financial invariants; QUOTING defines the boundaries of authorized work; EXECUTION defines external-call rules. The API must comply with all three. A contradiction requires correcting the specification before implementing the disputed behavior.

The immediate development scope is stages 1–5 and stage 6a of the [implementation plan](IMPLEMENTATION.md). It includes a designed admin interface and separate test client built with TanStack Start and shadcn/ui. Logo Panel integration is deferred to stage 6b; operational readiness remains stage 7.

## First-version scope

- Separate application installations, with client accounts and wallets within each installation.
- Text, images, speech, search and registered specialized operations.
- A registry of connections, models, capabilities, prices and routes.
- Usage by request and attempt, cache-aware settlement and price history.
- Credit lots, grants, reservations, charges, releases, refunds and grant revocation.
- Simple API/SDK invocation without registering a custom recipe; quoting recipes for composite actions.
- A durable queue, shared provider limits and safe failover.
- Reconciliation where a provider supplies suitable data; explicit status for unavailable capabilities.
- SSE events, webhooks and admin notifications.
- File delivery, acknowledgment of persistence by the application and removal of temporary copies without a shared filesystem.

## Out of scope

- Collecting money and automatically topping up a provider account.
- Subscriptions, pricing pages, tax accounting and revenue bookkeeping.
- Product-specific characters, role prompts, discussion history and editors.
- Arbitrary user code and a general-purpose workflow builder.
- Transparent substitution of unsupported model capabilities.
- A guarantee of exactly one external execution under every network failure without provider support.
- A guarantee of retail margin without knowing the terms on which credits were sold.

## Requirements map

| ID | User requirement | Defined in |
|---|---|---|
| R01 | Reuse in other applications | ARCHITECTURE, API |
| R02 | Real-time ledger, including cache | ACCOUNTING, OPERATIONS |
| R03 | Cost and balance reconciliation through APIs | OPERATIONS, SOURCES |
| R04 | Budget and problem notifications | OPERATIONS |
| R05 | Price editing page | OPERATIONS, ACCOUNTING |
| R06 | Credits and composite action quoting | QUOTING, ACCOUNTING |
| R07 | Provider queue | EXECUTION |
| R08 | Rate limits and failover | EXECUTION |
| R09 | Grants, refunds and balance updates | ACCOUNTING, API |
| R10 | Reservations | ACCOUNTING, EXECUTION |
| R11 | Separate payments and plans | ARCHITECTURE, API |
| R12 | Preserving older lots' budgets | ACCOUNTING |

## Initial settings

These values must be configuration with a change history. They are not pricing promises.

| Setting | Initial value |
|---|---|
| Credit unit | ai-credit-usd-v1 |
| Budget per credit | 0.001 USD |
| Credit lot expiration | Explicit expires_at at grant time; null explicitly means a non-expiring lot |
| Refund into an expired lot | Separate compensation lot for 30 days; see DECISIONS |
| Lot selection order | Earliest expiration, then grant date |
| Unaccepted quote lifetime | 15 minutes |
| Total request deadline | 300 seconds by default; an operational limit may forbid another dispatch |
| Request attempts | 4 by default, maximum 8; one counter shared by primary and fallback |
| Recovery from temporary unavailability | Finite backoff and explicit recovery delays within the total attempt count and deadline |
| Unknown outcome or unavailable result | Financial closure of the disputed reservation after 1 hour |
| Temporary retention of a completed result | Deletion after application acknowledgment; proposed limit without acknowledgment is 1 hour |
| Charging mode | actual_usage |
| Hidden AI-service markup | None |

Before production launch, select infrastructure, real connections, platform-loss limits, and retention periods for the minimal financial journal and backups. Initial settings are distinguished from user decisions in DECISIONS. Real keys and prices are not included in documentation examples.

The [real provider-check protocol](REAL_PROVIDER_CHECKS.md) describes the next run, access, spending limits and evidence.

Technical audio validation confirms WAV/MP3 validation and platform-funded payment for defective attempts.

- [Shared modular admin](MODULAR_ADMIN.md): integrating product pages, server handlers and access boundaries.
- [External authentication](EXTERNAL_AUTH.md): server adapter contract, team wallets, staff roles and personal audit.
- [External authentication plan](EXTERNAL_AUTH_PLAN.md): stages, checks and local implementation boundaries.

File-based AI configuration: [preparatory stage PA-I00, publication commands and boundaries](FILE_CONFIGURATION.md).

## Paid API extension

Contract PA-I01, units, periods, allowance reservations and compatibility boundaries are described in the [paid API contract](PAID_API_CONTRACT.md). Implementation status and stable PA-A01–PA-A25 scenarios are in the [plan](PAID_API_PLAN.md). Implemented handlers and validation boundaries are listed in that same plan.

Universal invocations are extended under the [plan](UNIVERSAL_INVOCATION_PLAN.md). The same plan lists validation criteria.

Integrating the new contract: [universal invocations](UNIVERSAL_INVOCATION_INTEGRATION.md).

- [LogoPanel follow-up contracts](LOGOPANEL_FOLLOWUP_INTEGRATION.md) and [validation plan](LOGOPANEL_FOLLOWUP_PLAN.md).

- [Cerebras, Groq and Gemini Flash on Google Cloud plan](ALTERNATIVE_MODEL_IMPLEMENTATION_PLAN.md): five models, stages, acceptance criteria and live-run boundaries.
- [Connecting Cerebras, Groq and Google Cloud](ALTERNATIVE_MODEL_INTEGRATION.md): adapters, tool history, rates and live-run limitations.
