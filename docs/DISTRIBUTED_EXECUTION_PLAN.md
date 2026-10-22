# Distributed execution and quota plan

Plan date: 2026-09-19. Status: implementation and required local acceptance completed on 2026-09-20. Historical results are consolidated in the [acceptance matrix](ACCEPTANCE_RESULTS.md). The main local installation switched to BullMQ and S3 and was checked through the API and demo. Final load verification ran locally; the owner excluded checks on real VPSs from the current objective on 2026-09-20.

## 1. Goal and boundaries

Move to BullMQ and Redis to deliver jobs to multiple executors. Keep PostgreSQL as the source of truth for operations, attempts, quotes, reservations, usage, results, and postings. Initial verification target: 30 simultaneously active users with mixed text and image tasks. Next verification level: 100 users without changing the financial core. These are testing targets, not a claim of measured performance.

The [product decisions](DECISIONS.md), [financial invariants](ACCOUNTING.md), [quoting rules](QUOTING.md), and [execution rules](EXECUTION.md) remain intact. One installation per application; a public multiuser SaaS and Logo Panel integration are outside this transition. Negative balances are permitted only under the already accepted estimated_actual policy. Changing transport does not change accepted prices or terms.

## 2. Existing capabilities and obstacles

- `apps/worker/src/index.ts` awaits `executeOne` sequentially; one process does not execute several synchronous calls concurrently.
- `packages/execution/src/index.ts` uses a shared scheduler advisory lock, including for dispatch, observation, and recovery. It cannot be removed without replacing budget, quota, and fairness protection.
- Durable requests, attempts, fencing, outbox, cancellation, recovery, and settlement exist. BullMQ statuses do not replace them.
- `execution_limiters` supports one group per route variant, requests and tokens within one window, plus concurrency. It lacks full joint admission across minute, daily, and image quotas.
- OpenAI uses shared test limiter `check.openai.run`; this does not represent real model quotas. Application/account limits also constrain throughput and must become explicit settings.
- The adapter reads quota headers, but the executor does not apply them to current throughput.
- Local files suit one host; multiple hosts require shared object storage.

## 3. Component selection

| Component | Responsibility |
|---|---|
| PostgreSQL | Finances, configurations, authorization of external attempts, states, audit, outbox, and recovery |
| BullMQ OSS | Delivery, delayed jobs, transport-job locks, handler-count limits |
| Redis | BullMQ state and atomic quota admission; separate namespaces, no key eviction |
| Workers | Provider calls, usage and result persistence, heartbeat |
| Dispatcher and relay | Fair selection of ready requests and outbox delivery |
| Scheduler/reconciler | Deadlines, lost leases, unknown results, financial closure, and delivery recovery |
| Object storage | Files and results for multiple hosts; existing TTL and deletion |

Do not add Bottleneck as a second queue. `rate-limiter-flexible` may independently limit incoming API traffic, but combining several of its counters is not considered a transaction. Provider admission requires a small separate module with one atomic Redis Lua operation covering all applicable rules. This clarifies the earlier off-the-shelf limiter proposal: a ready-made queue does not solve atomicity across different quota types.

BullMQ/Redis versions are pinned after checking Node.js compatibility, dependencies, licenses, and a failure test. BullMQ Pro features are not required dependencies.

## 4. Queues and concurrency

Installation queues: `text`, `image`, `audio`, `tools`, `observe`, `maintenance`. After submission, native asynchronous jobs move to periodic observation; neither the HTTP connection nor a worker is held between checks. Synchronous generation occupies a worker until the call ends.

Configure separately: process-local concurrency, overall capability limit, user and application limits, and provider-account quotas. Worker concurrency alone is not an OpenAI quota. Workers of different types start independently; waiting for a limit returns the transport job and does not hold a generation slot.

The dispatcher preserves fairness: it selects accounts in turn, considering job age and server priority. A bounded number of ready jobs per account and capability enters BullMQ. A million jobs from one user must not precede everyone else's work. The dispatcher scales across installations/capabilities; multiple instances in one scope use leases and short transactions. One application does not acquire a global lock on the entire installation.

## 5. Data and identifiers

Proposed new PostgreSQL entities:

- `execution_dispatches`: request, generation, transport, queue, due_at, delivery state. Unique request + generation + purpose.
- `provider_quota_groups`: provider organization/project scope, related connections and models, capability/service tier/context mode where applicable.
- `quota_rules`: metric, period, capacity, burst policy, source, verification date, version, and manual override.
- `quota_observations`: response source, send/receive time, group, safe headers, limits/remaining/reset.
- `dispatch_admissions`: idempotency key, request, attempt/fence, rules version, consumption vector, admission state, and deadlines.
- Explicit concurrency/fairness setting versions and a request `execution_backend` marker for migration.

Quota metrics: requests, input/output/total tokens according to the provider, images, and audio seconds when needed. One rule has one period; minutes and days are separate rules. One request may depend on several groups. Aliases and snapshots do not receive independent quotas if the provider groups them together.

Redis stores recoverable counters and admission IDs. BullMQ payloads contain only identifiers and delivery version, without API keys, prompts, or files. The job ID is deterministic from installation/request/generation/purpose, excluding characters forbidden by the selected version. Deleting completed jobs does not remove PostgreSQL deduplication.

## 6. Job path and atomicity boundaries

1. The API validates the quote and creates operation/request, financial claim, and outbox in one PostgreSQL transaction. Redis unavailability does not lose an accepted request.
2. Dispatcher/relay publishes the authorized transport job. Failure after enqueue but before acknowledgement permits redelivery with the same ID. Reconciliation repairs missed delivery from PostgreSQL.
3. The worker retrieves a specific request by ID and checks backend/generation, cancellation, deadline, and state. Execution no longer selects an arbitrary request through `leaseNext`.
4. In PostgreSQL, it obtains a domain lease and creates an admission intent without authorization for external dispatch. The short transaction ends.
5. One final Lua call checks and reserves every quota window. In the implementation, concurrency and unknown holds remain in PostgreSQL, protected by group session locks and the final transaction; a Redis permit alone does not authorize dispatch. Lengthy quota preparation runs in bounded passes before the final atomic check. Admission is idempotent by admission ID. Rejection consumes nothing partially and returns the blocking rule and earliest admission time.
6. In a new PostgreSQL transaction, it rechecks fence/deadline/cancellation and records risk budgets, the attempt, and submission intent. If checks fail, it releases only provably unused Redis admission; the reconciler handles this after a failure.
7. After commit and checking that admission remains valid, it sends the HTTP request. No SQL transaction is held during the network call.
8. It saves usage observations and the result and performs idempotent settlement and outbox recording under the existing contract. It acknowledges the transport job only after durable persistence.

PostgreSQL and Redis have no shared transaction. Failures may occur between steps: admission intent and the attempt journal distinguish safely releasable admission from potentially consumed admission. Admission validity and leases are extended; expired admission forbids new dispatch. Losing a lease after possible dispatch does not prove that execution did not occur.

## 7. Quota accounting

Proposed algorithm: a weighted sliding dispatch window per rule, plus short-burst limits and `blocked_until`. Redis TIME determines admission time. Lua checks the whole vector first, then records consumption. Window events are aggregated/deleted on expiry; memory is bounded by dispatch count in the longest period, not the number of waiting users. Detailed retention and maximum Lua-operation length are load-tested.

All atomic-admission keys are colocated. The first installation uses one Redis primary; in a future Cluster, keys in a shared admission scope must share a hash tag. Atomicity cannot be promised for rules spread across independent Redis shards. Sharding by independent accounts/installations is possible after measurement.

Quota estimation is separate from price estimation: `estimateLimitUsage` implements endpoint semantics. In particular, an expectation of 4096 output tokens is not a proven ceiling on actual consumption. Confirmed excess adjusts the local estimate; unknown billable usage does not replace quota observations. Successful completion does not return consumed minute quota.

Provider headers impose additional constraints on local admission. Responses may arrive out of order: availability can be reduced conservatively, but increased only considering reset and local dispatches after the observation. Do not assign `remaining` directly. External applications on the same account are invisible to the local journal, so 429 remains an expected feedback signal.

A transient refusal's `Retry-After` limits only the relevant scope; if unknown, use the connection's documented conservative scope. Insufficient quota/auth does not trigger minute-based retries. If demand exceeds a rule's full capacity, return `quota_request_too_large` rather than endless waiting_retry. For an already accepted request, settings may be corrected before deadline, or it may close terminally without a call and release the reservation.

## 8. Unknown outcomes, leases, and retries

BullMQ provides redelivery; this is not exactly-once external execution. The domain fence and PostgreSQL determine permission to start a new attempt. On redelivery, a completed request returns its saved outcome; a submitted attempt goes to observation rather than new generation.

Worker leases and provider occupancy are separate. After worker death, the local slot is released, but external work may continue. An unknown outcome has a separate bounded provider-concurrency hold until a documented maximum time or a result check. If the maximum is unknown, an explicit risk policy and group unknown-count limit are required; no group is held indefinitely. Financial closure after an hour does not declare the external job completed.

Automatic BullMQ retries are allowed only for infrastructure reentry through the domain check. Accepted execution policy, finite backoff/recovery, and overall attempt limits remain in UAI; the current contract is defined by the universal invocation plan. The scheduler records due_at and dispatch generation; a BullMQ delayed job wakes a worker. Periodic reconciliation restores a lost delayed job. Two independent owners of retry policy are forbidden.

## 9. Failures and recovery

| Failure | Behavior |
|---|---|
| Redis unavailable | New external dispatches stop; accepted jobs remain in PostgreSQL. The API explicitly shows infrastructure waiting |
| Redis data loss/failover | First close admission, then restore active and recent admissions from the database; if data is insufficient, wait for the window/reset. Empty Redis does not mean full quota |
| PostgreSQL unavailable before dispatch | The call is forbidden |
| PostgreSQL unavailable after dispatch | Redelivery does not repeat generation; recover the same attempt or mark unknown |
| Worker dies before submission intent | An expired intent may return to the queue after reconciliation |
| Worker dies after submission intent | Provider lookup/idempotency or unknown, including a crash immediately before HTTP |
| Job redelivered after settlement | No new call or postings |
| Cancellation in queue/delayed start | PostgreSQL closes the request; the stale job sends nothing |
| Process shutdown | Stop taking jobs, await a bounded grace period, preserve valid state; do not promise cancellation of remote execution |

Backpressure: bound backlog per account/application and overall queue age, returning a clear refusal before a new financial reservation. Redis recovery must not dispatch the entire backlog at once.

## 10. Initial configuration and growth

Values for discussion, not accepted operational settings:

- OpenAI Tier 4 as the starting template. GPT-5.6 Sol/Terra: published tables give 10,000 RPM / 4 million TPM; GPT-4.1: 10,000 / 2 million; nano: 10,000 / 10 million; each image model: 150 IPM / 3 million TPM. Shared groups and project overrides require separate confirmation; equal figures do not prove a shared group.
- Use 90% of confirmed quota as the initial technical margin, separately from the financial safety factor. The setting is visible and editable in the admin.
- Initial installation limit: 8 text + 8 image, with separate small tools/audio/observe pools. Per account: 2 active generations. The 30-concurrent-generation acceptance profile separately raises the limit to 30 when memory and quotas suffice.
- Multiple API and worker processes; an explicit total PostgreSQL connection budget, without a new pool per job. Limit memory and concurrent file processing; do not block the Node event loop with heavy CPU work.
- Redis with persistence, `noeviction`, separate access, and memory monitoring. For production requiring availability: managed Redis/PostgreSQL failover, backups, and tested recovery. Failover does not guarantee preservation of the latest writes.
- Multihost operation requires a shared S3-compatible blob store and shared secure credential delivery. Local disk remains only for a single-server demo.
- Autoscaling follows the age of jobs ready to run and worker utilization. Quota waiting is not a reason to add workers indefinitely.

## 11. Admin and diagnostics

Quota screen: provider/account, models and shared group, usage mode, metric/period, documented limit, our limit, locally estimated remainder, and dated provider observation. Editing uses revisions and audit. Quota changes apply to future admission and do not alter quotes.

In the queue: specific waiting rule, demand, availability, next_attempt, and deadline. Show worker, quota, recovery, and infrastructure waiting separately.

Metrics: queue depth/age by capability, p50/p95 waiting excluding provider wait, active workers, 429, admission latency, Redis/DB latency, outbox lag, unknown count/age, recovered jobs, settlement errors. Request IDs remain in traces/logs rather than high-cardinality metric labels. SSE is built from durable PostgreSQL events; BullMQ events serve operational diagnostics.

## 12. Implementation phases

| Phase | Result and transition condition |
|---|---|
| 0. Agreement | The owner requested implementation of the plan; queue limits of 20/200/15 minutes are agreed. Other proposed values are not confirmed merely because implementation has begun |
| 1. Transport contract | Execution by request ID and a transport interface are extracted; existing tests pass on the old backend |
| 2. BullMQ and outbox | Local Redis, dispatch-intent migrations, relay, and delivery recovery; mock provider only |
| 3. Concurrency | Capability pools, fairness, per-account limits, replacement of the common scheduler lock with scoped locks; existing invariants proven |
| 4. Quotas | Atomic admission, journal, headers, 429, Lua tests, Redis recovery, Tier 4 templates |
| 5. Interface | Quota/queue admin, SSE, clear demo errors; no technical keys in place of primary names |
| 6. Reliability and load | All scenarios below, report on fixed environment and settings |
| 7. Demo transition | Controlled switch of new requests, accepted/unknown verification, final report; paid checks only with separate authorization |

Code reference points: apps/worker, apps/scheduler, packages/execution, providers, db/outbox, runtime-config, contracts/API/SDK, admin/demo; a new transport and quota-admission module. After implementation, update ARCHITECTURE, EXECUTION, OPERATIONS, LOCAL_RUN, and the acceptance matrix. Preserve existing requirement IDs.

## 13. Switching and rollback

Migrations initially only add fields/tables. The backend is pinned when a request is created. The old worker handles only legacy, the new one only bullmq. An unsent request may migrate under lock with a new generation; already submitted/unknown attempts are not resubmitted.

Sequence: mock → shadow quota calculation without duplicate consumption/calls → new demo requests through BullMQ → result and ledger reconciliation → retire the legacy dispatcher after old tasks complete. Shadow mode must not create second real permits.

Rollback stops new BullMQ admissions, allows active attempts to finish, and returns new requests to the old backend. Pending jobs transfer only after checking no dispatch occurred and applying fencing. Redis jobs become invalid by generation. Do not delete financial records, attempts, or accepted quotes. Returning to the old backend does not guarantee old throughput; it is a recovery mode.

## 14. Acceptance

Owner's scope clarification, 2026-09-20: deployment and checks on real VPSs, separate VMs, or physical hosts are not required to complete this objective. Local process and container checks, shared S3, financial invariants, and agreed load profiles remain mandatory. Real multihost verification remains recommended before production and is not considered completed by local tests.

New IDs extend the existing matrix rather than replacing it:

- DIST-01: several workers receive duplicate copies of one job; one authorized external attempt and one settlement.
- DIST-02: two concurrent admissions compete for the last remainder; only one succeeds. Rejection by one rule consumes none of the others.
- DIST-03: 30 users, mixed text/image; a long image does not block a free text group. One account with a large backlog does not block others.
- DIST-04: requests with differing token/image weights, shared groups, minute/day windows, oversize demand, and bursts. Local admissions stay within configured quotas.
- DIST-05: 429/Retry-After, billing/auth, missing and out-of-order headers; correct pause scope.
- DIST-06: kill a worker at every admission/submission/result/settlement boundary; unknown is not retried automatically, and the ledger reconciles.
- DIST-07: Redis restart, complete data loss, PostgreSQL unavailability; recovery does not open full quota or lose requests.
- DIST-08: cancellation/deadline, stale fencing, late response after financial closure, refund/debt; existing rules hold.
- DIST-09: lost outbox acknowledgement, completed-job deletion, scheduler restart; reconciliation restores delivery without another effect.
- DIST-10: quota/route changes and rollback during execution; accepted quotes remain unchanged, and old jobs are not dispatched again by the new backend.
- DIST-11: several separate API/worker containers with distinct filesystem and network namespaces on a local Docker host read shared assets through S3; acknowledgement/TTL/delete remain correct. Checks on real VPSs/VMs and physical hosts are excluded from mandatory acceptance of the current objective by the owner's decision of 2026-09-20.

Load profile: 30 users for 30 minutes, then 100 users for 15 minutes; mock text takes 2–10 seconds, images 30–90 seconds, with short bursts and some 429/timeouts. A separate run covers 30 in-flight generations. The generator creates arrivals independently of responses to avoid hiding overload. The report records hardware, memory, DB/Redis connections, and throughput.

Proposed criteria on agreed hardware: p95 API quote/admission up to 1 second for short text inputs; p95 platform waiting up to 2 seconds with available slots and quota; no sustained backlog growth when arrivals remain below measured capacity; zero duplicate financial effects and lost accepted requests. Provider time, legitimate quota waiting, and overload queues are measured separately. File and long-context tests have separate budgets.

## 15. Topics to discuss before implementation

1. Initial pools of 8 text + 8 image and 2 active jobs per user, or a different profile immediately.
2. Whether to include shared object storage in this phase for actual multihost operation. Recommendation: include the adapter and a two-worker check; select production hosting separately.
3. For backpressure, the owner agreed to 20 waiting jobs per account, 200 per application, and refusal when the application's oldest waiting job reaches 15 minutes. The 10% technical quota margin remains a separate provider-admission setting.
4. First-launch goal: a local demo with a production-compatible design, without production deployment in this task.

## Sources

Checked on 2026-09-19:

- [BullMQ: concurrency](https://docs.bullmq.io/guide/workers/concurrency)
- [BullMQ: stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs)
- [BullMQ: rate limiting](https://docs.bullmq.io/guide/rate-limiting)
- [BullMQ: production](https://docs.bullmq.io/guide/going-to-production)
- [RateLimiterUnion](https://github.com/animir/node-rate-limiter-flexible/wiki/RateLimiterUnion)
- [OpenAI: quotas and headers](https://developers.openai.com/api/docs/guides/rate-limits)
- Tier 4 models: [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano), [Image 2](https://developers.openai.com/api/docs/models/gpt-image-2), [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare).
