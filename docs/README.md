# Documentation

UAI Ledger is a self-hosted service for AI execution, paid API calls, credit wallets and cost accounting. Start with a synthetic local installation, then configure the models, rates, budgets and provider connections needed by your application.

## Start here

1. Follow [Local setup](LOCAL_RUN.md) to install dependencies, start the services and try the demo without paid provider calls.
2. Read [Architecture](ARCHITECTURE.md) to understand process roles, application boundaries and data ownership.
3. Use [File configuration](FILE_CONFIGURATION.md) to validate, publish and activate model, pricing and route definitions.
4. Connect your application through [Invocations and SDK integration](INVOCATIONS.md) and the [API reference](API.md).
5. Read [Deployment](DEPLOYMENT.md) before exposing an installation outside your machine.

## Integration guides

| Guide | Use it to |
|---|---|
| [Invocations and SDK integration](INVOCATIONS.md) | Submit work, consume streams, upload files, persist results and acknowledge delivery |
| [API reference](API.md) | Authenticate a server-side client and use accounts, wallets, quotes, operations and administrative endpoints |
| [OpenAPI](openapi.json) | Generate or inspect a client against the machine-readable API contract |
| [External authentication](EXTERNAL_AUTH.md) | Connect your own sessions, team membership, staff roles and audit identity |
| [Modular admin](MODULAR_ADMIN.md) | Build a product admin shell using UAI's administrative modules |
| [Model capabilities and limits](MODEL_CAPABILITIES.md) | Use embeddings, structured output, tools, priority, forecasts, SVG generation and vectorization |
| [Text providers](TEXT_PROVIDERS.md) | Configure Cerebras, Groq and Google Cloud, including tool history, usage accounting and quota limitations |
| [Jev System One](JEV.md) | Submit typed evaluation batches through the TypeSafe adapter |
| [Paid API and allowance reference](PAID_API_CONTRACT.md) | Configure provider accounts, subscriptions, native usage counters and allowance reservations |

## Pricing and financial behavior

Provider costs, customer credit charges and external payment revenue are separate records. A quote's meaning depends on its payment mode: a fixed price, an accepted cost cap or an estimate that may be exceeded. Applications must display the selected mode accurately.

| Guide | Topics |
|---|---|
| [Accounting](ACCOUNTING.md) | Credit lots, expiration, reservations, postings, refunds, revocation and unknown costs |
| [Quoting and spending rules](QUOTING.md) | Recipes, pinned terms, reservation pools, final prices and estimated-actual charging |
| [Model catalog and pricing](MODEL_PRICING.md) | Calculation components, formulas, parameters, attachment preparation and price publication |

Integer monetary values are transmitted as strings. Native provider credits and usage quantities are not interchangeable with UAI wallet credits. The accounting and paid API references define the relevant units.

## Configuration and operations

| Guide | Topics |
|---|---|
| [File configuration](FILE_CONFIGURATION.md) | Bindings, validation, preview, publication, activation and configuration ownership |
| [Execution](EXECUTION.md) | Queues, quotas, attempts, timeouts, cancellation, failover and recovery |
| [Operations](OPERATIONS.md) | Admin pages, budgets, provider balances, reconciliation, incidents, metrics and troubleshooting |
| [Deployment](DEPLOYMENT.md) | Process roles, containers, shared storage, updates, backups and restore drills |

## Operating boundaries

- Keep provider keys and service tokens on the server. Never forward a browser-supplied identity header as trusted context.
- Treat an unknown provider outcome or cost as unknown. Do not assume a disconnected client canceled provider work or made it free.
- Persist results in your application before acknowledging delivery. UAI's content storage is temporary.
- Verify current model availability, provider rates and account-specific quotas before enabling a real connection. Example configurations are not a current price guarantee.
- Payment collection, subscriptions, taxes, product permissions and permanent application content remain outside UAI.
- `/health` confirms HTTP-process availability; it is not a complete database, Redis or storage readiness check.
