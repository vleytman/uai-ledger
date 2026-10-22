# Local setup

[Documentation](README.md) · [Application integration](INVOCATIONS.md) · [Deployment](DEPLOYMENT.md)

Start here to run UAI locally with synthetic providers. You won't need provider credentials, and these steps make no paid model requests.

## Requirements

- Node.js 22.12 or newer and pnpm 9.15, as pinned in `package.json`.
- Docker with Docker Compose.
- Available ports `55432` for PostgreSQL 17, `56379` for Redis, and `4310`–`4312` for the API and interfaces.

Run commands from the repository root. If another installation already uses these ports, configure separate ports and a separate database before starting this one.

## Install and initialize

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait
cp .env.example .env

set -a
source .env
set +a

pnpm db:migrate
pnpm seed
```

The sample database credentials are local development values. Do not use them for an externally accessible deployment.

Migrations run in a transaction, use an advisory lock, and check the SHA-256 checksum of each applied file. Once a migration has run, leave it unchanged and add a new file for the next upgrade.

`seed` requires `UAI_ENV=test`. It creates a zero-balance account, synthetic text/image profiles, and a composite recipe. You can run it again without replacing an existing configured local installation. The sample rates are fixtures, not provider prices.

Look for the generated passwords, service tokens, and encryption key in `.data/demo-config.json`, `.data/admin-config.json`, and `.data/vault-key`. The files have restricted permissions and are excluded from Git. Back up this installation's vault key with its database: without the original key, UAI cannot decrypt stored credentials.

## Start the services

Use a separate terminal for each process. In each terminal, load the environment and set absolute UI/storage paths:

```sh
set -a
source .env
set +a

export UAI_DEMO_CONFIG="$PWD/.data/demo-config.json"
export UAI_ADMIN_CONFIG="$PWD/.data/admin-config.json"
export UAI_DEMO_ROOT="$PWD/.data/demo"
export UAI_BLOB_ROOT="$PWD/.data/blobs"
```

Then start one command per terminal:

| Service | Command | Address or role |
|---|---|---|
| API | `pnpm dev:api` | `http://127.0.0.1:4310` |
| Worker | `pnpm dev:worker` | Executes durable requests |
| Scheduler | `pnpm dev:scheduler` | Recovery, financial deadlines, expiration and cleanup |
| Admin | `pnpm dev:admin` | `http://127.0.0.1:4311` |
| Demo | `pnpm dev:demo` | `http://127.0.0.1:4312` |

Use absolute configuration paths because pnpm starts Vite from the application's directory, not the repository root.

Check the HTTP process:

```sh
curl http://127.0.0.1:4310/health
```

A successful response tells you the HTTP process is running. Check PostgreSQL, Redis, and blob storage separately.

## Sign in and run a synthetic request

Use `login_password` from `.data/demo-config.json` for the demo, and the separate password from `.data/admin-config.json` for the admin interface. Browser sessions are HttpOnly; service credentials stay on the backend.

In the demo, grant test credits, select a synthetic profile, request a quote and confirm execution. Check the result, wallet reservation and final charge. Keep API, worker and scheduler running for the complete workflow.

To try insufficient-funds behavior, use the test-credit form to set the available balance to zero or a fractional value. Both the demo and API need `UAI_ENV=test`, and the key needs `credits:test-balance` scope. UAI rejects the change if reservations are open or the balance revision is stale.

The demo keeps its own history and files outside UAI's temporary storage. Deleting a conversation removes that saved content after confirmation, while financial records stay in place. Your application needs its own permanent storage and deletion policy too.

## Configure real providers

1. Create the required provider connection and credentials in the admin interface.
2. Verify the model, current rates, provider account limits and usage-accounting capabilities.
3. Publish a compatible model/route/recipe using [File configuration](FILE_CONFIGURATION.md), with bindings to this installation's connection and budgets.
4. Configure provider quotas and financial limits before dispatch. Multiple keys for one provider account must share the appropriate quota group.
5. Enable real calls only for the intended processes and within an explicitly chosen spending budget.

`UAI_ALLOW_REAL_PROVIDERS=false` blocks real providers by default. `UAI_ALLOW_REPORTING_API` and `UAI_ENABLE_WEBHOOK_DELIVERY` control report imports and external delivery separately. An inference key does not imply permission to read financial reports.

For paid work, run the worker and scheduler without file watchers. Load the installation environment first, then run these commands in separate terminals:

```sh
UAI_ALLOW_REAL_PROVIDERS=true pnpm exec tsx apps/worker/src/index.ts
```

```sh
UAI_ALLOW_REAL_PROVIDERS=true pnpm exec tsx apps/scheduler/src/index.ts
```

Stop the previous instances before starting replacements. A forced restart can leave you unsure whether the provider finished a call. Follow the recovery rules in [Execution](EXECUTION.md) before trying it again.

## Queues, shared storage and deployment

The development compose file supplies PostgreSQL and Redis. For BullMQ process roles, installation IDs, Redis namespaces, shared S3 storage and worker concurrency, follow [Deployment](DEPLOYMENT.md) and [Operations](OPERATIONS.md). Starting containers alone does not switch every request to a different execution backend.

Give each installation its own database, secrets and storage namespace. Never copy another installation's `.data/` directory as a deployment configuration.

## Development checks

```sh
pnpm check:api
pnpm check:configuration
pnpm check:paid-api
pnpm typecheck
pnpm docs:check
pnpm build
```

For database-backed tests, use a separate test database:

```sh
REQUIRE_INTEGRATION_TESTS=1 pnpm test
```

With this flag, the run fails if `DATABASE_URL` is missing. Without a database, some suites are skipped and won't verify financial behavior. Isolated tests need a role with `CREATEDB`. Use neither production nor the active demo database.

The test suite also includes dedicated process-crash, Redis-restart, storage and container checks. Read the corresponding test command and environment requirements before running disruptive checks against shared services.
