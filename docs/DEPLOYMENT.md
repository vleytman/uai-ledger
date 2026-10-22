# Deploying UAI roles separately

[Contents](README.md) · [Operations](OPERATIONS.md) · [Distributed execution plan](DISTRIBUTED_EXECUTION_PLAN.md)

The templates in `deploy/` split the backend across three nodes. They are a validated startup foundation, not completed production acceptance. The public LogoPanel product and its combined admin shell are built by their own project. The runtime image below contains the UAI API, scheduler, workers and migrations; the browser admin and demo are not included.

## Roles

| Node | Template | Processes |
|---|---|---|
| Data | `deploy/compose.data.yaml` | PostgreSQL 17, Redis 7.4 with AOF and noeviction |
| Application | `deploy/compose.app.yaml` | API, scheduler; a separate manual migration command |
| Execution | `deploy/compose.workers.yaml` | generation, observation, maintenance |

The API listens only on the host loopback interface at port 4310. The project's reverse proxy provides external HTTPS and product admin access. PostgreSQL/Redis require an explicit `UAI_DATA_BIND_IP`, a private-network or VPN address. Use a firewall to open their ports only to the required servers. Passwords do not replace transport encryption; the template assumes a protected private network/VPN and does not configure TLS.

## Image and configuration

Build the image from the repository root:

```sh
docker build -f Dockerfile.runtime -t uai-runtime:release .
```

The installation uses pnpm 9.15.0 and `--frozen-lockfile`. The runtime executes TypeScript through tsx without a dev/watch server. The container user is `node`; Compose enables a read-only filesystem, tmpfs, capability removal and privilege-escalation prevention. The build context admits only required source files and manifests, excluding `.data`, `.env`, keys and node_modules. For reproducible releases, pin the base image and published runtime image by digest in your release process. Publishing the image to a registry is not performed here.

On application and worker nodes, set `UAI_IMAGE` and an absolute `UAI_RUNTIME_ENV_FILE`. The file contains:

- `DATABASE_URL` and `REDIS_URL` with the data-node address and separate passwords.
- The same `UAI_INSTALLATION_ID` for the API, scheduler and all workers in this installation.
- This installation's existing `UAI_VAULT_KEY`. Do not generate a replacement key during an update, or encrypted credentials will become inaccessible.
- S3 bucket, region, endpoint if required, credentials and the same `UAI_S3_PREFIX`. Compose enforces `UAI_BLOB_BACKEND=s3` because local files are not shared between servers. A private bucket without versioning/ObjectLock is required under the BlobStore limitations.
- `UAI_ALLOW_REAL_PROVIDERS=false` until settings are separately verified and paid calls are authorized.
- PostgreSQL pool and Redis timeout settings from the [operations guide](OPERATIONS.md).

Store env files outside Git with restricted permissions. On the data node, also set `UAI_POSTGRES_PASSWORD`, `UAI_REDIS_PASSWORD` and `UAI_DATA_BIND_IP`. Compose requires nonempty values. Do not publish `docker compose config` output: it can contain interpolated secrets; use `config --quiet` for validation.

## Startup order

On the data node:

```sh
docker compose -f deploy/compose.data.yaml up -d
```

After checking connectivity and backing up the existing database, on the application node:

```sh
docker compose -f deploy/compose.app.yaml --profile ops run --rm migrate
docker compose -f deploy/compose.app.yaml up -d api scheduler
```

On the execution node:

```sh
docker compose -f deploy/compose.workers.yaml up -d
```

Migrations are run explicitly, not by each worker at startup. The scheduler publishes jobs; the maintenance worker performs maintenance. Multiple schedulers are allowed only with the same installation ID and database. Generation concurrency is 4 for each text/image/audio/tools queue, not a total limit of 4. Account/application/queue domain limits and provider quotas further restrict actual execution.

Use `--scale generation=N` to add execution replicas. Account for the total PostgreSQL connection count across all replicas. Compose waits 45 seconds for shutdown; the worker's internal grace period is 30 seconds. Forced shutdown does not mean the provider request was canceled.

## Updates and rollback

Prepare a new image digest, validate it on staging, make a verifiable PostgreSQL backup and check access to shared S3. Apply additive migrations, then update scheduler/API/workers by role. Do not run old and new backends on the same request without the prescribed generation transition. Backend migration and rollback order are described in the [plan](DISTRIBUTED_EXECUTION_PLAN.md).

Redis AOF does not replace a PostgreSQL or S3 backup. Do not restore financial tables alone without consistent operation/attempt/storage data. Automated restore drills, S3 backup rules and full multi-host rollback still require acceptance. The templates do not perform these operations automatically.

## PostgreSQL restore drill

`scripts/check-backup-restore.ts` is available for a synthetic local database. It accepts only a `uai_load_*` name and explicit opt-in; production databases are rejected. It requires a local PostgreSQL Docker container whose `pg_dump`/`pg_restore` connect to the same database as `DATABASE_URL`.

```sh
UAI_RESTORE_TEST_ONLY=1 UAI_RESTORE_TEST_CONTAINER=uai-postgres-1 pnpm exec tsx scripts/check-backup-restore.ts
```

The script exports a repeatable-read snapshot and passes it to pg_dump, so table comparisons and the dump represent the same state even while the source receives writes. Restoration creates a new unique `uai_restore_*` database; existing databases are neither deleted nor overwritten. Checks cover hashes/row counts of all public tables, the balance of every journal transaction and agreement between lot balances and postings. Separate probes verify that restored triggers forbid history changes and unbalanced writes. All probes are rolled back.

The dump and report remain in `/tmp/uai-restore-*.dump` and `.json` with permissions 0600, and the new database is retained for inspection. These are temporary verification artifacts, not a backup retention policy. The runtime is not started against the restored database, and Redis and blob content are not restored. PostgreSQL/S3 consistency and safe resumption of unknown external requests need separate validation.

## Locally verified behavior

The ARM64 build, all 39 migrations on a separate database, API `/health` response 200, maintenance publication by the scheduler and execution by the production BullMQ worker were verified. Containers ran with a read-only filesystem; API and worker exited on SIGTERM with code 0. `/health` currently indicates a live HTTP process and does not test PostgreSQL, Redis or S3 readiness.

During the build, optional `msgpackr-extract` failed to compile without a native toolchain; BullMQ passed with the JS fallback. The check does not measure fallback performance on a VPS. AMD64 images, production secrets, HTTPS, separate VPS hosts, private S3 and the admin interface were not covered by this container check.
