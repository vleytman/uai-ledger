# Paid API and Allowance Contract

[Documentation](README.md) · [Operational HTTP API](API.md) · [OpenAPI extension](openapi-paid-api.json)

Use this reference when connecting a paid API with native credits or subscription allowances. The schemas live in [paid-api.ts](../packages/contracts/paid-api.ts). Run `pnpm generate:paid-api` to generate the OpenAPI extension or `pnpm check:paid-api` to check it. `openapi.json` covers the full HTTP API and client types. These checks validate the contract; real provider calls need separate verification.

## Identities and Versions

`provider_account_id` identifies the provider account within an organization and application. It is not the client `account_id`. Multiple connections with the same account share one subscription. A duplicate subscription for the same account is rejected so that a second key cannot create a second allowance package. A tariff is published as an immutable version from Git; the subscription stores that version's ID, its start, and an explicit installation share for each counter. Connection binding changes require a revision and audit. Accepted work retains its original subscription and tariff.

All administrative methods require `operations:admin`; changes also require `config:write`. Account-scoped tokens do not receive provider balances. Changes use `Idempotency-Key`; binding uses `If-Match`. The first binding has expected revision 0. Repeating a command with the same content returns the same result; changing its content conflicts.

## Measurements and Price

Native quantities are transmitted as decimal strings, with up to nine decimal places. Monetary amounts are integer strings in existing UAI units. Requests, provider credits, pages, bytes, and money are not summed together.

An operation defines input and output JSON Schema, a registered `adapter_ref`, file constraints, and the source and maximum of each metric. `verified_assets` values are obtained after checking file ownership, content, and dimensions. A client cannot submit them as ready-made billing metrics. Customer pricing uses the existing fixed-price or formula engine. The API permits `quoted_final` or `actual_capped`. The latter limits the charge to the accepted maximum even if provider usage is greater. Missing usage means an unknown measurement outcome, rather than a zero price.

Provider cost, customer price, allowance usage, and rate limits are tracked separately. With `incremental`, included volume costs zero and additional expenses are counted. With `allocated`, subscription-fee allocation is a separate analytical view. It must not be added to the same full subscription fee a second time.

## Periods and Rollover

Period boundaries are calculated in the tariff's time zone. A calendar month starts at midnight on its first day. Anniversary periods retain the original day and local time: January 31 → the last day of February → March 31. When local time repeats, the first occurrence is selected; when local time is skipped, the boundary moves forward by the transition duration.

Each period receives the installation's share for every counter. Repeated scheduler execution does not create a second allocation. Rollover is disabled by default. When enabled, balances roll over within the cap, earliest expiry first. A new lot retains the original expiry and provenance reference; repeated rollover does not extend expiry. Missed months are processed sequentially. Deleting or changing a file does not alter history.

An open reservation is not rolled over as a free balance. When released or adjusted after period closure, the released quantity stays in the old period. There is no automatic allocation in the new month; an adjustment requires evidence and audit. This prevents double spending on late responses.

## Admission and Call Outcomes

1. An idempotent replay of an accepted operation is read before new admission checks.
2. The maximum for each counter is reserved in PostgreSQL in the same transaction as the monetary reservation. Failure of any counter rolls back the entire transaction. Exhaustion returns `allowance_exhausted`, the metric, and `resets_at`; money has not yet been reserved.
3. A short rate limit leaves the request queued with a deadline. At the durable send boundary, the worker checks the period and snapshots. An unsent reservation moves into the new period atomically, or the call is not dispatched.
4. Each new actual attempt receives its own allowance. Redis admission, SQL intent, and HTTP are not treated as one transaction.
5. Confirmed usage consumes allowance and releases the difference. Repeated observations are idempotent. A usage revision lower than one already accepted is rejected; a new revision adds corrective ledger entries.
6. An unknown outcome retains the maximum. A customer's monetary dispute may close after an hour, but allowance remains occupied until confirmed usage or an audited decision. It cannot be released by a timer, nor can a paid request be retried without evidence.
7. Actual overruns are recorded in full. When overage is forbidden, a deficit blocks new calls, including after monthly renewal, until a confirmed adjustment exists. When overage is permitted, only known rates and a separate monetary limit accounting for concurrent reservations are allowed.

The usage ledger is immutable. Corrections are new entries. PostgreSQL serializes admission on the subscription; monthly allowance is not moved into Redis daily counters.

## Reconciliation and Notifications

A snapshot contains account, period, metric, observation time, coverage time, precision, and scope. Future timestamps and incompatible periods are rejected. A snapshot places an upper bound on the local balance. Usage after coverage and unfinished calls are additionally subtracted. Only confirmed coverage of a completed measurement allows excluding it from repeated subtraction. An estimated or stale snapshot never increases availability. A new higher value alone does not cancel an earlier constraint within the period; recovery from an incorrect snapshot requires a separate audited decision.

Missing statistics do not reset local counters. State returns used, reserved, remaining, overdrawn, included and rolled-over volume, period, overage, and freshness. The remaining percentage is calculated against included volume plus rollover, accounting for open reservations.

Notification rules select subscription, metric, unit, and threshold. Percentages and native units use different comparison bases. The fingerprint includes rule, subscription, period, and metric. A threshold is crossed once until recovery, subject to cooldown. `allowance.renewed` is a one-time event. Delivery uses the existing outbox and signed webhook with the same ID on retry. The application selects recipients for email/Telegram and user notifications.

## Implemented HTTP Paths and Limits

`api.call` uses the existing `/v1/quotes`, `/v1/operations`, `/v1/requests`, `/v1/invocations`, and `/v1/events`. The SDK adds `services.quote/run`; existing `ai.*` remain compatible. Administrative endpoints and types are included in the main OpenAPI. Allowance viewing is limited to installation admin/staff; an account-scoped token does not receive provider statistics.

UAI checks input files against their owner, hash, actual stored size, file count, and allowed MIME type. It does not run arbitrary PDF or audio processors; verified page and duration measurements come from the adapter. MIME checks use storage metadata, not universal content detection. Input is limited to 16 files and 20 MB. JSON Schema uses an explicitly bounded subset with no external `$ref` or executable code.

Native allowance-to-usage matching uses an exact key/unit. For a composite AI counter, the tariff may specify `dimensions`; matching units alone is insufficient. Requests are measured separately. Rolling quotas support requests, AI tokens/images/audio_seconds, and API credits/pages/files/bytes. Their fractional maximum is rounded up to a whole native unit; monthly allowance retains nine decimal places. Additional quota metrics are registered in code; a missing estimate prevents admission.

`POST /v1/admin/connections/{id}/allowance-refresh` reads Firecrawl credit-usage with explicitly enabled real-provider mode and a configured credential. The period must match the subscription exactly. Missing coverage remains `estimated`, and the overall difference between snapshots is not used as request cost. Manual `ProviderSnapshot.supersedes` explicitly replaces incorrect snapshots for the same period/metric; lineage and reason are immutable. Ordinary statistics refresh does not increase a previously constrained balance.

Example rule for the existing `POST /v1/admin/notification-rules`:

```json
{
  "rule": {
    "signal": "allowance.low",
    "allowance": {"subscription_id": "sub_example", "metric": "credits", "unit": "percent"},
    "threshold": "20",
    "severity": "warning",
    "minimum_samples": 1,
    "cooldown_seconds": 300,
    "recipients": [],
    "enabled": true
  },
  "reason": "Warn when 20 percent remains"
}
```

Leave recipients empty to keep the incident in admin. For external delivery, select an existing webhook destination. The same rules can monitor an AI connection once you explicitly bind a provider subscription.

Each account has one subscription. Changing an existing subscription's tariff template requires a separate period migration; it isn't supported as an ordinary edit. You can adjust the current balance or connection binding manually with an audit record, but open reservations protect the binding.
