# Implementation plan 0.3 and work status

[Specification](README.md) · [Acceptance matrix](ACCEPTANCE_RESULTS.md)

Start date: 2026-09-18. The admin interface has been fully translated into English at the owner's request. The real OpenAI run through SDK/demo completed within an authorized 1 USD budget: four successful requests, calculated cost 0.004452 USD. Serper and Cartesia each passed one real request under a separate 0.50 USD limit; Cartesia's cost remains unknown. Anthropic was deferred by the owner, and financial reports await a separate reporting credential. The local implementation and A01–A91 are supported by reproducible checks. Latest PostgreSQL run: 291/291 on a new database in a Linux container, 30 files; types and builds verified.
Agreed stack: TypeScript, PostgreSQL, pnpm workspaces, Fastify, Drizzle with SQL migrations, Vitest, Docker Compose, TanStack Start, shadcn/ui.
The coordinator uses xhigh through the UI setting; all subagents use high and inherit the model. No more than three subagents run concurrently.

## Boundaries and initial state

Uncommitted changes to README.md and docs/API.md, ARCHITECTURE.md, DECISIONS.md, IMPLEMENTATION.md, OPERATIONS.md, README.md and SOURCES.md are the input specification. Do not revert them. Do not create a branch or PR without separate permission.
Full scope: stages 1–5 and 6a. Stage 6b and the production portion of stage 7 are deferred. Local security, restore and deletion checks are part of current acceptance.
Paid provider checks require separate access and budget. Missing access neither cancels fixture/integration checks nor establishes real integration.

## Shared implementation rules

The coordinator owns packages/contracts, packages/db, root configuration, migration 0001 and integration. Modules export services accepting a shared SqlExecutor and permit passing a transaction. Network calls do not hold financial locks.
Money uses bigint within the domain and PostgreSQL, and strings in JSON. Decimal rates are calculated exactly. A shared Clock accelerates recovery/expiry in tests.
Each module owns its tables. Migration numbers are assigned: 0001 foundation, 0002 accounting, 0003 catalog/pricing, 0004 execution/storage, 0005 quoting, 0006 operations. Shared contract changes are coordinated with the coordinator.
Financial effects and the durable outbox are persisted in one transaction. Durable events and idempotent responses contain references rather than prompts/results.

## Dependencies, owners and criteria

| Task | Owner | Dependencies | Completion criterion | Status |
|---|---|---|---|---|
| P00 Scaffold, monetary types, errors, scope, Clock, SQL, CI | Coordinator | Specification | Dependency installation, PostgreSQL, migrations and basic validation work | Scaffold, migrations 0001–0014, PostgreSQL and CI ready |
| P01 Accounting, lots, postings, reserve/claim/capture/refund/revocation, expiry | Financial core | P00 | PostgreSQL invariants and concurrency; replay without duplicate effects | Financial invariants, concurrency, replay, expiry and revocation verified on PostgreSQL |
| P02 Catalog, pricing, adapter contract and fixtures | Providers | P00 | Different usage/cache schemas; unknown quantities do not become zero | Catalog, rational pricing, adapters and fixtures verified; real OpenAI/Serper/Cartesia passed, Anthropic deferred by the owner |
| P03 Queue, attempts, leases, recovery, exposure, storage | Execution | P00, P01/P02 contracts | Fault injection, unknown, cancellation, TTL and tombstones | Queue, native hooks, recovery, fencing, TTL and restore guard verified |
| P04 Visual scaffold, overview, operation and wallet | Coordinator | P00 | Shared theme and components, desktop/mobile prototype | Shared theme and interfaces verified through Aside on desktop and at 390 px width |
| P05 Quoting, recipes, admission, single invocation, amend | Coordinator/quoting | P01/P02/P03 | Atomic reserve+work, component limits and agreed maximum | Quoting and atomic admission verified, including actual usage and successful parts |
| P06 API, scopes, OpenAPI, SSE | Coordinator/API | P01/P03/P05 | Isolation, replay, reconnect, all contract commands | HTTP scopes, OpenAPI, types, SSE disconnect/reconnect and revocation verified |
| P07 Reconciliation, incidents, notification/webhook, admin API | Operations | P02/P03/P06 | Scope/freshness, deduplication, corrections without debit | Reconciliation, reporting credentials, incidents, revocation holds and delivery fixtures verified |
| P08 SDK and independent demo | SDK/demo | P04/P06 | Chat, image, composite action, persist-before-ack, protected grant | Demo verified through SDK and real OpenAI; persistence, ACK, reload, grants and deletion confirmed |
| P09 All admin pages | Interfaces | P04/P06/P07 | Real API actions, states, accessibility and Aside QA | Pages, filters, calculator, rate comparison and effective budgets verified through Aside and HTTP |
| P10 Independent acceptance | Reviewer | P01–P09 | All applicable A01–A91 with evidence; defects fixed | Matrix contains 91 local confirmations; 291/291 tests on a new Linux-container database, no skips |
| P11 Reproducibility and report | Coordinator | P10 | Clean startup, CI; report distinguishes fixture/integration/browser/real checks | Clean startup, restore, types, builds and reports ready; OpenAI/Serper/Cartesia verified, reporting awaits access |

## Team workflow

First wave: financial core; providers/pricing; execution/storage. The coordinator prepares the foundation, agrees contracts and creates the UI scaffold early.
Second wave: quoting/API; operational modules; SDK/demo. The coordinator integrates and verifies financial boundaries.
Third wave: admin interface; SDK/demo completion; independent end-to-end validation. Each module author runs their checks; the reviewer looks for defects at integration boundaries.

## Evidence and continuation

Record each scenario's status, command, result, evidence and limitations in ACCEPTANCE_RESULTS.md. A passed status requires a reproducible result; code or a test alone is insufficient.
Keep reports without secrets or private content only in the ignored `.data/reports/` directory. Do not commit databases or provider responses containing user data.
After each wave, update this file, the matrix, open defects and continuation commands. Do not close the goal while mandatory checks are missing.

## First context handoff history

- The accounting agent completed the first wave and is implementing quoting and migration 0007_operations.sql.
- The providers agent completed 49 tests and is implementing reconciliation/notifications and usage/cost persistence in migration 0006_operations.sql.
- The execution agent is verifying storage/recovery, then implementing apps/worker and apps/scheduler.
- The coordinator is implementing apps/api and packages/sdk, then interface integration.
- Migration 0005_quoting.sql currently contains service_tokens and command_idempotency. Quote/operation tables will be in 0007.
- Docker compose runs on 127.0.0.1:55432. Databases uai_test and uai_execution_test were created for development. The former contains an early 0004. After all migrations stabilize, run a completely clean check in a new database; do not change a checksum to make checks pass.
- `pnpm --filter @uai/admin dev` starts the visual prototype at 127.0.0.1:4311. It is not yet connected to the API. A desktop screenshot was reviewed and Aside wallet navigation verified. Narrow viewport acceptance is incomplete.
- API scopes/grant/replay passed 7 integration tests on uai_execution_test. The full API is not ready yet.

Paid verification is performed only after the owner separately authorizes the specific run's budget. Historical validation results follow.

## Goal addition 2026-09-19

Translate the entire admin interface into English, without a Russian version or language switcher. Check every page, form, error, accessibility behavior and number/date format through Aside. This change does not affect the demo language or user data.

Completed. TypeScript, builds and 258 tests passed; Aside confirmed the English interface on desktop and at 390 px width.

## Real OpenAI, 2026-09-19

Text, image and a composite action were executed through the SDK/demo. All four requests succeeded on the first attempt, with calculated cost 0.004452 USD and no open reservations. Aside and local-file checks confirmed persistence before ACK, reload without new requests and deletion of the test conversation while retaining financial history. Financial reconciliation with the provider has not yet been performed.

Before the run, parameters and versions of published Demo recipes, the associated provider-limits card and delivery of the stored `created_at` for operations were corrected. The final PostgreSQL run contains 259 successful tests. Real worker processes were stopped and the regular worker restored with real providers disabled. Remaining access requirements are listed in the [real-check matrix](REAL_PROVIDER_CHECKS.md).

## Demo completion audit, 2026-09-19

Fixed a stale reservation in a saved operation, cancellation before the first request, repeated ACK after a network failure and application of an outdated wallet revision. Step cards expose diagnostics and show available funds, reserved funds and balance. Clean PostgreSQL run: 262 tests across 29 files. In Aside, canceling a fixture operation returned its entire reservation without provider attempts; rereading OpenAI preserved the previous four requests and cost.

## Repeated completion commands

Fixed terminal results overwritten by late cancellation, active cancellation weakened by complete, and repeated closure events. Demo preserves the actual result even after a direct late cancel command. PostgreSQL, HTTP API and SDK/Demo were checked on a clean database: 267 tests, 29 files, no skips.

## Final request and operation statuses

The public API and admin overview no longer return completed for every canceled request or for a mixture of errors and cancellations without success. Ten scenarios compare four HTTP projections, reservation and charge. A clean database passed 277 tests across 29 files. Other live checks awaited separate authorization.

## Linux CI verification and remaining access

In a separate Linux amd64 container with Node.js 22.23.2, installation from the frozen lockfile, 14 migrations, OpenAPI, type checking, 277 tests with no skips, documentation and Admin/Demo client/SSR builds passed. The workflow enables the mandatory PostgreSQL suite. Temporary sources, container and database were removed.

At this stage, local checks were complete, while real RP02/RP04/RP05 and RP06 awaited access and separate budget authorization. The OpenAI 1 USD authorization was used for the agreed completed run.

## New connections and Anthropic deferral, 2026-09-19

After a free Cartesia check and preparation of the plan, the owner authorized up to 0.50 USD. One search and one 15-character phrase were executed, without retries. Serper returned 7 results and 1 credit; Cartesia returned a 1.6 s WAV without individual billed usage. Persistence, ACK and reload were verified. The regular worker again runs with real calls disabled.

Real Anthropic check RP02 was deferred at the owner's explicit request and does not block this run. Financial report check RP06 still requires a separate reporting credential. The requirement for an entirely English admin interface remains satisfied.

The check fixed structured-parameter comparison and final totals in the operation card. The administrative API now returns provider/platform costs calculated for this operation and result-delivery metadata, preserving unknown when data is incomplete. PostgreSQL tests and Aside confirmed the fix without additional paid requests.

## Local scope completion, 2026-09-19

Stages 1–5 and 6a were completed within the agreed boundaries. Final validation found and fixed acceptance of arbitrary nonempty audio bytes. The shared WAV/MP3 validator checks files before persistence and charging; PostgreSQL scenario A50 confirms platform-funded payment for a defective attempt. A previously persisted Cartesia response was accepted by the new validator without another provider call.

On a fresh Linux amd64 database with Node.js 22.23.2, frozen installation, 14 migrations, OpenAPI, type checking, 291 tests across 30 files, documentation and both builds passed. Matrix A01–A91 contains local evidence for every scenario; accessible real OpenAI, Serper and Cartesia were checked separately. Anthropic was deferred by the owner. Missing reporting credentials are recorded as connection limitations under stage 5, without fictitious financial reconciliation. Cartesia's unknown cost remains in the prescribed one-hour resolution process and is not declared zero.

At this milestone, the admin interface was entirely English, while Demo and documentation were in Russian. No branch, PR, production deployment, Logo Panel 6b or full stage 7 was performed. No new paid requests followed the two authorized Serper/Cartesia calls. The regular local worker runs with real providers disabled.

## Documentation language, 2026-10-22

At the owner's request, UAI Ledger documentation, including README.md and AGENTS.md, is now maintained in English. This changes the documentation language; historical implementation statuses, product UI text and API contracts remain as recorded.
