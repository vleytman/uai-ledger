# Architecture

[Contents](README.md)

## Product boundary

The application knows why an answer is needed. The platform knows how to execute an authorized request, limit its spending, obtain the result, and record usage.

The application stores domain projects, prompts, history, and action sequences. The platform stores only the inputs needed for execution, results with limited retention, technical metadata, and financial records. It does not need a copy of the application's entire database.

The payment service stores purchases, retail prices, subscriptions, and monetary refunds. It issues commands to grant or revoke credits. The AI platform does not verify card payments or change subscription plans.

~~~mermaid
flowchart LR
  APP[Applications] --> API[API and SDK]
  PAY[Payment service] --> WAL[Wallet]
  API --> QUOTE[Operation estimation and authorization]
  QUOTE --> WAL
  QUOTE --> QUEUE[Queue and routing]
  QUEUE --> ADAPTERS[Adapters]
  ADAPTERS --> PROVIDERS[Providers]
  ADAPTERS --> USAGE[Usage and cost]
  USAGE --> WAL
  SYNC[Reconciliation] --> PROVIDERS
  SYNC --> EVENTS[Events and incidents]
  ADMIN[Administrative interface] --> API
~~~

## Deployment

The central catalog stores published model versions, parameter schemas, attachment preparation, estimation methods, and a separate pricing block for each model. `packages/model-pricing` executes the restricted tokens/per_unit/lookup/formula types and calculates with exact rational numbers. Provider rates are versioned separately. An administrator checks an unsaved calculation without calling a provider; publication checks coverage, control quantities, and specified expected costs.

Quoting binds the final `quoted_final` price to specific input and versions, accounting ensures reservation and a single charge, and execution records each attempt's spending independently of the customer price. Actual cost does not rewrite the agreed price. The public catalog exposes parameters and file preparation to the client, but not internal methods or coefficients. See [central price calculation](MODEL_PRICING.md).

One independent TypeScript codebase, deployed separately for each owner-operated application. Installations have independent PostgreSQL databases, temporary BlobStores, configurations, service tokens, and provider keys. They do not access each other's databases or share user wallets.

Within an installation, API, worker, and scheduler have separate entry points, shared contracts, and one PostgreSQL database. The administrative interface is a separate build. BlobStore has a local implementation for development and object storage for the server. Public third-party developer registration and a centralized SaaS control plane are outside v1.

~~~text
uai/
  apps/
    api/
    worker/
    scheduler/
    admin/
    demo/
  packages/
    contracts/
    ui/
    sdk/
    providers/
    catalog/
    pricing/
    quoting/
    execution/
    accounting/
    reconciliation/
    notifications/
    storage/
  migrations/
  docs/
~~~

In the first version, the durable queue lives in PostgreSQL. A worker takes jobs through short transactions and an execution lease. A network request to a provider does not hold a wallet row lock. If Redis is introduced later, PostgreSQL remains the source of financial state and jobs requiring recovery.

An event for external delivery is written to the outbox in the same transaction as the state change. Delivery may repeat. Recipients deduplicate by event_id.

## Interfaces and test client

apps/admin and apps/demo use TanStack Start and shadcn/ui. packages/ui contains shared components, theme, typography, and amount/status formatting. Exact dependency versions are pinned when the scaffold is created; build and startup are verified in the chosen environment.

The TanStack Start server layer handles sessions and UAI calls on behalf of an authorized user. Admin uses the administrative API; demo uses the SDK. Interface server functions do not modify UAI tables directly or replace the standalone API, worker, and scheduler. The UAI API checks authorization for financial commands independently of button visibility.

Demo owns its chat history and permanent files, uses a separate database or isolated client storage, and does not read the UAI database. After durably saving a result, the backend calls acknowledge. Deleting a conversation deletes client content and initiates deletion of temporary UAI content while preserving financial history.

Test grants are available only to an authenticated test user for their own account, and only when server-side test-environment mode is enabled. The backend uses a separate token with grant permission and a restricted scope. It checks a positive amount and the configured upper limit, sets explicit expires_at and reason, and retries the command with the same Idempotency-Key. The demo grant route is disabled in production independently of the frontend. A grant creates a credit lot and does not top up a provider account.

Presentation requirements are in [OPERATIONS](OPERATIONS.md).

## Modules and data ownership

| Module | Owns | Does not decide |
|---|---|---|
| Connections | Provider accounts, credential refs, reconciliation capabilities, state | Retail price |
| Catalog | Model versions, capabilities, allowed parameters | Application prompts |
| Pricing | Rate cards, cost calculation rules, history | Sold subscriptions |
| Quoting | Recipes, estimates, accepted limits | Domain workflow sequence |
| Execution | Requests, attempts, queue, routes, limits | Credit issuance |
| Accounting | Usage, cost entries, lots, reservations, postings | Payment confirmation |
| Reconciliation | Provider snapshots, periods, discrepancies | Automatic recalculation of user charges |
| Notifications | Incidents, rules, deliveries | Retrying generations |

A module does not directly modify another module's tables. A shared application service may call modules within one transaction for critical operations, such as creating an operation and reservation.

## Identity and isolation

- organization_id identifies the owner of connections and the platform space.
- application_id identifies the client application.
- account_id identifies the payer within the application, a person or a team.
- actor_id identifies the specific initiator and is used for audit and additional limits.
- wallet_id identifies an account's wallet in a specific credit unit.
- external_project_id is an optional application label. It grants no access and does not control financial record retention.

All reads and changes are restricted to the organization and authorized application/account. An application's service key grants no access to other applications. The browser does not receive an AI-platform key with grant permissions or permission to execute arbitrary requests.

Accounts are created by the application's trusted backend. If direct browser calls are needed in the future, the backend issues a short-lived restricted token for a specific account, operation, and budget.

The implemented [external authorization contract](EXTERNAL_AUTH.md) preserves the server-to-server boundary: the parent backend verifies the person, membership, and product permissions, then the SDK forwards restricted context. UAI does not store users or team membership. `audit_identity` stores the external person, team, and service principal separately from historical `actor_id`. The initiator's identity and the accepted operation's payer do not change with the active session.

The main configuration contains one application per installation and multiple client accounts. Organization/application scope remains in the contracts for isolation and later extension. A shared wallet for multiple applications within one installation would require separate authorization and is unnecessary for the first integration. Wallets are not shared between installations. Credits cannot be transferred between organizations or credit units through an ordinary grant command.

## Connection, model, and route

Provider identifies an integration implementation, such as OpenAI. Connection identifies a specific organization, project, or account at the provider and a reference to its credentials. ModelVersion identifies an actual model and its capabilities. RouteVersion identifies an approved strategy for selecting models and connections.

Limits may belong to a connection, provider organization, or shared model group. Multiple keys for one account do not imply multiple independent budgets or rate limits.

Each installation receives a separate key. If the provider account is shared, the operator allocates portions of the shared budget and quota to installations so that the sum of allocated shares does not exceed the known total limit, with headroom. This is a local restriction, not an exact distributed counter. External spending and changes to provider limits can still cause 429; the scheduler handles them under EXECUTION. Financial snapshots of a shared account are labeled with their scope and are not presented as one installation's expenses.

An application usually calls a profile, such as text.medium or image.standard. A profile resolves to a specific route version during quoting. Each attempt records the actual provider, connection, model, parameters, and applied price versions.

A profile does not promise identical model quality. Allowed substitutions are approved by an administrator after quality and compatibility assessment. Pinning a specific model is also supported.

## Adapter contract

Each adapter publishes its capabilities rather than emulating missing features.

| Method | Purpose |
|---|---|
| capabilities | Request types, streaming, native jobs, lookup, cancel, idempotency, usage, and financial APIs |
| validate | Check the combination of model, parameters, files, and schema |
| estimateUsage | Estimate billable quantities and a conservative limit |
| estimateLimitUsage | Estimate rate-limit consumption separately |
| execute | Execute one attempt and return a result or job handle |
| poll / cancel | Use a native provider job where supported |
| normalizeUsage | Preserve source data and construct non-overlapping billable items |
| classifyFailure | Distinguish temporary limits, quota, auth, invalid request, and unknown outcome |
| readRateLimits | Read available limit headers and configuration |
| readUsage / readCosts / readBalance | Retrieve only supported reports, with their scope and coverage time |

Lookup by request ID is supported only where documented by the API. A correlation request ID in a header does not itself imply the ability to retrieve a result.

The platform distinguishes text, image generation/edit, speech synthesis, search, embeddings, and specialized registered operations. Activate only the capabilities supported by your configured adapters and models.

An arbitrary provider endpoint, secret, shell command, or executable code is not accepted from an end user. Specialized workers are registered by an administrator, run a preinstalled implementation, and report usage through a signed trusted channel.

## Database entities and constraints

| Entity | Significant fields and constraints |
|---|---|
| applications, accounts, principals | Organization scope, external account ID, roles and permissions |
| provider_connections | Provider, account scope, credential refs, health, reconciliation capabilities |
| model_versions | Provider model ID, capabilities, parameters, lifecycle |
| route_versions | Allowed models/connections, order, cost and substitution limits |
| rate_card_versions, rates | Effective interval, source, currency, dimension, unit, conditions |
| recipe_versions | Application, parameters, components, constraints, settlement mode |
| quotes | Wallet, normalized inputs, hash, versions, estimate, maximum, expires_at |
| operations | Accepted quote, maximum, execution state, settlement state, deadline, admission_closed_at |
| requests | Operation, component, client_request_key, input hash, budget claim |
| attempts | Request, attempt number, provider identity, submission state, remote IDs |
| recovery_incidents | Failure scope, cycle index, next_retry_at, probe lease/fencing token, affected routes, hard-lock reason |
| usage_observations | Attempt, source event ID/hash, raw ref, normalized items, final/cumulative flags |
| cost_entries | Attempt, source observation, rate version, amount, state, and adjustments |
| wallets, credit_lots | Credit unit, immutable issued amount, terms snapshot, expiry |
| reservations, reservation_allocations | Operation, wallet, lots, locked amounts and remainders |
| journal_transactions, postings | Reason, references to the source event, balanced movements |
| grant_revocations | Original grant, held amount, external refund ref, status |
| provider_snapshots, reconciliation_runs | Scope, covered interval, fetched_at, native amounts, discrepancy |
| assets, result_deliveries | Owner scope, content hash, media type, ready_at, content_expires_at, acknowledged_at, blob ref |
| content_deletions | Scope, tombstone/generation fence, requested_at, purge status; no project content |
| outbox_events, event_deliveries | Sequence, event ID, payload, recipient, attempts, next attempt |
| incidents, audit_events | Fingerprint, state, actor, configuration changes |

The operation_id + client_request_key pair is unique for requests. The request_id + attempt_number pair is unique for attempts. A financial effect's source event is unique within the relevant scope. A retry with different content conflicts instead of silently returning the earlier result.

Derived balances are updated in the same transaction as postings. They can be reconstructed from the journal. A balance cannot be calculated as the sum of queued events because event delivery may lag.

## Files and content retention

The application uploads a file and receives an asset_id. Before a call, the platform checks the owner, format, size, and file readiness. A remote provider URL is not a completed transfer: the platform checks and saves the result to temporary storage before declaring it ready. Permanent storage of projects, answers, and files belongs to the application.

External URLs are allowed only under the download policy. Protection against requests to internal networks and redirect validation are required. For controlled integrations, asset_id and signed uploads are preferred.

Secrets are stored through credential refs and server-side encryption. Keys and authorization headers do not enter logs, SDK responses, or webhooks. Administrative reconciliation credentials are available to the scheduler, but not necessarily to the generation worker.

After durably saving the answer and all its files, the application calls acknowledge with the result version ID and hashes. The platform closes access to these temporary copies and queues physical deletion durably. Repeated acknowledgement is safe. Downloading, SSE disconnect, and receiving HTTP 200 do not themselves confirm durable storage.

In v1, an output asset is for delivery only and is not accepted as the next request's input asset. The application saves the file and uploads a separate input asset for the next call; the SDK may perform this transfer. This prevents acknowledgement from deleting a file needed by an already accepted consumer. Active requests may share references only to an explicitly uploaded input asset. Server-side copying with separate ownership references is deferred.

Without acknowledgement, the result is deleted at content_expires_at. Proposed initial TTL: one hour from ready_at, fixed when the operation is accepted and returned by the API. GET, command retries, and reconnection do not extend it. A valid result available within the promised window is charged regardless of acknowledgement; a client cannot eliminate spending by refusing to confirm a download. A platform-side delivery failure is resolved under ACCOUNTING's one-hour rule.

Inputs and defective intermediate results are retained only while needed by an active job and bounded recovery. Shared input assets have references to accepted requests and are deleted after their last consumers finish, without indefinite extension through new reads. An unused upload expires at upload expiry. A financial investigation does not itself extend content retention. Every path has a finite deadline; expiry does not trigger regeneration.

A project-content deletion command first sets a tombstone, rejects new requests in that project version, and cancels those not yet submitted. Calls already sent to a provider undergo separate cancel/settlement; late results cannot restore deleted content. Reusing the same external name creates a new project generation. The usage and amount journal is preserved without prompts, answers, or files.

Cleanup covers BlobStore, database text results, temporary files, response caches, outbox payloads, and diagnostic data. Durable events contain references and metadata rather than copies of answers; financial raw usage is stripped of content on write. Signed URLs must not outlive content access. The purge queue is checked and retried after failures. Temporary content is excluded from long-term financial backups; after restore, tombstones and expiry are applied before reads are enabled. Retention periods for the minimal journal and backups are configured separately before production.

## Connecting a new application

1. Create an application and restricted service principal.
2. Create an account/wallet or map an external account.
3. Select permitted routes. Use the built-in standard recipe for a single call; custom recipes are needed for compound actions.
4. Integrate the SDK, durable result storage, acknowledgement, content deletion, and event handling.
5. Connect grants from the payment service or administrative budget.
6. Verify retries, insufficient funds, unknown outcomes, and recovery before enabling real traffic.

Profiles and recipes are exported as versioned configuration without secrets. Deploying another application must not require changing core code.

## Modular admin

`apps/admin` is the installation's interface build. The reusable layout lives in `packages/admin-shell`; UAI pages and its server adapter live in `packages/admin-module`. A product registers its pages and owner-only handlers in the build without changing the financial core. The integration contract and constraints are described in [unified modular admin](MODULAR_ADMIN.md).

The product's user frontend is deployed separately. The shared administrative build includes UAI source from one repository through a Git submodule; the product keeps its own settings and payment pages outside UAI. Shared fixes land in UAI, then products update their pinned commit after compatibility checks.

## Distributed runtime

The BullMQ backend uses BullMQ to deliver request IDs, PostgreSQL for execution authorization and finances, Redis for quota windows, and S3 for files. API, scheduler, generation, observation, and maintenance run as separate processes. Backend, generation, and purpose are pinned in durable dispatch; a completed Redis job is not the source of truth for a result or charge.

The complete set of quota rules is checked in one final Lua command. Large histories are prepared in short passes without issuing permits. Provider-group concurrency is stored in PostgreSQL together with protective holds for unknown outcomes. Group session locks serialize admission preparation, but SQL transactions are not held during Redis or HTTP. After Redis, all groups are confirmed in one short SQL transaction that rechecks the fence, deadline, cancellation, and configuration. Both sides of authorization are required before submission intent.

## Paid API extension

See the [paid API contract](PAID_API_CONTRACT.md) for provider accounts, usage units, periods, allowance reservations and supported HTTP endpoints.
