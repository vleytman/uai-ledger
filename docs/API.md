# API and SDK Contract

[Contents](README.md)

[OpenAPI](openapi.json) and TypeScript SDK types describe the supported HTTP API and are generated from shared runtime schemas. Example amounts are synthetic. Use this guide to authenticate a server-side client, quote work, execute requests and persist results.

## General Rules

### Central Calculation and Final Price

New single-call profiles may select `pricing_mode: quoted_final`. The quote returns `settlement: quoted_final` and `price_units` as an integer credit-unit string. Compatible `estimated_units` and `max_units` fields contain the same amount. The client displays `price_units` before confirmation; a successful result charges the agreed price. Changing input requires a new quote. Legacy actual_usage and fixed tables retain their previous contract.

`POST /v1/admin/model-versions/preview` requires `config:write`. It accepts a selected saved model or an unsaved calculation method with a rate version and test input. The response contains component quantities and costs, estimated provider cost, factors, and final price. Preview neither calls the provider nor requires completed verification examples; publication requires successful examples. The rate version is checked within the current application scope.

The public catalog exposes the model parameter schema and attachment preparation rules. Calculation method, internal rates, safety, and markup remain administrative data. The detailed calculation-method contract is in the [specification](MODEL_PRICING.md).

Base path: /v1. The server uses HTTPS in operational environments. JSON fields use snake_case. Dates and times use UTC ISO 8601. Identifiers are opaque; the client does not infer access rights from them.

All *_units amounts are transmitted as nonnegative integer strings. Signed amounts are permitted only in postings representations. Quantities and rates requiring fractions also use decimal strings. Display credits are derived values.

GET does not start generation, retry, payment, or configuration changes. A command POST reports acceptance, not necessarily completion. Jobs use 202; reading a resource reports its final status.

## Authorization

Authorization: Bearer carries a service token. The platform defines token scope. organization_id and application_id are derived from authorization. Account ID from the body is checked for ownership and permissions, rather than accepted as proof of access.

| Scope | Capabilities |
|---|---|
| accounts:write | Create and map an account in the application |
| accounts:spending | Suspend/resume account spending by payment-service or operator decision |
| ai:quote | Obtain an estimate for an authorized action |
| ai:execute | Accept an operation, create a request, cancel |
| ai:read | Read results and events within its scope |
| content:write | Acknowledge delivery and delete content within its scope |
| wallets:read | Read its authorized balance and ledger |
| credits:grant | Grant credits to permitted wallets within server limits |
| credits:refund | Refund previously charged usage within its scope |
| credits:revoke | Prepare and confirm revocation of a specific grant |
| config:write | Manage catalog, prices, routes, and recipes |
| operations:admin | Resolve incidents and manage execution |

An ordinary application key does not include credits:grant. The payment service receives a restricted grant key without access to prompts or provider credentials. Admin UI uses user sessions with roles and audit.

In external mode, the parent application owns the session. The additional service scope `identity:assert` permits a verified version-1 `x-uai-context` header. User context restricts account and forbids administrative/financial privileges; staff context has an `admin` or `viewer` role without expanding token scopes. Viewer receives only an explicit registry of safe reads. The standalone build retains owner password login. Format, adapter setup, and individual attribution are described in the [external authentication contract](EXTERNAL_AUTH.md). `/health` declares `capabilities.external_identity: 1`; the SDK and external administrative backend check compatibility.

## Idempotency

Every POST creating financial effects or paid work requires Idempotency-Key. Key length and characters are restricted; UUID is recommended. Uniqueness scope: organization + application + endpoint command + key.

The server stores the canonical input hash. Repeating the same body returns the previous resource ID and command result. The same key with another body returns 409 idempotency_conflict. Concurrent replays do not execute the command twice.

Grant source is additionally unique by issuer + external_reference. Request is additionally unique by operation + client_request_key. Capture/refund have unique domain references. HTTP-response cache expiry does not remove these constraints.

Financial-effect idempotency records are retained for the entire financial-history retention period. Other commands require a documented retention period; afterward the client reads the resource by ID rather than assuming recreation is safe.

## Main Resources

| Method and path | Result |
|---|---|
| POST /accounts | Application account and optional wallet |
| POST /accounts/{id}/spending/suspend | Prohibit new spending; stop unsent requests |
| POST /accounts/{id}/spending/resume | Permit new work following an external decision |
| GET /models | Permitted models and capabilities |
| GET /profiles | Routing profiles available to the application |
| GET /recipes | Available published recipes and input schemas |
| POST /assets/uploads | Permission to upload a file |
| POST /assets/{id}/complete | Complete upload and validate file |
| GET /assets/{id} | Metadata and temporary access to an authorized file |
| POST /invocations | Single call: built-in estimate, reservation, operation, and request |
| POST /quotes | Preliminary estimate without reservation |
| GET /quotes/{id} | Estimate terms and validity period |
| POST /operations | Quote acceptance and atomic reservation |
| GET /operations/{id} | Status, results, budget, and settlement |
| POST /operations/{id}/amend | Accept an additional estimate and change the authorized limit |
| POST /operations/{id}/complete | Close new-request admission; accepted requests continue, settlement is independent |
| POST /operations/{id}/finish-partial | Close admission and cancel unsent requests; preserve completed work |
| POST /operations/{id}/cancel | Cancel new and, where possible, current requests |
| POST /operations/{id}/requests | Create a bounded component request |
| GET /requests/{id} | Status, metadata, and completed result |
| POST /requests/{id}/cancel | Request cancellation |
| POST /requests/{id}/acknowledge | Confirm application persistence of the result and delete the temporary copy |
| POST /content-deletions | Delete content of an operation or external project generation |
| GET /content-deletions/{id} | Deletion state and tombstone |
| GET /events | SSE within authorized scope, filtered by operation or wallet |
| GET /wallets/{id} | Authoritative balance and revision |
| GET /wallets/{id}/transactions | Paginated posting history |
| GET /wallets/{id}/lots | Lots, balances, and expiry dates |
| POST /wallets/{id}/grants | Grant a separate lot |
| POST /wallets/{id}/refunds | Refund part of a specific capture |
| POST /wallets/{id}/grant-revocations | Prepare revocation of the available grant portion |
| POST /grant-revocations/{id}/commit | Confirm revocation after an external decision |
| POST /grant-revocations/{id}/cancel | Cancel a prepared revocation |

Pagination uses an opaque cursor and limit with a server upper bound. Financial and technical lists have stable ordering with an additional ID when timestamps match.

Audio assets accept `audio/wav` and `audio/mpeg`. Upload and provider-output delivery use a shared decoder and integrity validation before storage. Limits: 16 MiB encoded bytes and 16 777 216 decoded channel values. Supported WAV codecs, MP3 metadata, and validation boundaries are described in `packages/execution/src/audio-validation.ts`. Damaged input receives `invalid_asset`; defective provider output is paid for by the platform under Q3/Q5.

The complete, finish-partial, and cancel commands return 200 with the current OperationResponse. After a terminal result they neither change the outcome nor repeat financial effects or the closing event, including with a new Idempotency-Key. While accepted requests remain active, cancellation may be strengthened in the order complete → finish-partial → cancel; the reverse transition has no effect. A repeated key with the original body reads the original operation’s current state. ai:execute and access-scope checks apply to no-op commands too. Semantics are described in the [execution lifecycle](EXECUTION.md).

## Account Creation

~~~json
{
  "external_account_id": "customer_42",
  "create_wallet": { "credit_unit_id": "ai-credit-usd-v1" }
}
~~~

External account ID is unique within the application. This method cannot attach an arbitrary existing account_id from another application. Shared wallet access is granted through an administrative command.

Spending suspend/resume require accounts:spending, Idempotency-Key, reason, and external_reference. Suspend atomically prohibits admission and future dispatch for the account, closing unsent requests with release; dispatched requests proceed through cancel/settlement. Resume permits new work but neither retries canceled requests nor removes a provider lock. An ordinary frontend does not receive these permissions.

## Simple Invocation

POST /invocations uses ai:quote and ai:execute scopes. The client supplies an allowed model or profile, bounded input, and maximum spending. No custom recipe registration is required:

~~~json
{
  "account_id": "account_123",
  "wallet_id": "wallet_123",
  "profile": "text.medium",
  "kind": "text.generate",
  "input": {
    "messages": [{ "role": "user", "content": "Prepare a brief response." }]
  },
  "parameters": { "max_output_tokens": 1500 },
  "budget": { "credit_unit_id": "ai-credit-usd-v1", "max_credits": "180" },
  "metadata": { "external_project_id": "project_42", "project_generation": "gen_1" }
}
~~~

max_credits is an exact decimal string and authorized limit, rather than a submitted price. The server calculates the upper bound using a built-in immutable single-call recipe. If it exceeds the limit, 409 budget_conflict returns with an estimate; paid work does not start. Otherwise one transaction stores an internal quote, an operation with closed admission, reservation of the calculated maximum, request, and outbox. A higher client limit does not require reserving it in full.

The 202 response contains operation_id, request_id, quote_id, accepted_max_units, execution_status, deadline_at, and events_url. Replaying with the same key returns the same resources. There is no gap in which an SDK crash could leave a reservation without a request. A single image call creates one image; batches use composite operations.

For a chain of calls that emerge during work, POST /quotes accepts kind=pool, and each call passes the accepted pool’s operation_id to POST /invocations; the response is the same, with request_id referring to that call. Rules are in [quoting](QUOTING.md#reservation-for-compound-work).

For preliminary pricing, POST /quotes accepts kind=single_call and the same profile/model, input, parameters, and budget. The returned quote may be passed to POST /invocations instead of the original fields. The server binds the entire normalized input and its hash; a quote cannot be used with a substituted prompt. Draft input is stored only until quote acceptance or expiry. Generic invocation follows the same cancellation, retry, defect, delivery, and financial-closing rules.

## Quoting

POST /quotes:

~~~json
{
  "account_id": "account_123",
  "wallet_id": "wallet_123",
  "recipe": { "key": "logopanel.discussion", "version": 1 },
  "inputs": {
    "participants": 4,
    "passes": 2,
    "context_tokens_upper": 30000
  },
  "metadata": { "external_project_id": "project_42", "project_generation": "gen_1" }
}
~~~

The response includes id, input hash, recipe/route/price versions, estimated_units, max_units, credit_unit_id, confidence, breakdown, expires_at, and warnings. It also fixes partial_policy=successful_parts, cancellation policy, retry policy, execution deadlines, and content_ttl_seconds. A complete amount example is in [QUOTING](QUOTING.md).

A quote neither reserves credits nor promises a provider slot. Missing applicable price, upper bound, or capability returns a structured error. metadata has a size limit and does not affect authorization.

When external_project_id is supplied, project_generation is required and validated server-side. This pair defines the content binding inherited by the operation and its requests; a child request cannot remove or replace it. Other arbitrary metadata does not control deletion. The general API permits no project binding; such content is deleted through operation scope or TTL. Supply the project binding when content belongs to a product project.

## Operation Acceptance

POST /operations:

~~~json
{
  "quote_id": "quote_123",
  "client_operation_key": "discussion-project42-round7"
}
~~~

Response:

~~~json
{
  "id": "op_123",
  "execution_status": "accepted",
  "settlement_status": "open",
  "accepted_max_units": "180000000",
  "captured_units": "0",
  "reserved_units": "180000000",
  "wallet": {
    "id": "wallet_123",
    "revision": 8,
    "balance_units": "1000000000",
    "reserved_units": "180000000",
    "available_units": "820000000"
  }
}
~~~

An operation is created only after successful reservation. Insufficient funds return 402 insufficient_credits without a partially created authorization. An expired quote returns 409 quote_expired.

Amend accepts a new quote tied to this operation. The new total maximum cannot fall below captures and active claims. An increase requires an atomic additional reservation. Old captures are not recalculated.

## Request Execution

POST /operations/op_123/requests:

~~~json
{
  "client_request_key": "pass-1-participant-1",
  "component": "participants",
  "kind": "text.generate",
  "input": {
    "instructions": "Return a response using the specified schema.",
    "messages": [{ "role": "user", "content": "Application input data" }],
    "asset_ids": [],
    "response_schema": {
      "type": "object",
      "properties": { "message": { "type": "string" } },
      "required": ["message"],
      "additionalProperties": false
    }
  },
  "parameters": { "max_output_tokens": 1500 }
}
~~~

The server derives the route from the component. A user cannot substitute a more expensive model through a body field. If the recipe permits selection, the options and their prices are included in the quote.

For image.generate, input contains prompt and asset_ids, while parameters contains count, size, and quality within recipe bounds. For speech.synthesize, input contains text and an allowed voice reference. For search, input contains query and allowed filters. specialized.run receives a registered operation type with its own schema.

In the first version, image-request count is 1; four images are four separately accounted requests. The technical result schema is fixed before dispatch. Requirements cannot be changed after receiving a valid response to declare previous work free.

asset_ids accepts only uploaded input assets owned by the correct party. An output asset from a previous request cannot be used directly: the application stores the file and uploads a separate input asset. Violations are rejected before dispatch as invalid_input. This preserves independence between acknowledgement and active input files.

202 response:

~~~json
{
  "id": "req_123",
  "operation_id": "op_123",
  "execution_status": "queued",
  "settlement_status": "open",
  "events_url": "/v1/events?operation_id=op_123"
}
~~~

Replaying the same client_request_key and input returns req_123. Changed input returns a conflict. Replaying to recover a result does not create a provider attempt.

A new generation after an unknown outcome uses a new authorized request with retry_of_request_id and explicit acknowledged_duplicate_risk, only if the principal has the required permission and an additional budget has been accepted. A browser boolean without an authorized server action is insufficient.

## Reading a Result

~~~json
{
  "id": "req_123",
  "execution_status": "succeeded",
  "settlement_status": "settled",
  "result": { "type": "json", "value": { "message": "Completed response" } },
  "model": { "provider": "example", "model_id": "example-text-v1" },
  "usage_state": "final",
  "cost_state": "calculated",
  "charged_units": "50000000",
  "wallet_revision": 9,
  "delivery": {
    "result_version": "result_v1",
    "manifest_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "available",
    "ready_at": "2026-09-18T12:02:00Z",
    "content_expires_at": "2026-09-18T13:02:00Z"
  }
}
~~~

Full usage and provider cost may be available only to an administrative principal. The client receives the customer charge, precision state, and permitted model information. Failed requests do not expose raw responses containing keys or another scope’s private data.

A succeeded request may have settlement_status=pending when the result is available but usage is insufficient. Such a response is not marked settled and does not report charged_units as a confirmed zero. The disputed portion closes financially no later than one hour after the first unresolved_at, even if polling continues.

`attempt_timeout_seconds` in the execution policy interrupts a silent call before the request deadline, leaving time for a retry. The interrupted attempt is marked `timed_out_at`; its cost remains unknown. Retry is automatic when the adapter supports idempotency (same key), or policy specifies `timeout_retry: "accept_duplicate_cost"`; otherwise the request receives outcome_unknown at timeout rather than at the deadline.

A provider rejection before work begins (401/403, 402 or insufficient_quota, 429) marked by the adapter as `billable: false` is not unknown cost: the attempt receives cost 0, and a finally rejected request immediately receives settlement_status=settled without an hour’s wait. An adapter without this marker retains the previous one-hour closure.

For waiting_recovery, the response contains recovery_incident_id, cycle_index, attempt_count, next_retry_at, deadline_at, and reason. This metadata does not reveal other parties’ requests selected as probes. After locked, new calls receive provider_locked; accepted requests without an available path receive terminal provider_recovery_exhausted and separate settlement.

A request that expires before its first attempt receives execution_status=canceled, attempt_count=0, and a reason indicating no model call started: `rate_limit_starved` if it waited for provider concurrency or a limiter window, and `admission_timeout` for other admission waits. `deadline_exceeded` remains the reason for requests with a prior attempt, and for paused and waiting_recovery requests. Such a request is not charged.

## Content Delivery and Deletion

After saving text and all files in its own durable storage, the application calls POST /requests/req_123/acknowledge with Idempotency-Key:

~~~json
{
  "result_version": "result_v1",
  "manifest_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
~~~

The manifest identifies the entire result: text/JSON and file content hashes. The result API returns manifest_hash. Confirming download of only one file does not delete the others. Acknowledge atomically records a receipt, closes reads of that version, and queues purge. Replay returns the previous receipt; a mismatched version or hash yields 409 result_version_conflict. Acknowledgement creates no capture/refund and is not required to charge for an available valid result.

After acknowledgement, expiry, or deletion, GET /requests/{id} returns metadata with result=null, delivery.status=acknowledged|expired|deleted, and event time. Access to a deleted asset returns 410 content_unavailable. Replaying the original command with its previous key returns the original ID and this status, without generation or an old payload from idempotency cache. After content deletion, only permitted hashes and financial metadata remain. A new request for the same result is new explicitly paid work.

POST /content-deletions accepts scope and reason. Scope may be operation_id or an external_project_id/project_generation pair within the authorized application. The server creates a tombstone and deletion task; the 202 response contains deletion_id. Replays are idempotent. A new request, including inside an old operation, checks the tombstone and cannot write a result into a deleted project generation. Financial settlement of an already dispatched call continues. GET deletion shows accepted/purging/completed and physical-cleanup problems. Completion is not claimed until every copy belonging to the scope has been checked.

The proposed content TTL without receipt is one hour from ready_at, according to published installation configuration. This is a separate timer from financial unresolved_at. The application receives both deadlines and must not assume it can download the result several days later. Asset links and events do not extend TTL.

## Credit Grant

POST /wallets/wallet_123/grants:

~~~json
{
  "credit_unit_id": "ai-credit-usd-v1",
  "amount_units": "3000000000",
  "source": "purchase",
  "external_reference": "billing:payment_456",
  "terms_version": "pack-2026-09-v1",
  "expires_at": null
}
~~~

This is 3 000 credits and $3 of internal budget. The sale price is not required. The service fixes the budget of one credit from the immutable unit registry; the client cannot submit another conversion factor.

expires_at is required: null explicitly creates a nonexpiring lot. For monthly credits without rollover, the payment service sends source=subscription, a separate period reference, and exact expires_at, for example 2026-10-18T00:00:00Z. Expiry does not remove the lot from history. GET wallet accounts for expiry already reached even when background expire is delayed. A new grant for the next period does not revive the old balance.

The response contains grant_id, lot_id, immutable original values, and wallet snapshot. Reusing external_reference with another amount conflicts even with another Idempotency-Key. Administrative grants require reason and audit.

## Refund and Revocation

POST /wallets/wallet_123/refunds:

~~~json
{
  "capture_id": "capture_123",
  "amount_units": "50000000",
  "reason": "delivery_failure",
  "external_reference": "support:case_789"
}
~~~

The amount cannot exceed the uncompensated capture portion. Refund returns a new transaction ID, wallet revision, lot allocations, and their expires_at. Compensation into an already expired lot uses a separate refund lot under the fixed policy; initial duration is 30 days. Simply releasing a reservation after expiry is not a refund and creates no new lot.

POST /wallets/wallet_123/grant-revocations:

~~~json
{
  "grant_id": "grant_123",
  "amount_units": "1000000000",
  "external_reference": "billing:refund_456",
  "reason": "purchase_refund"
}
~~~

Prepare holds the available portion of a specific grant and returns revocation_id and reconcile_after. Commit and cancel are idempotent commands. reconcile_after triggers reconciliation/an incident rather than automatic release. Budget already consumed or reserved for AI is not automatically revoked. The AI service does not guess external payment state. The one-hour unknown-AI-cost timeout does not apply to a revocation hold.

## Events

SSE and webhook use a shared envelope:

~~~json
{
  "id": "event_123",
  "sequence": "1042",
  "type": "wallet.updated",
  "occurred_at": "2026-09-18T12:02:00Z",
  "application_id": "app_123",
  "account_id": "account_123",
  "resource": { "type": "wallet", "id": "wallet_123" },
  "data": {
    "revision": 9,
    "balance_units": "950000000",
    "reserved_units": "130000000",
    "available_units": "820000000"
  }
}
~~~

Main types: operation.accepted, operation.paused, operation.completed, operation.settled, request.queued, request.waiting_rate_limit, request.waiting_recovery, request.started, request.output_delta, request.succeeded, request.settled, request.failed, request.outcome_unknown, result.ready, result.acknowledged, content.deleted, usage.updated, wallet.updated, provider.health_changed, provider.budget_low, provider.failover_started, provider.recovery_started, provider.recovery_exhausted, provider.recovered, reconciliation.discrepancy.

Request.output_delta is a temporary SSE stream without a durable payload. Other durable events contain references/metadata and do not copy prompts, result text, or file bytes. Outbox replay must not disclose deleted content.

Execution completion and financial closure may arrive as separate events. The client applies only newer wallet revisions. If events are missed, it reads a snapshot. Events from different resources do not guarantee one shared order across all delivery channels.

A webhook contains body signature, timestamp, and event ID. The recipient checks the signature and time window, deduplicates, and responds after durable acceptance. The sender retries delivery with backoff. Redelivery does not repeat the business effect.

## Administrative Methods

All configurations have draft and published versions. Draft editing uses revision/If-Match so two administrators cannot overwrite each other’s changes.

| Resource | Required operations |
|---|---|
| /admin/connections | Create, read, change draft settings, enable/disable, check through an allowed unpaid method |
| /admin/recovery-incidents | Scope, cycle, probe lease, next_retry_at, history, manually enable affected scope with reason |
| /admin/connections/{id}/credentials | Store/rotate secret through write-only input |
| /admin/model-versions | Capability catalog and lifecycle |
| /admin/rate-cards | Create draft with optional display_name, validate calculation, compare impact, publish |
| /admin/rate-cards/{id}/display-name | PATCH: rename draft or published tariff; config:write, If-Match, and Idempotency-Key required |
| /admin/routes | Create draft, check compatibility, publish |
| /admin/recipes | Create draft, check limits and schemas, publish |
| /admin/requests, /admin/attempts | Search, read, diagnose, permitted recovery actions; `POST /admin/requests/{id}/resolve-unknown` resolves an attempt’s unknown outcome using provider evidence |
| /admin/provider-snapshots | Latest balances, limits, and freshness |
| /admin/reconciliation-runs | Start read-only reconciliation, read result, record adjustment |
| /admin/incidents | Acknowledge, resolve, delivery history |
| /admin/notification-rules | Thresholds, recipients, cooldown |
| /admin/audit-events | Audit viewing with filters |
| /admin/credit-summary | Period credit summary across all application wallets: issued, consumed, refunded, expired, revoked, current and expiring balances |

Secrets cannot be viewed after storage. Publishing a rate card does not rewrite history. Resolve unknown requires reason and a permitted financial scenario from ACCOUNTING: the body contains attempt_id, provider_charged, and cost_units (only when provider_charged=true); the customer is not charged, and the attempt receives `abandoned` status with known cost. The procedure is described in [operations](OPERATIONS.md#limiter-slots-and-unknown-outcomes).

`GET /admin/execution-metrics` additionally returns `limiters` (`concurrency_limit`, `held_slots`, `unknown_held_slots`, `oldest_unknown_held_seconds`) and per-queue `rate_limit_starved_24h`, `admission_timeout_24h`, and `attempt_timeouts_24h` (calls interrupted by attempt timeout). Notification signal `limiter.unknown_slots_held` fires when unknown outcomes occupy limiter slots.

### Application Credit Summary

`GET /v1/admin/credit-summary` (scope `operations:admin`, token without `account_ids`) calculates credits across every wallet in the token’s application in one query. Parameters: `period_start`, `period_end` (half-open `[start, end)`, both optional, `period_start` earlier than `period_end`), `account_id` (narrows selection to one account; another party’s account returns 404), and `expiring_before` (default `as_of` + 30 days). The method is read-only: pending `expire` postings are not written, but their amount is included by calculation. All amounts are unit strings.

| Field | Meaning | Basis |
|---|---|---|
| issued_units, issued_by_source | Sum of `original_amount_units` for lots created in the period, by `source`; compensating `refund` lots are excluded | `lot_created_at` |
| consumed_units | Credits moved into consumed: capture and debt repayment | `journal_created_at` |
| refunded_units | Credits returned from consumed to available | `journal_created_at` |
| revoked_units | Confirmed revocations | `journal_created_at` |
| expired_units | Expired amount in lots with `expires_at` within the period and no later than `as_of`, including `expire` not yet written | `lot_expires_at` |
| expired_held_units | Reservations and revocation holds in these lots; later become consumed, revoked, or expired | `lot_expires_at` |
| available_units, reserved_units, revocation_reserved_units | Current amounts in valid lots; reserved and holds across all lots | At `as_of` |
| debt_units | Unpaid actual-usage debt; wallet available balance equals available minus debt | At `as_of` |
| expiring_units | Available amounts in lots expiring after `as_of` and before `expiring_before` | At `as_of` |

`expired_precision` is `partial` while `expired_held_units` is above zero, otherwise `final`. Expired amounts are attributed to lot expiry: releasing a reservation after expiry increases `expired_units` in the period when the lot expired. Consumption here is credit movement out of lots; the amount charged to the customer including debt remains in Overview’s `charged_units` [Overview](#administrative-methods). Amounts match the aggregate of `GET /v1/wallets/{id}/lots` across all selected wallets.

~~~json
{
  "filters": {"application_id": "app_logopanel", "account_id": null, "period_start": "2026-01-01T00:00:00.000Z", "period_end": "2026-02-01T00:00:00.000Z", "expiring_before": "2026-02-24T00:00:00.000Z"},
  "as_of": "2026-01-25T00:00:00.000Z",
  "wallet_count": 3,
  "issued_units": "4250",
  "issued_by_source": {"purchase": "1000", "subscription": "2000", "promotion": "500", "migration": "700", "internal": "50"},
  "consumed_units": "500",
  "refunded_units": "30",
  "expired_units": "1500",
  "expired_held_units": "400",
  "revoked_units": "200",
  "available_units": "1680",
  "reserved_units": "300",
  "revocation_reserved_units": "100",
  "debt_units": "0",
  "expiring_units": "630",
  "issued_basis": "lot_created_at",
  "flow_basis": "journal_created_at",
  "expired_basis": "lot_expires_at",
  "expired_precision": "partial"
}
~~~

SDK: `client.admin.creditSummary({period_start, period_end, account_id, expiring_before})`. Admin BFF: `view=credit_summary` with the same parameters.

## Errors

~~~json
{
  "error": {
    "code": "insufficient_credits",
    "message": "Insufficient available credits for reservation.",
    "retryable": false,
    "correlation_id": "corr_123",
    "details": { "required_units": "180000000", "available_units": "100000000" }
  }
}
~~~

| HTTP | Codes |
|---|---|
| 400/422 | invalid_input, unsupported_capability, request_exceeds_recipe, pricing_unavailable |
| 401/403 | unauthenticated, scope_denied, account_denied |
| 402 | insufficient_credits |
| 404 | not_found, including another party’s inaccessible resource |
| 409 | idempotency_conflict, quote_expired, quote_already_bound, budget_conflict, revocation_unavailable |
| 409 | result_version_conflict, operation_admission_closed, content_scope_deleted |
| 410 | content_unavailable |
| 429 | platform_rate_limited, with Retry-After when available |
| 503 | platform_unavailable, provider_unavailable_before_acceptance, provider_locked, platform_risk_budget_exhausted |

A provider rate limit for an accepted job is usually reflected in queue state, rather than forcing the client to repeat operation creation. The retryable field does not authorize creating a new financial operation with a new key.

## Interface Clients

The admin calls administrative methods through the TanStack Start server layer. The test application uses the SDK from its backend; service keys are not sent to the browser. The test-grant form calls the existing grant with a separate permission and Idempotency-Key, rather than adding a balance-change bypass. Environment and account restrictions are defined in [ARCHITECTURE](ARCHITECTURE.md). Amounts remain strings; interface formatting does not change the API contract.

## SDK

The SDK provides ai.run/ai.quote for single calls and accounts, quotes, operations, requests, assets, wallets, content, and events for composite actions. Ai.run calls POST /invocations, saves IDs, waits for the result through SSE/polling, and returns result with acknowledge(). The user does not register a recipe for this call. The SDK supports AbortSignal for an explicit cancellation command and typed errors.

The application first persists result and files, then calls acknowledge(). The SDK may accept a persist callback and acknowledge delivery only after the callback succeeds. A write failure does not call acknowledge. After a crash, the SDK resumes waiting for the original request, accounts for content_expires_at, and shows deleted-content unavailability without a new paid call. Integration examples must include permanent persistence and project-content deletion.

Safe SDK retries use the same Idempotency-Key and payload. The SDK neither performs independent provider failover nor grants credits. Closing HTTP/SSE is not treated as canceling paid work.

Models and parameters come from the published contract rather than being hardcoded in each application frontend. SDK version and API major are compatible; removing a field or changing its semantics requires a new major version or explicit migration window.

## Setting a Balance in a Test Environment

`POST /v1/wallets/{id}/test-balance` is available only with `UAI_ENV=test` and requires `credits:test-balance` scope and `Idempotency-Key`. The body contains string `available_units` and integer `expected_revision`. Target balance is limited by the token’s `max_grant_units`; 0 is valid. Open reservations or revision mismatch return 409. Grant or revocation across multiple lots executes in one transaction through ordinary postings. The response contains the current `wallet`. Replaying an accepted command returns the current wallet without another adjustment. Outside the test environment, the route returns 404.

A tariff’s display name is stored separately from its `payload`. PATCH `/v1/admin/rate-cards/{id}/display-name` accepts only `display_name`, a string of 1 to 200 characters after trimming surrounding whitespace. Name and `revision` change, while `version`, rates, key, and recipe references do not. An `If-Match` conflict returns `revision_conflict`; replay with the same Idempotency-Key is safe. Old records return `display_name: null` and display their key.

## Estimated Text and Negative Balance

In a quote response, `estimate_only: true` and `overdraft_allowed: true` indicate agreed charging by actual usage with possible debt. In this mode, `max_units` is the initial reservation rather than a charge ceiling; the client displays approximate `estimated_units` usage. The model’s `expected_output_tokens` parameter is used only by the estimator and does not limit generation. Direct invoke with an existing quote preserves these terms.

`Wallet.available_units` and `Wallet.balance_units` allow negative integer strings. Grant, refund, reserve amounts, and `reserved_units` remain nonnegative. New requests during debt are rejected with `insufficient_credits`; accepted requests finish on stored terms. Top-ups repay debt first.

## Queue Publication and Execution Limits

`GET /v1/admin/dispatch-policies` returns six installation policies. `PATCH /v1/admin/dispatch-policies/{kind}` changes the selected policy, where `kind` is text, image, audio, tools, observe, or maintenance. Access requires `operations:admin` and a token without account restrictions; changes additionally require `config:write` and `Idempotency-Key`. Policy scope is the entire installation, rather than the token’s application. The administrator’s organization and application are stored in audit as the change source.

```json
{
  "revision": 1,
  "settings": {
    "account_limit": 2,
    "application_limit": 32,
    "queue_limit": 128
  },
  "reason": "Limit the number of simultaneously published jobs"
}
```

`1 <= account_limit <= application_limit <= queue_limit <= 100000` must hold. An outdated revision returns HTTP 409. Change, revision increment, and before/after audit occur in one transaction. Replaying a command with its original key does not change settings again and returns the current policy. Lowering a limit does not cancel published jobs: new jobs wait for capacity.

For text/image/audio/tools, `active_account_limit`, `active_application_limit`, and `active_queue_limit` set separate active-lease limits. They do not limit backlog. `1 <= active_account_limit <= active_application_limit <= active_queue_limit <= 100000` must hold. Omitted active fields retain previous values; the resulting combination is validated. Lowering a limit does not interrupt running requests. Initial values 2/16/32 are local settings rather than provider quotas.

Fields without the active prefix limit work delivery into BullMQ for text/image/audio/tools. For observe, these fields limit concurrent observations and the number of current poll revisions selected for delivery. Selection is recorded in PostgreSQL before publication; redelivery of an already selected poll occupies no new slot. A new poll revision or completion of observed work releases capacity. Historical and outdated transport records are excluded from this counter; separate active fields for observe and maintenance are currently rejected with HTTP 422 because their executors do not use these settings. Maintenance runs under one cycle-lease owner. These limits do not replace provider quotas or worker-process concurrency.

### Rejection When the Queue Is Full

When `execution_admission_policies` is configured, quote acceptance and increasing the authorized call count through amendment check backlog before financial reservation. New applications receive default limits of 20 per account, 200 per application, and queue age 900000 ms on first operation acceptance with the BullMQ backend. Legacy applications without an explicit policy preserve previous behavior.

An HTTP 429 response with `queue_backpressure` contains reason `account_backlog`, `application_backlog`, or `queue_age`, the current waiting-call count, and `retry_after_seconds: 5`. This recommends trying later rather than promising free capacity in five seconds. No reservation is created or increased. The count includes queued/waiting_retry/waiting_recovery and unused authorizations of open operations until their deadline. Idempotent replay of an accepted operation returns its prior result even when the queue is full.

### Application Admission Policy Settings

`GET /v1/admin/admission-policy` returns limits only for the current token’s application. It requires `operations:admin`; account-restricted tokens are forbidden. A missing policy returns `enabled: false`, `revision: 0`, and default initial values; GET does not create a policy.

`PATCH /v1/admin/admission-policy` additionally requires `config:write`, `Idempotency-Key`, a reason, and revision in the body. Revision 0 means first enablement. Settings apply to subsequent admission checks; accepted work is preserved. Allowed ranges: account 1–100000, application from account to 1000000, max_queue_age_ms 1000–86400000.

```json
{
  "revision": 0,
  "settings": {
    "account_limit": 20,
    "application_limit": 200,
    "max_queue_age_ms": 900000
  },
  "reason": "Enable application queue limits"
}
```

A competing change returns HTTP 409. Persistence and `admission.policy.updated` audit with before/after are atomic. Replaying the previous command creates no new audit and returns the current application policy. The application cannot be substituted in the command body or URL.

### Operational Quota Settings

The administrative list `GET /v1/admin/provider-quotas` returns organization groups, rules, model bindings, and held concurrency slots. `PATCH /v1/admin/provider-quotas/{id}` changes operational settings with `settings_revision`, an idempotency key, and a required reason. Admission-rule revision is separate from these settings’ revision. Permissions, current editor limits, and snapshot semantics are described in the [operational specification](OPERATIONS.md#provider-quota-group-settings); exact schemas are in [OpenAPI](openapi.json).

`PATCH /v1/admin/provider-quotas/{id}/rules` changes existing-rule limits with `rules_revision`, an idempotency key, and reason. `capacity` defines our share; `provider_capacity` stores the known provider limit or null. Both numeric quantities are integer strings. The command preserves windows and accumulated usage, as well as existing valid admissions. This endpoint does not support creating rules or changing their metrics.

`GET /v1/admin/provider-quotas/{id}/snapshot` returns rules revision, read time, reliability status, and per-rule balances. Quantities are strings; dates use ISO 8601. With status other than ready, rules is empty. The token must have operations:admin without account_ids; another organization is inaccessible. Redis is read after the SQL transaction ends. The method neither creates admission nor restores quota. Local and conservative provider-remainder semantics are in the [operational specification](OPERATIONS.md#provider-quota-group-settings).

### Incoming Provider Webhooks

`POST /v1/provider-webhooks/{requestId}` accepts the original signed body up to 1 MiB with Content-Type application/json or application/octet-stream. No Bearer token is required: the corresponding saved attempt’s adapter must validate signature, validity period, and remote job identifier. Scope comes from execution_request; organization fields in the body are ignored. Duplicate HTTP headers are rejected. JSON is not reconstructed before signature verification.

After verification, the same receiveNativeWebhook and settlement are used as for internal event receipt. Repeating event_id of an already stored observation is acknowledged without a second financial effect. HTTP 200 with accepted=true confirms processing; 401 means invalid signature or job binding, 404 means unknown request/native job or no adapter webhook support, and 503 means temporary inability to process. Responses do not expose provider context. On 503 the provider must retry; unfinished native jobs also remain in polling.

Current real-provider adapters do not implement `verifyNativeWebhook`; OpenAI/Cartesia webhook integration is therefore unavailable. To add webhook support, implement signature verification, freshness and replay checks in the provider’s native adapter, and pass the callback URL during `submitNative` according to the provider contract. Headers and secrets are adapter-specific.

## Paid API Extension

See the [paid API contract](PAID_API_CONTRACT.md) for provider accounts, usage units, periods, allowance reservations and supported HTTP endpoints.

## Universal Execution Policy

`QuoteBody.execution` permits partial overrides of known fields: deadline_seconds, max_attempts, backoff, retry_reasons, retry_after_output, recovery, attempt_timeout_seconds, timeout_retry. An empty object is equivalent to an absent block. Lists are replaced entirely; null and unknown fields are rejected. `billing.refused` accepts default platform or actual_usage. The quote returns final execution and billing, and the request executes stored terms. Policy changes when supplying an existing quote_id are rejected.

Automatic single-call with estimated_actual is permitted without a fixed budget; other modes still require a budget or accepted quote. Images with human confirmation use a quote and operation acceptance.

Upload accepts retention_seconds and metadata with external_project_id/project_generation. By default, available input is retained for seven days after completed upload or accepted use. GET does not extend retention. POST /v1/assets/{id}/renew extends valid input with an idempotency key. Expired input is uploaded again from the application’s original. Result ACK does not delete a shared input asset.

## Model capabilities

See [model capabilities](MODEL_CAPABILITIES.md) for embeddings, structured responses, SVG support, limits and example configurations. Publish compatible profiles and configure connection budgets before making real calls.
