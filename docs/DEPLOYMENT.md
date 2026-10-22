# Deploying UAI roles separately

[Contents](README.md) · [Operations](OPERATIONS.md)

Use the templates in `deploy/` to split the backend across three nodes. Before sending user traffic, check networking, credentials, persistence, and resource limits in your environment. Build your product frontend and combined admin shell separately: the runtime image contains the UAI API, scheduler, workers, and migrations, but no browser admin or demo.

## Roles

| Node | Template | Processes |
|---|---|---|
| Data | `deploy/compose.data.yaml` | PostgreSQL 17, Redis 7.4 with AOF and noeviction |
| Application | `deploy/compose.app.yaml` | API, scheduler; a separate manual migration command |
| Execution | `deploy/compose.workers.yaml` | generation, observation, maintenance |

The API listens on the host's loopback interface at port 4310. Put your reverse proxy in front of it for external HTTPS and product admin access. PostgreSQL and Redis need an explicit `UAI_DATA_BIND_IP` on a private network or VPN. Restrict their ports to the servers that need them. The templates assume a protected network and do not configure TLS; passwords alone do not encrypt transport.

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

For an update, prepare a new image digest and validate it on staging. Take a verifiable PostgreSQL backup and check access to shared S3, then apply additive migrations and update scheduler, API, and workers by role. Follow the generation transition before moving a request between backends; never let old and new backends execute it together. Rehearse that transition on staging and keep database and storage state consistent if you roll back.

Back up PostgreSQL and S3 separately; Redis AOF cannot replace either. Restore financial tables together with the matching operation, attempt, and storage data. Configure S3 backups and rehearse a complete multi-host restore before relying on the deployment, because the templates do not automate backups or rollback. `/health` confirms the HTTP process is available; check the database, queue, and storage separately.

## PostgreSQL restore drill

`scripts/check-backup-restore.ts` is available for a synthetic local database. It accepts only a `uai_load_*` name and explicit opt-in; production databases are rejected. It requires a local PostgreSQL Docker container whose `pg_dump`/`pg_restore` connect to the same database as `DATABASE_URL`.

```sh
UAI_RESTORE_TEST_ONLY=1 UAI_RESTORE_TEST_CONTAINER=uai-postgres-1 pnpm exec tsx scripts/check-backup-restore.ts
```

The script exports a repeatable-read snapshot and passes it to pg_dump, so table comparisons and the dump represent the same state even while the source receives writes. Restoration creates a new unique `uai_restore_*` database; existing databases are neither deleted nor overwritten. Checks cover hashes/row counts of all public tables, the balance of every journal transaction and agreement between lot balances and postings. Separate probes verify that restored triggers forbid history changes and unbalanced writes. All probes are rolled back.

The dump and report remain in `/tmp/uai-restore-*.dump` and `.json` with permissions 0600, and the new database is retained for inspection. These are temporary verification artifacts, not a backup retention policy. The runtime is not started against the restored database, and Redis and blob content are not restored. PostgreSQL/S3 consistency and safe resumption of unknown external requests need separate validation.
