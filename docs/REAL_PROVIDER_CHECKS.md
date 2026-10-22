# Real provider checks

[Contents](README.md) · [Local run](LOCAL_RUN.md) · [Acceptance](ACCEPTANCE_RESULTS.md)

Updated 2026-09-19. The real OpenAI run through the SDK/demo completed: text, a standalone image and a composite action all succeeded on the first attempt, four requests in total. Calculated cost from terminal usage was 0.004452 USD against an authorized 1 USD limit. ACK, reload and file deletion with preserved financial history were verified. Financial reconciliation with OpenAI was not performed. Dedicated paid-run processes were stopped, and the regular worker again runs with real providers disabled.

The 2026-09-25 check covered embeddings, streaming and prompt cache: eight real OpenAI calls, calculated cost 0.0106614 USD out of the authorized 0.10 USD. Embeddings passed; a truncated JSON stream tail was fixed and verified on four subsequent real responses. The first run did not confirm a cache hit. A controlled rerun then confirmed 10880 cached tokens, a retained hit after a suffix change, a miss after changing the start of the prefix and a restored hit after reverting it. Total calculated cost of both runs was 0.0241598 USD out of 0.10 USD.

The LogoPanel follow-up check found no cache breakdown in Quiver's response. This limits the precision of financial reconciliation; the input-pricing rule without a cache split is described in the [decisions](DECISIONS.md). A sandbox response does not establish real generation.

AMI: live acceptance of alternative models completed within the confirmed budget. There were 35 calls, 33 successful, with cost 0.009948530 USD; unsuccessful outcomes were investigated and reservations closed. Gemini's numerical Standard quota remains unknown; functional verification is not an SLA or invoice reconciliation.

## Before the first paid call

1. Record the owner's authorized aggregate spending limit in USD and the list of connections. Fixture seed values are not such authorization.
2. Use a separate test installation and keys. Enter the generation key through the local admin interface and the reporting credential separately. Do not put keys in chat, Git, fixtures or reports.
3. Verify available model IDs, parameters and current rates against official sources. Store source and checked_at in the rate card, input/output bounds in the recipe and connection limits. Synthetic seed models and prices are unsuitable.
4. Assign provider budgets so that the sum of limits allocated to all real connections does not exceed the authorized total budget. This check requires new connections without previous spending. The period budget limits platform losses and does not replace the total provider-cost ceiling.
5. Obtain a quote without execution; verify both route branches, the per-attempt maximum, available provider exposure and retry risk. If a reliable maximum cannot be established, do not dispatch the call.
6. Enable `UAI_ALLOW_REAL_PROVIDERS=true` only in dedicated test processes after budget authorization. Do not run other paid work from this installation concurrently. Network report import is enabled separately through `UAI_ALLOW_REPORTING_API`.

## Live-run matrix

| Check | Minimal call | Report evidence | Result |
|---|---|---|---|
| RP01 OpenAI text | Short text, bounded output, SSE | Model/route/card versions, quote, attempt, terminal usage, charge, deltas and persistence before ACK | Passed, two text requests; no cache hit |
| RP02 Anthropic text | A comparable separate request | Independent input/output/cache semantics, provider request ID, cost and charge | Deferred by the owner; excluded from the current paid run |
| RP03 OpenAI image | One image at an authorized size/quality | Usage by modality, decode/dimensions, SHA256, durable demo copy, ACK and reread | Passed, two PNG 1024×1024 low images |
| RP04 Cartesia speech | Short text and explicit voice/API version/output format | Valid file, availability of individual billed usage. Missing usage stays unknown without an invented counter | Passed: one 1.6 s WAV, unknown usage, persistence and ACK; the real one-hour timeout had not yet elapsed |
| RP05 Paid search | One bounded Serper request | Response, explicitly reported search credits, bound, charge or unknown if data is incomplete | Passed: 7 results, 1 credit, calculated cost 0.001 USD, capture and ACK |
| RP06 Financial reports | Read-only report for an accessible period | Credential/account scope, all pages, coverage period, freshness, provider cost and local difference | Awaiting a separate reporting credential |
| RP07 Demo | Text, image and a composite action through the SDK | Per-step maximum/reservation/charge, reload with previous IDs, persistence and deletion of client files | Passed with OpenAI, four requests and three operations |

A real cache hit is tested only when the selected model's conditions and authorized budget permit it. A result with no cache hit cannot be presented as cache-hit verification. Forced corruption, retries, widespread 429 responses and unknown outcomes remain deterministic fault-injection checks; new paid attempts for those checks require separate spending justification.

## Evidence and stopping conditions

The report records version and operation IDs, monetary strings, attempt count, usage state, file SHA256 and final wallet/provider budget totals. Secrets and private content are not stored in the repository. Provider-account snapshots are not presented as the installation's internal balance or a promise of a number of generations.

On unknown usage, an unverified rate, an exceeded authorized budget or an unsupported endpoint, the run stops for the affected connection. Retrying a request is not a way to resolve an unknown outcome. Unavailable reporting permissions or endpoints are recorded as specific connection limitations.

After the run, disable real generation and reporting flags, reconcile provider exposure, cost entries, the journal and client ACKs. The goal is closed only after results are verified and remaining limitations are explicitly recorded.

## Jev

Live acceptance on 2026-09-26: five successful jev-1.13.0 calls, all on their first attempt, with calculated cost 0.000066948 USD out of an authorized 0.05 USD. The owner-selected limit of 32768 was applied under a separate decision; it is not a proven provider limit.
