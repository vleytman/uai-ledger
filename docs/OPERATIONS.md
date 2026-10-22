# Reconciliation, notifications, and administrative interface

[Contents](README.md)

## Operational accounting and external reconciliation

The platform updates its own usage and wallet after each request's committed result. Fetching an external financial report is outside the normal capture critical path when response data suffices for calculation.

Reconciliation runs separately and verifies provider cost. Its result does not replace user history. Provider APIs may differ in granularity, lag, access scope, and units.

Each connection declares capabilities:

~~~json
{
  "usage_reporting": true,
  "cost_reporting": true,
  "balance_reporting": false,
  "request_cost_lookup": false,
  "reporting_granularity": ["day"],
  "reporting_lag_seconds": null
}
~~~

This illustrates configuration shape, not a claim about a particular provider. Unsupported capabilities appear unavailable in the UI. Browser scraping of a private dashboard is not a hidden mandatory first-version dependency.

## Provider balance snapshot

A snapshot contains provider account scope, source, native currency/unit, total, used, remaining, fetched_at, covered_through where available, accuracy, and freshness status. Prepaid balance, postpaid spending cap, quota, and credit limit are different indicator types.

Source is provider_api, manual, or derived. A manually entered budget is not called a confirmed provider balance. For postpaid connections without a real prepaid balance, show the available portion of the configured spending cap.

The scheduler accounts for unfinished requests and internal provider exposure claims. If a snapshot explicitly covers a known period, deduct only expenses not yet reflected and active commitments. Do not deduct expenses already included in total_usage again.

If covered_through is unknown, do not claim an exact adjusted balance. Use conservative estimation, safety margin, and uncertain-exposure limits. fetched_at is response receipt time and does not prove that the report includes all spending through that second.

Initial polling interval where API-supported: 5 minutes for active connections, less frequently for unused ones. The adapter limits frequency according to documentation. Failures increase the interval with backoff. An unavailable report does not trigger a paid test generation.

Topping up a user wallet does not top up the provider account. If the latter is exhausted, the platform pauses dispatch or selects an authorized alternative. The operator or a future separate financial integration performs real provider top-ups.

## Cost reconciliation algorithm

1. Determine API-supported scope, currency, timezone, and period.
2. Fetch every report page and save a raw snapshot without secrets.
3. Match it against provider cost entries in the same scope and interval.
4. Recheck recent periods for lag and late adjustments.
5. Record matched, discrepancy, incomplete, or unavailable.
6. For a discrepancy, create an incident and, following the established procedure, an adjusting cost entry.

Period closure does not depend on local request creation time if the provider attributes spending by completion time. The adapter documents applicable time semantics.

Discrepancy causes are classified as reporting lag, missing local usage, wrong rate, wrong unit, account-scope mismatch, external usage, discount/fee, rounding, late invoice adjustment, and unresolved. A cause is not chosen automatically without sufficient data.

If a provider report is aggregated daily, the platform confirms the daily aggregate. It does not proportionally distribute an unknown discrepancy among customers as proven spending for each request.

Spending outside the platform is stored as unattributed provider cost. Dedicated provider projects or keys are recommended for more precise reconciliation where reports distinguish them. Keys may share balance and rate limits even when their spending is visible separately.

Adjusting provider cost does not change a closed wallet capture. Late aggregated provider discounts affect cost and future rates. If our calculator overstated user spending, compensation is required: a correction run reproduces affected captures from saved usage and correct rates, creates idempotent refunds, and reports results. Customer underpayment is not automatically recovered retroactively. Recalculation does not require retaining prompts or images.

## Notifications

A notification rule contains scope, condition, severity, recipients, cooldown, and recovery condition. An incident has fingerprint, first_seen, last_seen, observed_value, state, and history. Repeated triggering updates the incident rather than creating another each time.

| Signal | Condition | Response |
|---|---|---|
| provider.budget_low | Balance below an amount or forecast spending for a defined period | Operator warning |
| provider.budget_exhausted | Confirmed exhaustion or billing rejection | Block affected dispatch |
| provider.auth_failed | Invalid or revoked credential | Pause connection |
| provider.degraded | Error ratio/latency above threshold with sufficient volume | Circuit policy and incident |
| provider.recovery_started | Initial cycle exhausted under confirmed temporary unavailability | Immediate incident with scope and next check |
| provider.recovery_exhausted | Final permitted recovery cycle failed | Locked and notice requiring manual enable |
| provider.recovered | Check confirmed a working path before hard lock | One recovery event; gradually resume queue |
| queue.delay_high | Waiting time exceeds threshold | Diagnose capacity and routes |
| limiter.unknown_slots_held | Unknown outcomes occupy limiter concurrency slots beyond threshold | Verify provider outcome, [manual resolution](#limiter-slots-and-unknown-outcomes) |
| reconciliation.discrepancy | Discrepancy exceeds absolute and/or relative tolerance | Check scope, usage, and rates |
| provider.balance_stale | No successful refresh beyond threshold | Mark stale and limit risk |
| pricing.missing_or_stale | Unknown price or not checked within required period | Block new requests that cannot be estimated |
| platform.exposure_high | Unknown and platform-funded costs exceed limit | Restrict retries and new calls |

Error-ratio thresholds require a minimum observation count. One rejection must not automatically declare a widespread outage. Time-to-exhaustion forecasts are not presented as exact without enough history.

This threshold does not delay a targeted event about the first fallback or recovery start of a specific route. All cycles use one incident fingerprint and show the initial cause, cycle_index, next_retry_at, and remaining platform-loss budget. A single request's defective answer does not declare the whole provider down. Final lock requires manual enable; resolving/acknowledging an incident does not itself authorize paid calls.

Events, incident state, and outbox are built with execution. Administrative inbox and signed webhook delivery belong to the interface/operations phase; specific email and other channels connect later through the same events. Before an external channel is configured, the system shows delivery_not_configured and does not claim a notification was sent. Notifications exclude secrets, prompts, and full answers.

Redelivery uses event_id, backoff, a bounded window, and dead-letter state. Acknowledge means the operator has seen the incident; resolve means the condition is removed or an explicit exception recorded. Recovery sends one recovery event.

An administrator sets webhook destinations. Ordinary clients must not send notifications to arbitrary internal URLs. TLS, signatures, address validation, and replay protection are part of the contract.

## Interface presentation and behavior

apps/admin uses TanStack Start with shadcn/ui components. Visual design is part of phase 5's deliverable. Shared components and theme live in packages/ui, also used by the simple apps/demo test client. Server-layer boundaries are in [ARCHITECTURE](ARCHITECTURE.md).

Before building all pages, prepare a shared navigation shell and representative Overview, operation-details, and wallet screens. Fix typography, palette, spacing, table density, amount format, and visual states. Standard components alone do not establish completed design.

Acceptance requirements:

- Calm presentation with readable hierarchy; monetary amounts aligned for comparison, units and precision explicit. Display rounding does not change accounting values.
- Available balance, reservation, customer charge, provider cost, and platform expenses have distinct labels. Provisional amounts and unknown spending do not look final or zero.
- Navigation, tables, filters, forms, and confirmations use consistent components. Dangerous administrative actions show the target, consequences, and mandatory reason when required by the API.
- Loading, empty lists, errors, stale data, unavailable capabilities, and revision conflicts are verified. Errors preserve entered data; safe retries do not duplicate commands.
- Actions remain accessible on narrow screens; wide tables scroll within their own container. Long identifiers, names, and large amounts do not obscure controls.
- Forms have labels, errors are linked to fields, focus is visible, and dialogs are keyboard-accessible. Status uses text as well as color; contrast meets WCAG AA.
- Browser checks cover realistic data volumes, desktop, and narrow viewports. Presentation and operation completion are checked through the real test-environment API.

## Overview page

Shows current costs, user charges, and platform-funded cost separately. Filters include application, account, model, provider, and period. A separate block contains active reservations, queue, uncertain spending, and recent incidents.

Every amount indicates precision. A provisional streaming estimate does not look like a final bill. UTC is used for storage; the selected timezone affects only displayed period boundaries.

Interface target: a committed wallet update is visible within two seconds on healthy infrastructure. This is a design goal, not a verified SLA. Provider data may be substantially less fresh.

## Providers page

Each connection shows provider account scope, available models/capabilities, credential status without the secret, health, rate-limit groups, balance or spending cap, source, freshness, and pending exposure.

Actions: add connection, save or rotate key, disable, change limits and risk policy, check through a free endpoint, start reconciliation. A paid health probe is labeled separately and requires configured budget.

For locked, show reason, affected routes/capabilities, four-cycle history, next permitted action, and manual enable with reason. A free check does not itself enable generation. Settings show the installation's separate key and assigned share of shared provider limits; the interface does not promise independent shared balance because another key exists.

Details distinguish model overload from a shared financial block. Manual budget updates retain author, reason, and time; they do not overwrite provider snapshots.

## Models and prices page

Each model exposes provider ID, version, capability, allowed parameters, and status. Alias does not replace actual model ID in request history.

The rate editor contains:

- connection override or general provider rate;
- dimension and unit, such as USD per 1 000 000 tokens;
- conditions: modality, quality, size, tier, region, context band, cache TTL;
- decimal rate, currency, effective_from/effective_to;
- source, checked_at, author, and comment.

Several applicable rates without unambiguous precedence are a publication error. A missing dimension is not treated as free. Cache read and cache write are displayed separately.

Before publication, the system checks coverage of used routes, overlapping periods, and trial calculations on saved anonymized usage. Comparison shows future price changes. It does not change historical records.

Suggested rates may be imported from an official API where available. Import creates a draft. Automatic price publication through HTML parsing is outside the first version.

## Routes and actions page

The route editor sets primary and one active fallback, capability requirements, order, cost limit, retry/circuit policy, and deadline. Initial policy: 2 + 2, then, for temporary unavailability, up to three shared cycles with 60/300/900-second pauses. The validator checks model compatibility, sufficient full deadline, permitted technical validators, and risk budgets. A shorter duration for time-sensitive actions is shown as an explicit recovery limit.

The recipe editor defines inputs, components, call counts, and bounds. The calculator accepts sample parameters and displays estimate, maximum, caching impact, and switching impact. For actual_usage, the UI explicitly explains release of unused reservation.

Administrators see the proportion of estimates above/below actual spending and operations stopped by budget. Statistics must not automatically loosen maxima or enable more expensive models.

## Operations and ledger page

Hierarchy: operation -> request -> attempts -> usage items -> cost entries and wallet postings. Waiting/execution duration, actual model, retry/failover reasons, cache breakdown, price version, and accuracy source are available.

Prompt and result appear only with permission and within retention. Error reasons do not expose credentials. Confirmed and uncertain spending have distinct labels.

After acknowledgement or content expiry, the interface shows deletion reason, delivery time, and checksums without content. This is not a ledger error or invitation to regenerate. Queue shows shared recovery waiting, next attempt, deadline, and cancellation. Customer reserve, provider exposure, and platform-loss budget are separate.

Recovery actions do not launch a paid retry through one context-free Retry button. The UI distinguishes retrieving a result again, safely retrying an unexecuted request, and making a new attempt with double-billing risk.

## Wallets and lots page

Shows balance, available, and reserved, followed by individual lots with original and remaining budget, terms, expiry, and external grant reference. Purchase retail price is available through the payment-service link if provided.

History expands reserve/capture/release/refund to the operation and original lot. Administrative grants and compensation require a reason and restricted role. Arbitrary balance-number editing is not provided.

## Reconciliation and incidents page

For each period, show internal amount, provider amount, native unit/currency, coverage level, difference, classification, and latest update. Gaps, unmatched external spending, and corrections can be expanded.

Providers lacking the required API show that limitation and a manual-confirmation path. The UI does not imply completed reconciliation from one green endpoint-availability check.

## Metrics and diagnostics

Required metrics: requests/errors by provider and capability, queue age, request latency, rate-limit wait, cache hit units, provider cost, customer charge, platform-funded cost, unresolved exposure, retry cost, outbox lag, and reconciliation freshness.

Logs use correlation, operation, request, and attempt IDs. Logs are not the balance source. Secrets and full content are not logged by default. Cost profiling requires usage, not full prompt recording.

Available-budget alerts are separate from margin alerts: without revenue data, the AI platform can show only cost and issued/charged budget. The payment service combines these with sales.

## Backup and recovery

PostgreSQL and assets require backups and verifiable restoration. Before production launch, perform a restore in a separate environment where external paid dispatch is prohibited.

After restore, reread active attempts and provider job IDs. Do not automatically retry every failed job. Outbox events may be delivered again, so subscribers and financial commands must remain idempotent.

Verify reconstruction of materialized balances from postings and comparison with saved wallet revisions. Discrepancies are corrected through a separate audited procedure, not direct SQL UPDATE of balances.

Specific RPO/RTO, retention, and backup strategy are selected with infrastructure. Their absence is not hidden behind a “production ready” label.

## PostgreSQL connection budget by process

Each process uses one pool: API defaults to 10 connections, worker to 8, scheduler to 4. Concurrent worker jobs share its pool. `UAI_DB_POOL_MAX_API`, `UAI_DB_POOL_MAX_WORKER`, and `UAI_DB_POOL_MAX_SCHEDULER` override these values; common `UAI_DB_POOL_MAX` is used only without a role-specific setting. CLI tools and tests use the tool role with limit 10; `UAI_DB_POOL_MAX_TOOL` is available.

Calculate installation totals before adding processes. For example, 2 APIs, 4 workers, and 2 schedulers at defaults require at most `2×10 + 4×8 + 2×4 = 60` connections. Migrations, monitoring, maintenance, and other database clients need additional connections. 60 excludes these and does not define PostgreSQL `max_connections`. Concurrent generations and database connections are different quantities: provider network calls must not hold SQL transactions.

`UAI_DB_CONNECT_TIMEOUT_MS`, default 5000 ms, limits waiting for a free connection and establishing one. `UAI_DB_IDLE_TIMEOUT_MS`, default 30000 ms, releases idle connections. Zero, fractional, and invalid values are prohibited: startup fails with a configuration error. These are not SQL query or transaction timeouts. Processes appear in `pg_stat_activity.application_name` as `uai-api`, `uai-worker`, `uai-scheduler`, or `uai-tool`.

An idle connection failure logs `postgres_pool_connection_error` without database URL or credentials. Errors in executing queries still reach callers. Environment changes require normal restart of the relevant process; saving a number in admin does not change an existing pool.

### Shared file storage

API, reference preparation, worker, and scheduler select storage through `createBlobStore`. Default is `UAI_BLOB_BACKEND=local`, with `UAI_BLOB_ROOT` as the path. For multiple servers, use `UAI_BLOB_BACKEND=s3` and identical `UAI_S3_BUCKET`, `UAI_S3_REGION`, and `UAI_S3_PREFIX` across installation processes. Prefix is mandatory and separates independent installations' files.

For S3-compatible services, set `UAI_S3_ENDPOINT` and, if needed, `UAI_S3_FORCE_PATH_STYLE=true`. Remote endpoints must use HTTPS. HTTP is allowed only for loopback tests. Credentials are supplied as `UAI_S3_ACCESS_KEY_ID`/`UAI_S3_SECRET_ACCESS_KEY`, optionally `UAI_S3_SESSION_TOKEN`, or through the AWS SDK standard credential chain. Do not commit them.

A precreated private bucket without versioning or Object Lock is required. Before each write and delete, the backend reads bucket settings; enabled or suspended versioning, Object Lock, and settings-read errors block mutation. Existing files remain readable. Ordinary DELETE in a versioned bucket does not remove old versions, so this mode is unsupported for now. Grant processes GetObject, PutObject, and DeleteObject only within their installation prefix, plus GetBucketVersioning and GetBucketObjectLockConfiguration for that bucket. Prohibit these credentials from changing bucket settings; pre-request checks do not protect against concurrent changes by an external administrator. No public URLs are created; file access stays through the API with PostgreSQL checks. TTL and tombstones still control purge.

Every S3 call is time-bounded. `UAI_S3_CONNECT_TIMEOUT_MS` (default 2000) bounds connection establishment; `UAI_S3_SOCKET_TIMEOUT_MS` (10000) bounds data inactivity in a request or response body; `UAI_S3_MAX_ATTEMPTS` (3, at most 10) bounds SDK attempts. `UAI_S3_OPERATION_TIMEOUT_MS` (30000) bounds the entire `put`/`get`/`delete`, including bucket checks, retries, and body reads. An endpoint accepting TCP then staying silent returns `blob_store_timeout` (HTTP 503) after roughly attempts × socket timeout rather than holding callers until the overall deadline. A truncated response body is reread within the same deadline; if every attempt truncates, return `blob_store_unavailable` (503). If a PUT retry receives 412 and the key contains identical bytes, treat the write as its own: keys are unique and the first response was lost. Different content still returns `PreconditionFailed`. Invalid environment values stop startup with `invalid_s3_configuration`.

Writes use `If-None-Match: *` to avoid overwriting an existing blob, like local `wx`. This behavior is described in [PutObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html). Verify conditional-write compatibility and actual deletion on the chosen S3 service before switching. Changing backend does not migrate old files: the running installation remains on local disk for now.

### Native job observation through BullMQ

With `UAI_EXECUTION_BACKEND=bullmq`, the scheduler publishes ready checks to `observe`. The delivery source lives in PostgreSQL: remote_job_id, request generation, and current attempt poll_count. Migration 0027 adds publication lease and next reconciliation time. Lost jobs are recovered; retries do not create new generation. Publication and Redis calls occur after the SQL transaction completes.

A BullMQ worker listens to `text,image,audio,tools,observe,maintenance` by default. For a separate observation process, set `UAI_WORKER_BACKEND=bullmq` and `UAI_WORKER_QUEUES=observe`; generation processes may be restricted to `text,image,audio,tools`. All installation processes use the same UAI_INSTALLATION_ID. The old scheduler continues observing legacy backend native jobs and skips distributed requests.

By default, reconciliation takes up to 32 ready attempts, rechecks delivery no sooner than five seconds, and uses a 30-second publication lease. Lease and poll_count protect against competing relays and consumers. Targeted BullMQ lookup receives separate admission under the observe row in execution_dispatch_policies: account_limit, application_limit, and queue_limit. A short row lock serializes observation-slot acquisition only. An active slot is defined by a live request lease and matching observation_fence; lease release or expiry frees it. Generation leases do not occupy these slots. The global scheduler lock was removed from runtime; financial operations coordinate by account, and legacy capacity acquisition has a separate lock. The main local installation has switched to BullMQ; fairness verification and remaining limits are listed in the acceptance matrix.

### Worker shutdown

SIGINT/SIGTERM pauses local BullMQ job intake and allows active handlers to finish. UAI_WORKER_SHUTDOWN_GRACE_MS sets the total wait, default 30000 ms, allowed 1–300000. On expiry, the process logs worker_shutdown_grace_exceeded and exits with code 1; hung HTTP/Redis/DB operations do not extend it. The external supervisor must allow longer than this grace period.

Forced exit does not cancel remote generation or release financial reservation. After domain lease expiry, recovery uses saved submission intent, remote job, and usage. A stopped process does not prove the provider did not execute the request. Normally, handlers finish and connections close, cancelling the watchdog.

### Maintenance through BullMQ

For the quota client, `UAI_REDIS_COMMAND_TIMEOUT_MS` bounds one Redis command's wait. Default 2000 ms, allowed 50–30000 ms. It is neither BullMQ job duration nor total quota-group recovery duration. A timeout does not prove Redis did not execute the command: an admission retry uses the same durable admission ID. Do not create a new ID solely because a response was lost or treat quota as unconsumed.

Admission/recovery holds group session advisory locks during Redis commands but executes outside a SQL transaction. The timeout limits one command, not the whole recovery cycle.

In distributed mode, the scheduler publishes a `maintenance` cycle instead of directly performing maintenance. For a separate process, set `UAI_WORKER_BACKEND=bullmq`, `UAI_WORKER_QUEUES=maintenance`, and the scheduler's `UAI_INSTALLATION_ID`. The cycle calls existing domain deadline/recovery/settlement, purge, monitor, and outbox procedures; during transition, it also observes remaining legacy backend native requests.

Migration 0029 stores the current cycle generation, due_at, lease, and reconciliation time. One live cycle is allowed per installation. A 30-second lease renews every 5 seconds. Success schedules the next cycle after one second; failure retains the generation and defers retry by 5 seconds. A lost BullMQ job is recovered from this row. Do not run maintenance with another installation ID for this installation and database: that creates an independent cycle.

The cycle lease does not replace domain financial locks or individual-action idempotency. After lease loss, an in-progress network call may finish; the corresponding domain procedure still checks permission to post or complete purge. An old owner cannot confirm completion of a taken-over cycle.

### Application queue state snapshot

`GET /v1/admin/execution-metrics` requires operations:admin and a token without account_ids restriction. Scope derives from token organization/application; other applications' data is excluded. The response contains sampled_at, window_start, and one row per text/image/audio/tools. This is a PostgreSQL read without Redis calls or settings-write permissions.

Current metrics: waiting, active_leases, running, remote_pending, paused, unknown, waiting_rate_limit, oldest_wait_seconds, oldest_unknown_seconds, unsettled_terminal. The last counts completed execution with unfinished settlement; it does not declare every such case an error. Old unknown and unsettled cases stay visible beyond the 24-hour window.

unpublished_due and oldest_unpublished_seconds count only current dispatch generation, due_at already reached, and waiting BullMQ requests. Old generations and future retries do not increase this delay. first_dispatch_wait_p95_ms and dispatch_samples_24h cover requests first dispatched within the last 24 hours; without samples, percentile=null. This delay includes quotas and slot waiting, not platform overhead alone. failed_24h counts failed requests financially closed in this window, not provider HTTP errors.

Counters describe current domain state, not BullMQ job counts. active_leases does not equal paid external calls because a lease may belong to a native-job observer. The endpoint does not yet replace PostgreSQL/Redis latency metrics, 429 history, or observation charts; Queue contains a compact snapshot refreshed every 15 seconds and manually. A refresh error retains the previous snapshot with a warning; missing data is not replaced with zeros.

When admission fails because a provider concurrency slot is occupied, the next check is scheduled within one second. This is not another provider call: admission rechecks current slots and quotas. Protective `slot_expires_at` for an uncertain remote request remains intact; it must not delay reuse of a slot already released by confirmed completion.

Recovering an expired request lease in `leased`, or cancelling/expiring an unsubmitted request, releases current and earlier fence concurrency slots with no execution attempt or unknown marker. The check runs under the request lock, preventing an old worker from subsequently recording submission intent. Slots with recorded submission intent and uncertain-submission slots remain held. Returning such a request to the queue creates no charge. This covers admitted and intent: Redis may already have accounted demand despite PostgreSQL retaining intent after a lost acknowledgement. Migration 0048 expands the index for both states. Migration 0047 preserves immutable unused_at. Before a new single/bundle admission, the group removes corresponding demand from local Redis counters and marks unused_refunded_at. Response loss or SQL rollback permits safe retry. Redis recovery excludes these admissions even after refund. Provider-header remainder is not increased because the observation may already have excluded the unsubmitted request; it stays conservative until the next observation or reset. Refund occurs at the group's next admission, not in a separate background process.


### Provider quota group settings

`GET /v1/admin/provider-quotas` shows token-organization groups, their rules, bound connection/model, held slot count, and provider pause. It requires `operations:admin`; account_ids-restricted tokens are prohibited. `held_slots` includes protective holds after unknown outcomes and is not the count of running BullMQ jobs. This is a PostgreSQL snapshot, not a Redis remaining RPM/TPM estimate.

`PATCH /v1/admin/provider-quotas/{id}` additionally requires `config:write`, idempotency key, `settings_revision`, and reason. Currently it changes name, source, source verification date, and concurrency limit. Migration 0040 separates `settings_revision` from rules revision: renaming and concurrency do not invalidate recorded admission intent. Revision or name conflicts return 409; changes are audited. New admissions use current concurrency; running work is not cancelled.

Admin exposes Providers → Provider quotas with a group selector, rules table, models, and compact form. The old limiter remains under Legacy rate limits. The table edits provider limit and our share. Empty provider limit means unknown, not zero quota. Our share cannot exceed a known provider limit.

`PATCH /v1/admin/provider-quotas/{id}/rules` requires `config:write`, `operations:admin`, idempotency key, `rules_revision`, and reason. Its body sends the entire existing set of rule keys with `capacity` and nullable `provider_capacity`, integers as strings. Migration 0041 stores provider capacity separately. The command changes capacity only, increments rules revision, and audits it. Keys, metrics, windows, admission history, and recovery epoch are preserved. Reducing limits blocks new admission until spending becomes permissible; a previously issued valid admission remains valid. Changes do not reset consumption, including after Redis recovery from PostgreSQL.

Creating/deleting rules and groups, changing metrics/windows, a binding editor, Redis remainder, and ready Tier 4 templates are not implemented yet. Lease/unknown safety holds are currently read-only; changing them requires preserving previously issued admission parameters.

Migration 0042 coordinates binding changes by connection/model pair. Admission proof checks take that pair's shared advisory lock through the submission-intent transaction. A PostgreSQL trigger takes the corresponding exclusive lock on INSERT/UPDATE/DELETE, including direct configuration changes. Moving a binding locks old and new pairs. Changing an independent model does not wait for another admission check. This is not a binding editor: group compatibility checks and consumption preservation during moves still require separate implementation. The migration must precede code using quota_binding_lock_key.

Internal `QuotaStore.snapshot` reads local remainder without admission creation or Redis recovery. Recovery epoch is checked; time comes from Redis TIME. Each rule returns current-window consumption, local-limit remainder, and availability considering conservative provider limits and cooldown. This is a diagnostic estimate, not a promise to admit the next request. The provider limit already includes local submissions after observation; it is not raw header remaining. `observed_at` retains the date of the latest received observation participating in the merge, not replay time. Old entries without a date return null.

Diagnostic reads are bounded by 10000 events per rule and 32 rules per group. Exceeding returns `too_many_events` without numerical remainder; missing recovery epoch returns `not_ready`. Reads neither delete events nor extend TTL.

`GET /v1/admin/provider-quotas/{id}/snapshot` requires `operations:admin`, prohibits account-restricted tokens, and checks group organization before Redis access. Responses are not cached. The API holds no SQL transaction while reading Redis; afterward it rechecks rules revision/recovery epoch. Concurrent changes return `configuration_changed` without numerical remainder. A PostgreSQL group pause also reduces availability to zero. Without REDIS_URL/UAI_INSTALLATION_ID, return `not_configured`; Redis errors return `unavailable` without connection details.

Current availability under Provider quotas reads only the selected group, refreshes every 15 seconds, and has a manual button. Late responses from the previous group are ignored. Refresh errors mark retained values stale; revision mismatch removes numbers and requires refreshing group settings. Used, Local remaining, Available now, and the active provider observation date/reset are separate. This passed separate desktop component QA; full admin shell and mobile remain separate checks.

### Confirmed execution counters

Internal ProviderResult may contain `limit_usage`: separate integer counters requests/input_tokens/output_tokens/tokens/images/audio_seconds. They are not derived from price or normalized monetary items. The OpenAI adapter copies explicitly received input_tokens/output_tokens, checks safe range and total_tokens consistency if present. Missing counters do not become zero; incomplete cache breakdown may leave monetary usage unknown while total tokens are known.

Valid counters are saved in quota_result_feedback without output, prompts, or arbitrary adapter fields. Replay receives the same values. Migration 0043 pins rule_metrics in new single/bundle admissions; the snapshot is protected from changes. Old admissions retain an empty snapshot; historical metrics are not guessed from current configuration.

Migration 0044 adds quota_usage_adjustments. Confirmed excess above original demand is recorded as separate positive deltas. Duplicate or lower counters add no delta and refund no quota. A higher late counter adds only the difference beyond the recorded maximum. Original demands and fingerprint remain immutable.

Migration 0045 prohibits UPDATE of adjustment facts: identifiers, rule, confirmed quantity, delta, window, and observed_at. Only service marker applied_at can change; resetting it must not double-count consumption. This protects existing records, rather than defining retention or prohibiting DELETE. Still-active adjustments must not be deleted: Redis recovery uses them as a consumption source.

For single-group and bundle admission, SQL validation and SQL confirmation are now separate short transactions. Redis recovery, headers, adjustments, refunds, and acquire run between them. Group session advisory locks and one existing PostgreSQL pool connection remain held, but no SQL transaction or request-row lock stays open. After Redis, lease, cancellation, deadline, revision/epoch, concurrency, and cooldown are rechecked. Bundle also checks membership and coordination domain; all groups are confirmed in one short transaction after checking each. Confirmation rejection leaves a provably unsubmitted intent for quota refund; a lost Redis response preserves uncertainty.

This path requires direct PostgreSQL connection or session pooling: transaction pooling does not preserve session advisory lock ownership. The pool releases locks in finally; a lost connection is removed from the pool. Both admission variants still occupy one pool connection during network waiting. Bundle locks its ID first, then groups in the same order as intent recording, releasing in reverse order. pg_terminate_backend checks cover connection loss during delayed recovery-gate opening and acquire for single/bundle: the new owner confirms admission, the old gets no proof, and duplicate consumption is prevented. This is not full PostgreSQL outage or simultaneous Redis restart testing. Late replay preserves the maximum of submitted and recorded consumption timestamps in one Lua script; an old owner cannot move the window backward. Fingerprint mismatch during recovery fails closed.

The delta belongs to a window starting at durable result observation, not request submission: a long response does not immediately release newly confirmed excess. This is conservative local policy, not a claim about the provider's exact internal algorithm. Provider observation is additionally reduced by the delta once. After window expiry, replay does not restore old excess.

An adjustment is first committed in PostgreSQL under the group lock, then applied by an atomic Redis script with its own idempotency key. Lost acknowledgement is safely retried. Every new single/bundle admission applies pending corrections before checking remainder. During Redis recovery, replay includes original demands and recent adjustments before opening the recovery gate, then restores provider headers. Old admissions with unknown rule_metrics are not reinterpreted. Counters for unknown metrics are not guessed from monetary usage items.

### Creating a quota group

In Provider quotas, New quota group creates a group with name, provider, limit source, concurrency, and rules. Each row specifies metric, period, provider limit if known, and our limit. API POST /v1/admin/provider-quotas supports 1–32 rules and requires administrative rights, reason, and Idempotency-Key. Names are unique within the organization; group, rules, and audit commit atomically. checked_at stays empty if the source has not been verified.

Creating a group assigns no models and changes no active routes. Coordination domain groups quotas for atomic checks of one provider account; it is not an API credential. Do not put secrets in names, sources, or scopes. Editing existing capacities preserves accumulated consumption; creating a new group is not a way to transfer current consumption between groups.

### Changing quota bindings through the API

GET /v1/admin/provider-quota-bindings accepts connection_id and model and returns bindings_revision. PUT on the same resource accepts this revision, group_ids, reason, and Idempotency-Key. The connection must belong to the token's application; changes require operations:admin and config:write without individual-account restrictions. Groups belong to the connection's organization and provider; the model must be active in the application's published catalog. Multiple groups require a common coordination domain. An empty set removes bindings and leaves future admission without an authorizing group.

Removing a group is rejected with quota_binding_usage_active while it contains consumption within an active window, uncertain intent, or held calls. The check covers the whole group even when other models share it. It is not a counter reset. Adding a group changes requirements for preparing subsequent external attempts; an old proof lacking it becomes invalid. Submitted attempts preserve their original admissions and financial terms. In Provider quotas, Assign models opens connection/model selection, then a group list. Save assignments saves the entire set. Revision conflicts preserve entered data; Reload assignments explicitly loads current assignments. Changing models discards late responses from the previous selection.

### Changing quota rule membership

`PUT /v1/admin/provider-quotas/{id}/rules` replaces a set of 1–32 rules, including key, metric, and period. It requires `rules_revision`, `reason`, `Idempotency-Key`, and `operations:admin` + `config:write`. All changes and `quota.rules.replaced` audit commit in one transaction under the group lock. Unchanged structure uses the existing numerical-limit update path and preserves recovery epoch.

Structural changes have a conservative current-implementation restriction: no consumption or provider observations within the last 25 hours, unfinished calls, unknown intents, undelivered adjustments/results/observations, or active cooldown. Otherwise the API returns `409 quota_rules_usage_active`. This window matches Redis recovery history and includes a possible new daily rule. Safe replacement creates a new recovery epoch; original admissions and financial records are not rewritten. Existing rules' numerical limits can change without this pause. In Provider quotas, Edit rule limits opens a table with metric selection, key, period in seconds, limits, and row deletion. Add rule adds a row. The form selects PATCH for numerical changes or PUT for structural changes and preserves entered values and command key on error.

### Moving from a global lock to account locks

Quoting, settlement/observation, request cancellation, spending suspension, and content deletion with a known account use `lockExecutionAccount`. The key includes organization, application, and account as JSON in a separate advisory-lock namespace. The lock precedes account/wallet/request rows. Submission preparation and targeted BullMQ job leasing take it in shared mode; financial changes use exclusive mode. Upgrading shared to exclusive inside a submission transaction is prohibited; an expired request closes in a separate transaction.

Attempt preparation and result processing also serialize by organization and endpoint scope before incident/exposure budget rows. This preserves one lock order for shared provider budgets and incident recovery. Different accounts without a conflicting shared resource can commit independently.

Global scheduler barrier 41827430 is removed from runtime code. Legacy lease and native poll use a separate short `legacy-capacity` lock to check available capacity. It does not participate in quoting, settlement, or BullMQ. Active legacy and BullMQ jobs count against their respective transport limits; shared provider quotas and exposure budgets remain separate protection. Switching from the old global-barrier version requires stopping old processes: simultaneous old/new locking protocols are unsupported.

Scheduler financial maintenance now selects up to 256 accounts with overdue work and processes each in a separate transaction: held credit-revocation incidents, operation closure, request deadlines, and unknown financial closure. With a supplied scope, only that account is processed. Exclusive account barriers use try-lock; busy accounts defer until the next cycle. Row-lock waiting is limited to 250 ms: lock_timeout rolls back the entire account transaction while the pass continues with others. Other errors are not hidden; completed accounts remain committed, and another cycle rechecks the database.

Scheduler results contain `maintenance_accounts` and `maintenance_busy_accounts`. Content cleanup uses a separate transaction without holding financial locks. Compatible direct unscoped maintenance calls iterate available account locks; the normal scheduler passes a specific scope to every financial operation. Admin wallet and operation lists already read records in separate transactions; legacy lease uses a separate capacity lock. The 256 limit counts selected accounts per cycle, not installation users; busy accounts count toward it.


Administrative lists `/v1/admin/wallets` and `/v1/admin/operations` first authorize and select up to 100 IDs in original order, then read each record in its own transaction. The previous record's financial locks release before the next. Each row is internally consistent; the whole list is not one atomic point-in-time snapshot. Refresh obtains new values. operations:admin, prohibition of account-restricted tokens, and organization/application isolation are preserved. spending_suspended is read under the same account-row lock as the wallet.

Manual recovery-incident resume locks its endpoint scope before modifying the incident row. It does not take a global exclusive scheduler barrier; unrelated endpoints may resume independently, while the same scope serializes with dispatch and result processing.


### Incremental recalculation of large quota windows

One admission command reads at most 4096 events to restore aggregates, partially remove expired events, and find the next admission time. With more work, Redis saves intermediate recalculation in a derived aggregate; the client issues another short command. Until every rule is checked, neither permits nor provider-observation consumption are created. The final command rechecks all groups, epochs, replay, current totals, cooldown, and headers, then atomically accounts admission.

Adding authorized consumption changes aggregate revision; recovery, usage adjustment, and refunding unused admission reset the aggregate and intermediate recalculation. Event expiry updates revision and resets denial calculation. Thus another command between passes cannot complete admission from stale state. Intermediate JSON totals are strings so Lua cjson does not round large integers.

The client bounds total preparation to 20 seconds while individual Redis-command timeout stays standard. Unfinished preparation returns not_ready without a new permit; durable intent remains recoverable. Recalculation after aggregate loss may take seconds but must not hold Redis with one long Lua command. Read-only shadow preview is limited to 10 000 total events across all rules; exceeding returns unknown / too_many_events, not permission or zero consumption.

### Quota recovery after Redis restart

The recovery gate contains PostgreSQL recovery_epoch and the current Redis run_id. Lua scripts read run_id through `INFO server` in the same atomic command that checks the gate. After restart or switching processes, the old gate is invalid even if retained in AOF. Durable admissions, adjustments, and observations are restored from PostgreSQL before new admission. An old recovery handler cannot open the gate or restore demands after run_id changes.

The quota client's Redis ACL must allow `INFO` alongside used Lua and data commands. INFO rejection stops admission rather than permitting an unchecked call. Compatibility with managed Redis prohibiting INFO inside scripts is unconfirmed. Deleting individual keys on a running Redis while keeping the gate is not detected; manual partial quota-namespace cleanup is prohibited. An update changes gate format; mixed old/new binary operation is untested.

`DATABASE_URL=… pnpm test:redis-restart` runs a Docker fault test with a separate temporary PostgreSQL database and its own Redis 7.4 with AOF. It verifies normal restart, rollback to old AOF, and restart during recovery. Shared installation Redis is not restarted. Set `UAI_TEST_REDIS_RESTART=1` to include it in the full run; this Docker test is skipped by default. Additional scenarios verify waiting BullMQ job recovery after complete Redis data loss and AOF rollback. An old snapshot retains a job for an already charged request; delivery neither calls the provider again nor changes the charge. New missing jobs recover from PostgreSQL. These checks use a synthetic text provider and do not replace active-job testing across hosts.


In `packages/queue/test/crash.test.ts`, the stalled scenario uses BullMQ's normal timer after worker SIGKILL. Redelivery of the original job does not authorize another call when PostgreSQL already stores submission intent and outcome_unknown. The check takes about a minute; it does not manually add a duplicate job or change the Redis lock. The fixture forcibly expires durable request lease, so it does not measure full operational PostgreSQL lease recovery time.


### Full PostgreSQL outage check

`pnpm test:postgres-outage` starts separate PostgreSQL 17 and Redis 7.4 in Docker, applies migrations to an empty test database, and stops the entire test PostgreSQL after a synthetic-provider call. Shared application database and Redis are untouched. `UAI_TEST_POSTGRES_OUTAGE=1` includes the scenario in the full run.

During outage, a new job does not call the provider, publication fails, and the API returns `503 platform_unavailable` for recognized connection-unavailability errors. The response permits retry with the same idempotency key. HTTP status cannot determine a command's outcome after connection loss: retry with a new key may create another operation.

After PostgreSQL restarts, the previously unsubmitted request recovers from failed BullMQ delivery and completes. A request with submission intent remains outcome_unknown after lease recovery even if the worker received a response it could not save. Its reservation remains, no unconfirmed charge appears, and a duplicate job does not create another generation. The test accelerates durable request lease expiry, so it does not measure operational recovery duration. It does not replace PostgreSQL replica failover or multi-host network partition checks.


### Ready queue delay

Migration 0049 adds execution_dispatches.first_leased_at. A successful BullMQ lease saves its first timestamp in the same transaction as request fencing; duplicates do not change it. Old deliveries retain NULL; historical time is not guessed.

`GET /v1/admin/execution-metrics` returns queue_wait_samples_24h and ready_queue_wait_p50_ms / ready_queue_wait_p95_ms. This is the time from a delivery's due_at to its first worker lease. Scheduled Retry-After before due_at is excluded. Waiting for a free worker and local capacity after due_at is included; subsequent admission and provider execution are excluded. Multiple generations of one request each have their own delivery sample. This is not the sum of all request delays.

Metrics use leases within the past 24 hours and token organization/application scope. No samples means nullable latency, not zero delay. First start also now has first_dispatch_wait_p50_ms in the API; earlier p95 semantics remain. Queue status has a separate Ready queue column showing p50 / p95 and delivery count alongside First start p95. Refresh failures preserve the previous snapshot with a warning.


### Persisted HTTP observations and recovered deliveries

Migration 0050 adds provider_http_observations. The HTTP adapter callback stores only attempt_id, sent/received time, and status 100–599. Response bodies, inputs, credentials, and headers never enter this table. Recording precedes quota-header owner selection; multiple route groups do not multiply HTTP samples. Repeating the same attempt/sent_at/received_at creates no second record.

Execution metrics return http_observations_24h and http_429_observations_24h for observations received within 24 hours. UI labels are Observed HTTP 429 and response count. Confirmed HTTP 429 includes billing/quota responses with that status; local rate-limit waiting is not a 429 response. Missing observations display No HTTP samples. Statistics do not reconstruct old-version responses or responses lost during database outage; an adapter without HTTP callback lacks this coverage. These counters are not a complete provider report.

recovered_execute_deliveries_24h counts only new deliveries created by execute reconciler after detecting a missing/completed/failed/unknown transport job for a waiting request. recovered_at is atomically saved in the new delivery. Normal retry generations and old records without this marker do not count as recovery. Native observation and maintenance jobs are excluded. UI shows the number under Not published as restored / 24h. Both metric groups are scoped to token organization/application; request/attempt IDs do not become metric labels.


### Worker process heartbeat

Migration 0051 adds execution_worker_heartbeats. A BullMQ `apps/worker` process sends heartbeat every 10 seconds for every serviced queue: process worker_id, concurrency, active_jobs, and running/draining/stopped state. Hosts, Redis addresses, credentials, and request IDs are excluded. First heartbeat is sent at startup; observation errors neither authorize submission nor change financial state. At most one periodic heartbeat runs per process at a time.

Active jobs count running handler callbacks, including SQL/admission waiting; this is not provider-submitted request count. On SIGTERM/SIGINT, the process stops intake, marks draining, and records stopped after handlers finish. SIGKILL leaves no stopped marker, so freshness is judged by last heartbeat. The normal shutdown watchdog still bounds total shutdown time.

Execution metrics contain nullable workers. Without UAI_INSTALLATION_ID in the API, workers=null. Otherwise only this installation appears, across all its applications, separately from application-scoped request metrics. Existing operations:admin rights and no account restriction are required. workers has its own PostgreSQL-clock sampled_at. Heartbeat timestamps and freshness checks use PostgreSQL rather than API/worker host clocks.

Heartbeat younger than 45 seconds contributes to alive_workers; draining_workers is its subset. configured_concurrency sums only fresh running workers; active_jobs includes fresh running/draining. Records older than 45 seconds but younger than 24 hours appear as stale_workers. Stopped is excluded from alive/stale. At startup, workers clean heartbeat records for their installation older than 7 days; financial and request data are untouched.

Queue status has a Worker processes block showing six queues, live processes, busy handlers, configured slots, and draining/stale. This is process heartbeat, not proof of Redis/provider availability or a promise of extra quota capacity. With database outage, observations become stale; work is not declared healthy merely because a process previously existed.


### Admission latency and infrastructure probes

Migration 0052 adds heartbeat telemetry. Worker admission uses monotonic performance.now measurement from entering quota broker to allowed/denied/error. Time includes SQL locks, recovery, and Redis admission, but excludes queue time before worker lease and provider execution. Return values and exceptions remain unchanged; telemetry recording is not awaited on the admission path.

Each worker queue retains at most 256 latest samples younger than 15 minutes. Denials and errors belong to the same sample, not daily event counts. The snapshot is replaced at heartbeat; a crash before the next heartbeat may lose samples. This is diagnostics, not a financial journal. The API combines raw samples from fresh running/draining workers of one installation and calculates p50/p95. Worker percentiles are not averaged. Stale/stopped processes are excluded, including one fresh queue and another stale queue on the same worker.

Before periodic heartbeat, two independent probes run: SELECT 1 through the existing PostgreSQL pool and Redis PING through one extra Redis connection per worker. Redis command timeout and PostgreSQL query timeout are 1000 ms; waiting for a PostgreSQL pool connection is separately bounded by UAI_DB_CONNECT_TIMEOUT_MS. The Redis probe connection has an installation client prefix, no offline queue, and closes at worker shutdown. Database measurement includes pool waiting, so it is a client round trip rather than pure server SQL time.

In the API, admission_samples/admission_p50_ms/admission_p95_ms/admission_denied/admission_errors describe the live admission sample. db_probe_p95_ms/redis_probe_p95_ms calculate p95 of latest successful probes of fresh workers for that queue. This is the distribution of current probes across workers, not all SQL/Redis command history. db_probe_failures/redis_probe_failures count workers whose latest probe failed. Pending/failed probes have ms=null; missing results do not become 0 ms. During PostgreSQL outage, heartbeat cannot be saved and becomes stale in its entirety.

Worker cards show admission p95 and sample count, admission denials/errors, probe p95, and failed probes. These fields cannot authorize submission or financial settlement.

### Separate-container and shared-S3 checks

`pnpm test:containers` builds current `Dockerfile.runtime` and runs separate PostgreSQL 17, Redis 7.4, MinIO, two API replicas, scheduler, generation worker, and maintenance worker. It requires Docker and OpenSSL; primary `DATABASE_URL` and shared Redis are unused. To include it in a full run after image build, set `UAI_TEST_CONTAINERS=1`. This infrastructure test is skipped by default.

Runtime containers run as `node` with read-only root, separate tmpfs, and no shared content directories. They receive only temporary MinIO's public certificate; its private key is available to the MinIO server. S3 verifies TLS through `NODE_EXTRA_CA_CERTS`; certificate checks are not disabled. All temporary containers, network, and certificates are removed when the test finishes.

Checks include upload through API A and upload completion through API B, identical result bytes read by both replicas, synthetic-worker generation, read blocking and physical S3-object deletion after ACK, TTL, and explicit operation deletion. TTL changes only the test asset expiry in the isolated database. Financial records and attempt counts survive content deletion. The image must also serve `/openapi.json`; the specification is included in the runtime image.

This test establishes process, filesystem, and network-namespace isolation of containers on one Docker host. It does not establish operation across VPSs, host network partitions, Docker-host failure, or chosen VPS-plan performance. All test providers are synthetic.

### Moving a waiting request between backends

`scripts/transition-request-backend.ts` moves an individual request for which no external attempt has ever been created. By default, it only shows backend, generation, status, and migration eligibility:

```sh
node --import tsx scripts/transition-request-backend.ts \
  --organization ORG_ID --application APP_ID --account ACCOUNT_ID --request REQUEST_ID
```

To apply, add `--apply --from bullmq --to legacy --generation 0 --actor OPERATOR --reason 'Rollback reason'`, using backend and generation from a fresh preview. Reverse migration uses `--from legacy --to bullmq`. The command is available in the runtime image; Compose can run it through `run --rm migrate node --import tsx scripts/transition-request-backend.ts` with the same arguments. Incomplete arguments prohibit changes; stale generation returns `revision_conflict`. After a lost response, reread preview first; do not automatically substitute a new generation.

Migration takes account/request locks, repeats checks, increments transport generation and domain fence, marks proven-unused admission intents for refund, and records audit/event in the same transaction. Redis is not called within it. Moving to BullMQ creates a new durable dispatch intent. Old Redis jobs remain safe stale notifications. Accepted quote, route, input, deadline, next attempt time, and financial records remain unchanged.

Leased, submitted, running, unknown, finished, cancelling, and expired requests cannot move. A request with any previous attempt stays on its original backend even if waiting again. Old workers must finish or recover those requests. The command does not switch new-request admission or replace the plan's mock → shadow → demo sequence. Before rollback, stop new BullMQ admissions and verify legacy limiter/configuration; legacy backend does not automatically receive Redis quota policy. The described tests did not run the command on the primary installation.

### Shadow admission forecast without a second permit

`providerAdmission(...).preview(scope, request, variant, context, adapter)` uses the same `estimateLimitUsage` and rule-vector construction as real admission. It reads bindings, rules, occupied slots, and recovery state. Redis performs the same weighted-window, header, and cooldown checks through `EVAL_RO`; preview neither deletes old events, changes TTL, reduces provider remaining, nor creates admission keys. Joint groups are checked in one call with a shared coordination domain.

The result contains `mode: shadow` and `would_allow`, not `allowed`/`admission_id`. `null` means the conclusion is unreliable: Redis gate is not restored, configuration/occupancy is changing, unprocessed quota observations/adjustments/intents exist, infrastructure is unavailable, or the diagnostic read limit exceeds 10 000 events for one rule. Preview neither opens the gate nor starts recovery. Submission always requires ordinary durable admission.

PostgreSQL and Redis provide no shared atomic snapshot; preview rereads SQL configuration after Lua, but remains an observation, not a future admission guarantee. Active slots and cooldown are additionally checked in PostgreSQL. Two concurrent previews may show the last slot available; only one actual admission receives it.

Integration tests compare preview with subsequent actual admission on synthetic requests, including cold gate, quota exhaustion, and occupied provider slot. They check absence of additional intents/permits/attempts and duplicate calls. Preview is disabled by default; enabling it in BullMQ worker is described below. Legacy demo is not covered by this observation. It reads the new mechanism's journal and does not reconstruct unknown legacy/external consumption; this API alone does not complete real-transition shadow observation.

### Enabling worker shadow observation

`UAI_QUOTA_SHADOW=true` compares preview with the single actual admission in BullMQ worker. The default is `false`. Other values are rejected; enabling it on a legacy worker is also rejected to avoid a false impression that legacy consumption is counted. Add the flag to the relevant worker's protected runtime env file and restart that process through normal drain procedure.

Worker writes `quota.shadow` JSON events to stdout. Fields: request_id, worker_id, queue_kind, time, shadow/actual decision and reason, preview duration, matches. Prompts, files, access keys, and admission_id are excluded. To view in Compose:

```sh
docker compose -f deploy/compose.workers.yaml logs --no-log-prefix generation \
  | jq -R 'fromjson? | select(.event == "quota.shadow")'
```

`matches: true` means allow/deny matched; `false` means a difference; `null` means comparison was impossible. Cold gate initially yields unknown; subsequent actual admission restores it normally. A difference does not itself prove a bug: remainders, rules, or occupancy may change between observation and admission. Investigate it with reasons and timestamps. Actual-admission errors are retained and not replaced by preview results.

Preview waiting is bounded to 500 ms. While a slow check remains unfinished, new calls on the same worker queue receive `preview_busy`; extra checks do not accumulate. Timeout returns `preview_timeout`; exceptions return `preview_failed`. The request performs only ordinary admission; shadow does not alter its response or exception. Preview time is logged separately; admission latency still measures actual admission. These diagnostic best-effort events are not a financial journal or guaranteed to survive process crashes.

For local transition, enable the flag first on a synthetic setup, check comparable events and absence of additional attempts/charges. Enabling does not migrate legacy requests or change API backend settings. The primary demo was not switched in this check.

### Limiter slots and unknown outcomes

The legacy backend limiter (`execution_limiters`, `concurrency_limit`) counts `submitting` and `running` attempts. An `outcome_unknown` attempt occupies a protective slot while its result may still arrive: until request financial closure and no later than request deadline plus grace. For synchronous calls, grace is 5 minutes (`UNKNOWN_SLOT_GRACE_MS`): runtime interrupts the call at deadline, while grace covers work the provider may continue. A remote-job attempt has polling-window grace, 1 hour after deadline (`REMOTE_OBSERVATION_WINDOW_MS`). Protection from worker-crash verification remains while an outcome may arrive; indefinite holding is removed. BullMQ admission still releases unknown slots according to quota-group `slot_expires_at`.

When `closeUnresolved` closes a request as `platform_absorbed`, its `outcome_unknown` attempt becomes terminal `abandoned` in the same transaction. Request execution status stays `outcome_unknown`. Late provider responses are still recorded: `observeAttempt` accepts an `abandoned` attempt while its cost is unknown and creates no customer charge. Migration 0073 moves attempts financially closed before this change to `abandoned` and adds a partial index of open attempts by limiter key.

`GET /v1/admin/execution-metrics` returns `limiters`: for every limiter used by published routes or active application attempts, `concurrency_limit`, `held_slots` (as counted by admission, including other applications sharing the key), `unknown_held_slots`, and `oldest_unknown_held_seconds`. Per-queue `rate_limit_starved_24h` and `admission_timeout_24h` count requests with no attempts closed at deadline while waiting for limiter or admission. `attempt_timeouts_24h` counts attempts interrupted by `attempt_timeout_seconds` (migration 0074, `execution_attempts.timed_out_at`). Growth indicates hanging provider calls; attempts retried after timeout without idempotency may have been charged twice and require reconciliation.

`limiter.unknown_slots_held` observes the same limiters; its value is `unknown_held_slots`, compared as “greater than threshold.” A numerical signal requires a threshold. Threshold `0` with severity critical reports any hold; the incident closes automatically when slots release.

Unknown outcomes are resolved through a reasoned audited command rather than row edits:

~~~json
{
  "attempt_id": "att_123",
  "provider_charged": true,
  "cost_units": "7000000",
  "reason": "Call appears in the provider usage export"
}
~~~

Send this body to `POST /v1/admin/requests/{id}/resolve-unknown` with `operations:admin` and `Idempotency-Key`. `cost_units` is required exactly when `provider_charged: true`. Embedded installations call `resolveUnknownAttempt` from `packages/execution`. The command accepts an `outcome_unknown` or `abandoned` attempt whose cost is still unknown. While a worker or observer leases the request, it returns `request_leased`. Provider cost closes open exposure; the customer is not charged. An open request closes financially as `platform_absorbed` if the provider charged, otherwise `settled`. The attempt becomes `abandoned` with known cost, its slot releases, and `audit_events` records `attempt.unknown_resolved` with prior status. Repeating the same body returns the previous result; a different body gives `observation_conflict`.

## Quota wait reason

Migration 0053 adds `execution_requests.quota_wait`. On admission denial, the worker saves group, rule, metric, window, demand, availability, limit, and check time. This is a denial-time snapshot, not current availability: settings changes do not rewrite it. A new lease clears it; the next denial saves a new check. Unknown availability remains `null`.

Data is available in scoped `/v1/admin/queue`; public request API and SSE do not expose internal groups or rules. The admin reason column displays values labeled `At last check`. Infrastructure rejection without measurements shows only the reason.

## Outbox processing delay

`GET /v1/admin/execution-metrics` returns `notification_outbox.pending` and `oldest_pending_seconds` for the current application. These are events `consumeExecutionEvents` must process but not yet present in `notification_event_consumption`. Event types are shared with the consumer. Age covers the entire backlog, including events older than 24 hours; an empty queue returns zeros for both. Future timestamps are excluded.

This complements execution-dispatch publication delay. It does not mean webhook delivery delay: created notification deliveries have their own states. SSE has no shared delivery marker; each client reads durable events with its own cursor. A separate counter below represents settlement errors; `unsettled_terminal` represents unfinished settlements.

## Settlement errors

Migration 0054 adds `execution_settlement_errors`. An exception inside `settleRequest` records diagnostics after successful ROLLBACK of the outer transaction. Failed diagnostics do not replace the original error. Request/scope, time, and domain/infrastructure category are saved without exception text or inputs. Database unavailability means recording is not guaranteed; a safe log reports `postgres_rollback_diagnostic_failed` or `postgres_rollback_failed`.

`settlement_errors` in execution metrics contains total/domain/infrastructure over 24 hours for the current application. It counts recorded failed calls, not unique requests or `unsettled_terminal`. A COMMIT failure after successful settlement is not classified by this counter as calculation failure. Old-record deletion and monitoring of diagnostic losses require an operational policy.

## Compatible financial maintenance sweeps

Unscoped `closeExpiredOperations`, `expireRequests`, `closeUnresolved`, and `reconcileRevocationHolds` select overdue accounts and try their locks in stable order. Busy accounts are skipped until the next call; these sweeps no longer use an installation-wide exclusive lock. Runtime should use `financialMaintenance`: a separate transaction per account with bounded row-lock waiting. Compatible calls inside one outer transaction hold acquired locks until it ends. The shared compatibility barrier is removed; legacy lease/native observation serialize only with each other on a separate capacity lock.

## Tier 4 templates

The group creation form offers seven OpenAI Tier 4 templates. Public initial values and sources live in `packages/contracts/src/quota-templates.ts`. A template populates a new group's fields without changing existing bindings. Before binding, verify account/project overrides and shared model groups.

## Paid API extension

Contract PA-I01, units, periods, allowance reservations, and compatibility boundaries are described in the [paid API contract](PAID_API_CONTRACT.md). Implementation status and stable PA-A01–PA-A25 scenarios appear in the [plan](PAID_API_PLAN.md). A draft contract does not establish that new HTTP handlers are available.
