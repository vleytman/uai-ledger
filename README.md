<p align="center">
  <img src="docs/assets/uai-ledger-banner.png" width="960" alt="UAI Ledger — abstract layers and ledger entries on a light paper background">
</p>

<p align="center">
  <strong>AI execution, credit wallets, and cost accounting for your application.</strong>
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#core-concepts">Core concepts</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#providers-and-configuration">Providers</a> ·
  <a href="#application-integration">API &amp; SDK</a> ·
  <a href="docs/README.md">Docs</a>
</p>

---

UAI Ledger is a self-hosted service that runs AI requests and paid API calls for your app. Submit work through the API or TypeScript SDK; UAI estimates the cost, reserves credits, queues the request, and records usage and provider costs as the work runs.

- **One execution layer.** Use configured adapters for text, images, speech, embeddings, and paid tools, with queues, quotas, deadlines, cancellation, and recovery.
- **Credit wallets.** Track grants, expiration, reservations, charges, and refunds in a financial journal with protection against duplicate commands.
- **Costs you can follow.** Inspect each provider attempt and keep provider costs separate from customer charges and payment revenue. Unknown outcomes stay visible.
- **Results your app owns.** Save results in your own storage, then acknowledge delivery. UAI keeps the financial history and removes temporary content under its retention rules.

The repository includes the service, TypeScript SDK, admin interface, and a synthetic demo. The usual setup is one installation per application, with its own database, storage, configuration, and provider keys. Your app keeps its users, permissions, product UI, and payment integration.

## How it works

1. **Choose the work.** Select a published model profile or recipe and supply the input.
2. **Get a quote.** UAI calculates the price or estimate and returns the payment terms, configuration versions, and required reservation.
3. **Accept the terms.** UAI reserves funds and creates an operation. Repeating the same command with the same idempotency key and input returns the accepted work.
4. **Run the request.** A worker checks queue capacity and provider quotas, records dispatch intent, and calls the provider under the accepted execution policy.
5. **Settle the result.** UAI saves the result and usage information, calculates the customer charge, and releases unused reservations according to the accepted terms. An unknown provider cost remains unresolved rather than becoming zero.
6. **Save, then acknowledge.** Your app saves the result durably before confirming delivery. UAI can then remove its temporary copy while retaining the financial records.

For work that grows over several calls, open a reservation pool and add invocations as you go. See the [quoting and reservation rules](docs/QUOTING.md) and the [request and delivery diagram](docs/INVOCATIONS.md#request-and-delivery-flow).

## Quick start

Start with the synthetic models. This gives you a local installation without provider credentials or paid calls; real calls are disabled by default.

### Requirements

- Node.js 22.12 or newer.
- pnpm 9.15; the project version is pinned in `package.json`.
- Docker with Docker Compose for PostgreSQL 17 and Redis.
- Available local ports `55432`, `56379`, `4310`, `4311`, and `4312`.

### 1. Install dependencies and prepare data

```sh
git clone https://github.com/vleytman/uai-ledger.git
cd uai-ledger
pnpm install --frozen-lockfile
docker compose up -d --wait
cp .env.example .env
```

Load the environment variables from the repository root:

```sh
set -a
source .env
set +a

pnpm db:migrate
pnpm seed
```

`seed` is allowed only when `UAI_ENV=test`. It creates synthetic profiles, a zero-balance test account, and local interface configuration. Random passwords, service tokens, and the credential-vault key are written to the Git-ignored `.data/` directory.

The seeded models and rates are test fixtures. Use them to try the workflow, not to estimate a real provider bill.

### 2. Start the processes

Open five terminals. In each terminal, change to the repository root and run this environment setup block:

```sh
set -a
source .env
set +a

export UAI_DEMO_CONFIG="$PWD/.data/demo-config.json"
export UAI_ADMIN_CONFIG="$PWD/.data/admin-config.json"
export UAI_DEMO_ROOT="$PWD/.data/demo"
export UAI_BLOB_ROOT="$PWD/.data/blobs"
```

Then run one command in each terminal:

| Process | Command | Address |
|---|---|---|
| API | `pnpm dev:api` | `http://127.0.0.1:4310` |
| Worker | `pnpm dev:worker` | Background process |
| Scheduler | `pnpm dev:scheduler` | Background process |
| Admin | `pnpm dev:admin` | `http://127.0.0.1:4311` |
| Demo | `pnpm dev:demo` | `http://127.0.0.1:4312` |

Check basic API availability with:

```sh
curl http://127.0.0.1:4310/health
```

### 3. Test a request in the demo

Open the demo and sign in with `login_password` from `.data/demo-config.json`. The admin interface has its own password in `.data/admin-config.json`.

Use the demo's test-credit form to fund the wallet. Select a synthetic profile, get a quote, confirm the request, and check the result, reservation, and final charge. Keep the API, worker, and scheduler running throughout.

For BullMQ, S3, fixtures, and diagnostics, follow the [local run guide](docs/LOCAL_RUN.md). Check for an existing installation before starting another set of processes on the same ports and database.

## Core concepts

| Concept | What it means |
|---|---|
| Model profile | A published choice of model, parameters, routing, pricing, and execution settings |
| Quote | The calculated terms for specific input: a fixed price, an accepted cap, or an estimate, depending on billing mode |
| Operation | Accepted work with its saved terms and reservation; it can contain one or several requests |
| Request and attempt | A request is a work item; each attempt records a separate submission to a provider |
| Wallet and credit lot | The customer's credit budget, split into grants with their own terms and expiration |
| Reservation | Credits held for accepted work; the hold itself is not a charge |

Payment mode matters. A fixed-price quote, an actual-usage cap, and an `estimated_actual` forecast make different promises. In forecast mode, the initial hold is not a guaranteed ceiling and an authorized policy can allow debt. See [financial rules](#financial-rules) before choosing what to show in your UI.

## Architecture

![Architecture showing the application backend, UAI API, workers, scheduler, database, queue and temporary storage](docs/diagrams/architecture.svg)

The service runs as separate processes, with shared code and contracts:

| Component | Purpose |
|---|---|
| API | Authorization, wallets, quotes, operation acceptance, result reads, and events |
| Workers | Request execution, adapter calls, result persistence, and attempt settlement |
| Scheduler | Recovery, financial deadlines, credit expiration, cleanup, and queue maintenance |
| PostgreSQL | Financial journal, configuration, operations, attempts, and consistent state |
| Redis / BullMQ | Distributed job delivery and execution coordination in the corresponding mode |
| Blob storage | Temporary input files and results, using the local filesystem or S3-compatible storage |
| Admin | Installation management through a server-backed administrative interface |
| Demo | A separate test client for checking the complete API and SDK workflow |

The backend is written in TypeScript and uses Fastify. The interfaces use TanStack Start, React, and shared UI components. API schemas and TypeScript SDK types are included in the repository.

If you run workers on several machines, they need shared storage and matching installation settings. The [deployment guide](docs/DEPLOYMENT.md) covers startup order, container templates, and the checks you still need to run for your environment.

## Providers and configuration

The code registers adapters for OpenAI, Anthropic, Cartesia, Serper, Firecrawl, Cerebras, Groq, Google Cloud, Quiver, Replicate, Voyage, and TypeSafe. Synthetic adapters are also available for local checks.

Each adapter supports a specific set of models and operations. Read its integration guide for parameters, usage reporting, and limitations, then verify current prices and account limits before enabling it.

Keep models, rates, routes, recipes, and API definitions in [configurations/](configurations/). UAI validates changes and publishes immutable versions, so accepted work can keep the configuration it started with. Credentials stay out of these files. Use the admin interface to inspect published definitions and change supported operational settings.

See [file configuration](docs/FILE_CONFIGURATION.md), [universal invocations](docs/INVOCATIONS.md), and [deployment requirements](docs/DEPLOYMENT.md).

## Financial rules

Keep three amounts separate: what the provider costs you, what you charge the customer's credit wallet, and what your payment service collects. A result can be ready before its exact provider cost is known. A delivery error can happen after you have already incurred that cost.

| Situation | UAI behavior |
|---|---|
| A client repeats a financial command | Returns the previous command's result when its idempotency key and data match |
| Funds are reserved | Preserves the accepted work's terms and configuration versions |
| A provider may have accepted a request, but the response was lost | Preserves the unknown outcome; does not treat the cost as zero or blindly repeat potentially completed work |
| Confirmed usage becomes available | Calculates the charge under the accepted policy, with protection against duplicate charging |
| The result is technically defective | Applies platform-funded payment rules and records the platform's costs |
| Rates change | New versions apply to new work; existing operations keep their accepted terms |

Choose the payment policy that fits the profile: a final price agreed before execution, actual-usage settlement within an accepted maximum, or an `estimated_actual` forecast. With a forecast, the reservation is only an initial hold; the final charge may be higher, and an authorized policy can allow debt. Show that distinction in your interface so users know what they are agreeing to.

The API sends integer monetary values as strings to preserve precision. Budget units, wallet credits, and provider-native allowances each have their own meaning; see [accounting](docs/ACCOUNTING.md), [quoting](docs/QUOTING.md), and the [paid API contract](docs/PAID_API_CONTRACT.md).

## Application integration

Connect UAI from your application's server. Keep provider keys and UAI service tokens there, and check the user's session and permissions before submitting work.

Use the TypeScript SDK in [packages/sdk/](packages/sdk/) for wallets, quotes, operations, invocations, files, and events. The [API contract](docs/API.md) has request schemas and server-side examples. The SDK is a workspace package in this repository; don't assume it is published on npm.

For external authentication and teams, use the [identity contract](docs/EXTERNAL_AUTH.md). For embedding administrative modules in your own shell, see the [modular admin contract](docs/MODULAR_ADMIN.md).

## Repository structure

| Directory | Contents |
|---|---|
| [apps/](apps/) | API, worker, scheduler, admin interface, and demo |
| [packages/](packages/) | Accounting, quoting, execution, queues, adapters, SDK, shared contracts, and UI |
| [configurations/](configurations/) | File-based model, route, rate, and API definitions |
| [migrations/](migrations/) | Versioned PostgreSQL migrations |
| [scripts/](scripts/) | Migrations, seed, schema generators, fixtures, and validation commands |
| [deploy/](deploy/) | Templates for deploying process roles separately |
| [templates/](templates/) | Product admin-shell integration template |
| [docs/](docs/) | Setup, integration, configuration, and operations guides |

## Validation

Main commands from the project root:

```sh
pnpm check:api
pnpm check:configuration
pnpm check:paid-api
pnpm typecheck
pnpm docs:check
pnpm build
```

For integration tests, load the environment for a separate test database and run:

```sh
REQUIRE_INTEGRATION_TESTS=1 pnpm test
```

Set `DATABASE_URL` to a separate test database. Without it, some PostgreSQL suites are skipped, so a passing run won't verify the financial rules. The test role needs `CREATEDB` for isolated scenarios. Never point these tests at production or the active demo database.

The [local guide](docs/LOCAL_RUN.md) covers service startup and development checks. Documentation checks validate Markdown and examples; implementation tests check behavior. Synthetic fixtures still need to be followed by checks against each real provider you intend to use.

## Real requests and operations

Before using a paid provider, supply your own credentials, verified model parameters and rates, published configuration, budgets, and quotas. `UAI_ALLOW_REAL_PROVIDERS=false` blocks real calls by default. Financial report imports and external webhook delivery are enabled separately.

`.env`, `.data/`, keys, and local reports are excluded from Git. A working deployment needs separate secrets, backups of the database and encryption key, configured storage, and a tested recovery process.

The quick-start admin and demo are intended for local development. Before exposing them externally, validate authorization, network boundaries, and operational requirements against the [deployment guide](docs/DEPLOYMENT.md).

## Documentation

- [Service overview and boundaries](docs/README.md).
- [Architecture and module ownership](docs/ARCHITECTURE.md).
- [Credit lots, postings, and financial invariants](docs/ACCOUNTING.md).
- [Quoting, pricing, and reservations](docs/QUOTING.md).
- [Execution, cancellation, timeouts, and recovery](docs/EXECUTION.md).
- [API and SDK](docs/API.md).
- [Operations, budgets, quotas, and observability](docs/OPERATIONS.md).
- [Local run guide](docs/LOCAL_RUN.md) and [deployment](docs/DEPLOYMENT.md).
