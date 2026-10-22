# Local run

[Contents](README.md) · [Acceptance matrix](ACCEPTANCE_RESULTS.md)

Requires Node.js 22.12 or newer, pnpm 9.15 and Docker Compose. Verified on macOS with Node.js 23.6 and Linux amd64 with Node.js 22.23.2; CI commands passed in a separate container. PostgreSQL 17 is exposed only on loopback port 55432. All examples target local development.

## Existing local demo installation

The primary installation was switched to BullMQ and persistent S3 on 2026-09-20. API: `http://127.0.0.1:4310`, admin: `http://127.0.0.1:4311`, demo: `http://127.0.0.1:4312`. Migrations through 0054; history preserved. Migration and verification results.

Private settings for this installation are in `.data/distributed-runtime.env`, which is excluded from Git. PostgreSQL/Redis use the main compose file; persistent MinIO uses `docker compose -f deploy/compose.local-storage.yaml up -d`. Do not delete the storage volume. Rerunning `pnpm seed` is unnecessary for an existing configured installation.

Start the API and scheduler in separate terminals without watch:

```sh
node --env-file=.data/distributed-runtime.env --import tsx apps/api/src/index.ts
```

```sh
node --env-file=.data/distributed-runtime.env --import tsx apps/scheduler/src/index.ts
```

Start each of the three workers separately as well:

```sh
UAI_WORKER_QUEUES=text,image,audio,tools UAI_WORKER_CONCURRENCY=4 node --env-file=.data/distributed-runtime.env --import tsx apps/worker/src/index.ts
```

```sh
UAI_WORKER_QUEUES=observe UAI_WORKER_CONCURRENCY=4 node --env-file=.data/distributed-runtime.env --import tsx apps/worker/src/index.ts
```

```sh
UAI_WORKER_QUEUES=maintenance UAI_WORKER_CONCURRENCY=1 node --env-file=.data/distributed-runtime.env --import tsx apps/worker/src/index.ts
```

Do not start a second set over running processes. PIDs and logs for the current local run are listed in the private `.data/distributed-processes.json`; verify the PID and process command before stopping anything, because the file may be stale. These are local processes, not an installed system supervisor. For a separate server, use the [deployment guide](DEPLOYMENT.md).

## Preparing a new installation

```sh
pnpm install --frozen-lockfile
docker compose up -d
cp .env.example .env
```

Load variables into each terminal before starting a service:

```sh
set -a
source .env
set +a
```

Then:

```sh
pnpm db:migrate
pnpm seed
```

Migrations run transactionally with an advisory lock and SHA-256 verification of previously applied files. Do not edit an applied migration. To test upgrades, create a new database and apply new migrations. Seed runs only with `UAI_ENV=test`; rerunning it preserves the existing local installation.

Seed creates a zero-balance account, synthetic text/image profiles and a composite recipe. These are fixtures; their rates are not provider prices. Settings and random passwords are written to `.data/demo-config.json` and `.data/admin-config.json` with permissions 0600. The credential encryption key is stored in `.data/vault-key`, also with permissions 0600. These files are excluded from Git.

## Services

Run each command in a separate terminal from the repository root. UI configuration paths must be absolute because pnpm starts Vite from the application directory:

```sh
export UAI_DEMO_CONFIG="$PWD/.data/demo-config.json"
export UAI_ADMIN_CONFIG="$PWD/.data/admin-config.json"
export UAI_DEMO_ROOT="$PWD/.data/demo"
export UAI_BLOB_ROOT="$PWD/.data/blobs"
```

- `pnpm dev:api`: HTTP API at 127.0.0.1:4310.
- `pnpm dev:worker`: durable request execution.
- `pnpm dev:scheduler`: recovery, financial closure, expiry, purge, numeric monitors, outbox.
- `pnpm dev:admin`: [admin interface](http://127.0.0.1:4311).
- `pnpm dev:demo`: [test client](http://127.0.0.1:4312).

Sign in with `login_password` from the corresponding local configuration file. Do not copy passwords, service tokens or the vault key into Git, messages or reports. The browser receives an HttpOnly session; UAI keys stay on the backend.

In the demo, grant test credits, obtain a quote and confirm the maximum. The test-credit section also lets you set the available balance, including 0 and fractional amounts with up to 6 decimal places, to test insufficient funds. The command requires `UAI_ENV=test` on both demo and API, and `credits:test-balance` scope on the test token; a new seed grants it automatically. Open reservations block adjustment, and a stale revision is rejected. Replaying a command does not set the balance again. The `demo.description-image` profile executes description and image in one operation. Demo stores history and files independently of UAI temporary storage; file size and digest are verified before ACK. Deleting a conversation requires confirmation and removes the local copy; UAI keeps only financial history and technical metadata.

## Validation

For isolated external-session testing, run `UAI_ENV=test DATABASE_URL=<test-db-url> pnpm exec tsx scripts/run-external-auth-fixture.ts`. The script creates its own test database, starts the API and parent host only on loopback port 4327 and disables real providers. The initial test user needs CREATEDB. This command does not change login for the active demo. [Scenarios and contract](EXTERNAL_AUTH.md).

```sh
pnpm typecheck
pnpm check:api
REQUIRE_INTEGRATION_TESTS=1 pnpm test
pnpm docs:check
pnpm build
```

For reproducible integration checks, use a separate clean database through `DATABASE_URL`. Tests create unique organizations and must not target production or the active demo database. `REQUIRE_INTEGRATION_TESTS=1` fails validation when `DATABASE_URL` is missing; CI enables this flag. Without that flag and without `DATABASE_URL`, PostgreSQL suites are skipped; such a result is not financial-core acceptance.

Relay, worker-crash and HTTP demo integration tests require the test PostgreSQL user to have `CREATEDB`. They create separate `uai_isolated_test_*` databases, apply migrations and drop those databases after connections stop. This prevents interference with other fixtures while testing the shared queue. This privilege is required for the test environment, not the production runtime.

`UAI_WORKER_ONCE=true` and `UAI_SCHEDULER_ONCE=true` execute one step of the corresponding process. Controlled test clocks allow one-hour deadlines and recovery to be checked without waiting an actual hour.

## Real connections

`UAI_ALLOW_REAL_PROVIDERS=false` blocks paid providers. A live run requires separate budget authorization, provider credentials, published and verified models/rates, a route and risk limits. Built-in synthetic profiles are unsuitable for real requests.

`UAI_ENABLE_WEBHOOK_DELIVERY=false` leaves external delivery disabled. Fixtures check signatures and retries without sending to real recipients. Production deployment, payments, Logo Panel and full stage 7 are outside the current work.

## Active limits and recovery

In the admin interface, `execution-budgets` changes the budget table checked by the worker. Amounts are strings in internal USD units, where 1 USD = 1 000 000 000 units. A provider budget belongs to a connection; a period budget belongs to a recipe key. Lowering a limit does not reset incurred spending or open exposure; it stops further admission when the budget is insufficient. Connection `risk_policy` fields do not change this limit by themselves. Edits require a reason, an idempotency key and a matching previous limit.

`execution-limiters` edits active windows, RPM, token budget and concurrency of groups referenced by a published route. Edits preserve current-window counters; CAS uses a configuration hash that excludes mutable counters. A shared period or limiter key referenced by several applications in one organization cannot be edited through application-scoped admin access. There is no separate organization-admin API in v0.3.

Before opening the API, the restore retention guard runs and reapplies persisted tombstones and retention deadlines. During restoration, restore the deletion journal first. The guard cannot recover deletion records absent from the selected backup.

The reporting credential is stored separately from the generation key and encrypted by the same local vault. `UAI_ALLOW_REPORTING_API=true` permits only provider report import. Import networking is disabled by default; fixture checks do not use real keys.

### Testing real generations during development

For paid checks, start worker and scheduler without a file watcher. `tsx watch` may forcibly terminate a process when an imported file changes during a request, leaving the outcome unknown. With the local installation environment loaded:

```sh
UAI_ALLOW_REAL_PROVIDERS=true pnpm exec tsx apps/worker/src/index.ts
UAI_ALLOW_REAL_PROVIDERS=true pnpm exec tsx apps/scheduler/src/index.ts
```

Stop the previous instances before starting these processes. A persisted `outcome_unknown` must not be declared free or automatically retried: scheduler and reconciliation preserve unknown-usage rules.

Configure refined OpenAI profiles for an existing demo installation with `pnpm exec tsx scripts/setup-precise-demo.ts`. The command publishes new immutable configuration versions to the database in `DATABASE_URL`; it does not raise provider limits. Rerunning it creates subsequent versions. Verify rates and their checked date in the configurations before applying them.


## Central pricing profiles

The current local installation has the `central.model-pricing.examples` catalog published. In admin, Model cost calculation contains components and per-model Safety factor/Markup. Initial versions used safety factor 1 and markup 0. The updated seven-model set and owner-approved values are described below in "Simplified seven-model demo".

Demo shows the final price before execution. Changing text, parameters or references requires a new calculation. The internal reservation ensures a single charge at the agreed price. A real call happens only after execution confirmation and uses the configured provider connection.

`scripts/setup-model-pricing-demo.ts` creates new versions of these profiles using existing locally published rates and base profiles `fixed.openai.sunburst` and `check.openai.nano`. It requires `UAI_ENV=test` and a configured DATABASE_URL; it does not generate anything itself. It is neither an independent seed for an empty installation nor a provider-price update command. Rerunning creates new versions; there is no need to rerun it just to inspect the UI.

The admin calculator does not call the provider. Reference metadata in its validation input is specified manually; real quotes read files, validate their content and prepare bytes on the backend. See the [central pricing specification](MODEL_PRICING_SPEC.md).

### Simplified seven-model demo

Updated 2026-09-19. The [demo](http://127.0.0.1:4312) separates the main lists into chat and images. Models with a final price are shown by default. Older, composite and fixture profiles are available through the option to show old and test profiles. Format and background are under advanced settings; postings and limits are under spending and technical details. Changing the model preserves the prompt, references and compatible parameters but resets the calculated price.

`scripts/setup-model-pricing-demo.ts` publishes new catalog, rate, route and recipe versions only to local `uai_local`. It makes no paid calls. Numerical settings were approved by the owner: safety factor `1.1`, markup `100%`, total multiplier `2.2`. Old quotes and published versions are preserved.

| Model | Input / cache / output, USD per million tokens | Calculation |
| --- | --- | --- |
| GPT-5.6 Sol | 4 / 0.4 / 20 | Input and selected output limit; cache write 5 |
| GPT-5.6 Terra | 2 / 0.2 / 12 | Input and selected output limit; cache write 2.5 |
| GPT-4.1 nano | 0.1 / 0.025 / 0.4 | Input and selected output limit |
| GPT-4.1 | 2 / 0.5 / 8 | Input and selected output limit |
| GPT Image 2 | Text 5; image input 8; output 30 | 90 table rows plus prompt and references |
| GPT Image 2.5 Sunburst | Text 5; image input 8; output 30 | 150 table rows plus prompt and references |
| GPT Image 2.5 Flare | Text 5; image input 8; output 30 | 150 table rows plus prompt and references |

Rate sources verified on 2026-09-19: [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano), [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare), [images](https://developers.openai.com/api/docs/guides/image-generation). Sol and Terra use available aliases; other models are pinned to snapshots.

Text profiles support response limits of 128, 512, 1024, 2048 and 4096 tokens. The final price uses the selected limit, including reasoning; a shorter actual response does not reduce the price. For Sol/Terra, input is estimated at the higher cold-cache write rate. Actual accounting preserves ordinary, cached and written tokens separately. The input estimate is capped at 16000 tokens, so higher long-context rates do not apply here. Attachments and paid tools are not enabled for text profiles.

Images support 10 aspect ratios: 1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16, 2:1, 1:2 and 21:9. Each has three resolution levels. 1K and 2K target areas of 1024² and 2048²; 4K is bounded by area 3840×2160 and side length 3840. Dimensions are rounded down to multiples of 16, and exact pixels are shown in the form. This keeps all 30 variants within provider limits. For example, square 4K is 2880×2880. Quality levels are low/medium/high for Image 2, with xhigh/max additionally available for 2.5. Auto is excluded because it does not define a concrete quality for advance pricing. The provider marks resolutions above 2560×1440 as experimental.

All 390 combinations have table rows; format and background are not included in table prices. Input images are prepared at up to 1024×1024; the formula estimates 1024 tokens per reference. Text framing and input-image estimates remain empirical, and output tables are calculator estimates rather than guaranteed usage. The customer price is fixed; any difference in actual provider cost is visible in diagnostics after execution.

### Updating text profiles to forecast billing

`DATABASE_URL=postgresql://uai:uai_local_only@127.0.0.1:55432/uai_local UAI_ENV=test pnpm exec tsx scripts/setup-model-pricing-demo.ts --text-only` publishes new versions of four text profiles with `estimated_actual`. Images remain in the catalog and their recipes are not updated. Apply migrations before running; restart worker and scheduler after runtime changes. The script performs no paid requests. Demo shows the expected 4096 tokens and approximate cost; final charging follows usage with markup, and debt is allowed under the [owner decision](DECISIONS.md#text-estimation-separate-from-generation-limits).

## File publication PA-I00

[validate/preview/publish/activate commands and isolated UI fixture](FILE_CONFIGURATION.md). Migration 0056 was checked in a separate local database; this stage did not switch the primary demo installation.

## Paid APIs in the demo

The paid API section of the [demo](http://127.0.0.1:4312/#api) contains four real Firecrawl scenarios. See the [paid API contract](PAID_API_CONTRACT.md). Quoting does not call the provider; a paid call requires the confirmation button. Test wallet credits and Firecrawl credits are displayed separately.

## LogoPanel follow-up

After updating, run `pnpm db:migrate`: new migrations persist validation diagnostics and interactive reserve. For a BullMQ worker, `UAI_WORKER_INTERACTIVE_RESERVE=1` sets the number of local slots for live invocations; concurrency ≥2 is required for physical separation. Profiles in `configurations/ai/logopanel/` do not publish or activate themselves. See the [contract](LOGOPANEL_FOLLOWUP_INTEGRATION.md) and [validation plan](LOGOPANEL_FOLLOWUP_PLAN.md).

## Jev offline fixture

After migrations in a separate local database prefixed with `uai_jev_`:

```sh
UAI_ENV=test UAI_ALLOW_REAL_PROVIDERS=false pnpm exec tsx scripts/run-jev-fixture.ts
```

The script uses this database's DATABASE_URL and starts API 4345, admin 4346 and demo 4347. The password for this test installation only is `jev-local-fixture`. Transport is substituted; the provider is not called. [Contract and limitations](JEV.md).

## Local acceptance reports

Run reports are stored only in ignored `.data/reports/` and are not included in Git. `pnpm exec tsx scripts/update-acceptance.ts` reads `*-acceptance.json` files there and updates matrix A01–A91. Before updating, check that the full report set is available: a missing scenario will be marked unverified. The published matrix keeps test references and limitations, but not local JSON artifact names.
