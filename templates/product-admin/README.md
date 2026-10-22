# Product admin build

Use this template to build one admin interface with UAI pages alongside your product's pages. Deploy the customer-facing frontend separately, without importing the admin module or its credentials.

## Integration

Add the shared source repository to the product's Git repository:

```sh
git submodule add https://github.com/vleytman/uai-ledger.git vendor/uai
```

Choose a published UAI commit or tag that you have verified, then commit the gitlink in your product repository. That commit must contain the packages you need; a documentation-only change isn't enough. Check the selected version before using it in production.

```sh
pnpm install
pnpm build
pnpm typecheck
```

Commit the generated `pnpm-lock.yaml`. CI uses only `--frozen-lockfile`. When another developer clones the project:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
```

Branding and client module settings live in `apps/admin/src/application.ts`. Product settings and payment handlers live in `apps/admin/src/server/backend.ts`. The main examples and contract are in `vendor/uai/docs/MODULAR_ADMIN.md`.

Supply secrets through the server-side `UAI_ADMIN_CONFIG` or your own `loadConfig`. Use this installation's credentials, not a copy from another installation. Run the UAI API, worker, and scheduler separately from the same pinned UAI commit; the admin build doesn't start them. `/api/uai-admin` serves admin requests, while your customer frontend and payment webhooks use their own APIs.

`UAI_ADMIN_CONFIG` contains an absolute path to a JSON file, not the JSON itself. Its fields and requirements are listed in `vendor/uai/docs/MODULAR_ADMIN.md`. After starting the separate UAI API, run the interface from the product root:

```sh
UAI_ADMIN_CONFIG=/absolute/path/to/admin-config.json pnpm dev:admin
```

The default interface address is `http://127.0.0.1:4311`. The port must not be occupied by the standalone UAI admin interface. The current login is for the installation owner; existing product roles and user authentication are not connected automatically.

The generator copies provider icons and source notices into `apps/admin/public/providers`. Preserve this directory when transferring the template manually: the module uses `/providers/…` URLs. These static files are a snapshot from generation time; compare them with `vendor/uai/apps/admin/public/providers` when updating UAI. The generator is not intended to be rerun over an existing project.

## Shared updates

UAI is edited in its source repository rather than copied into the product. Product-specific changes stay outside `vendor/uai`. If a fix is made in the submodule, publish it to the UAI repository first; other developers cannot access a parent-project reference to an unpublished commit.

Dependabot is configured to open weekly PRs with a new submodule commit. These are Git branch updates, not filtering by SemVer tags. Configure private-repository access separately for Dependabot and CI checkout. Automatic merging and deployment are disabled.

When a UAI update changes dependencies, run `pnpm install` and include the lockfile in the same PR. Dependabot updates the Git submodule reference, not pnpm-lock. A stale lockfile should fail the build.

Before adopting an update, build the admin interface, run your product tests, and check API compatibility. Back up the database before running migrations separately in the required order. Checking out an older commit cannot undo an applied migration.

In an existing monorepo, transfer only the required parts of this build and merge workspace/CI configuration manually. Do not replace working manifests, lockfiles or the frontend with the template.

For a manual update, select a verified commit or tag:

```sh
git -C vendor/uai fetch origin --tags
git -C vendor/uai checkout --detach <approved-ref>
pnpm install
pnpm build
pnpm typecheck
```

Then include the `vendor/uai` gitlink and lockfile in the product change. The submodule worktree must be clean before checkout; do not forcibly reset local changes.

## External login

The generator adds `src/server/external-auth.example.ts` with the adapter contract. This is an unfinished example, not a Better Auth integration. Implement `authenticate(Request)` using the parent's verified server-side session and return `{version:1,kind:'staff',user_id,role:'admin'|'viewer'}` or `null`. Check the current role on every call. Being a team administrator does not itself grant staff access. `logout(Request)` must end the parent session and return a `Response` with the necessary `Set-Cookie` headers.

Pass `auth:externalAuth` to `createAdminBackend`. Specify the exact public origin and a login path on that same origin. External mode does not require a standalone password or session secret; server-side API credentials remain mandatory. The API must expose `capabilities.external_identity:1` through `/health`, and the service token must have `identity:assert` along with the required scopes. An adapter error or an old API denies access.

Product handlers are available only to `admin` by default. Explicitly declare `permissions.reads` for reads, for example `{'app.product.settings':['admin','viewer']}`. Viewer cannot execute commands. The handler context contains safe `identity` and `role` values, and the session UI contains the permitted `capabilities.readViews` and `capabilities.actions`. Do not pass the API token or authentication provider session to the browser.
