# File configuration

[Contents](README.md) · [Local Run](LOCAL_RUN.md)

This guide explains how to manage model definitions, pricing, routes, recipes and API services in Git while keeping connections, secrets and operational limits in the installation database.

## Data Ownership

| Source | Data |
|---|---|
| JSON in Git | Profile identifiers, parameters, calculation components, markup, safety factor, pricing examples, rates, route and recipe definitions. |
| TypeScript | Versioned adapters, provider authentication, HTTP protocol, usage and error normalization. |
| Operational database | Connections and secrets, budgets, quotas, notifications, installation bindings, active publication. |

Example: [openai-nano.json](../configurations/ai/openai-nano.json). Adapt the model parameters, rates and bindings for your installation; recheck provider prices and model availability before publication.

The [JSON Schema](../configurations/schema.json) defines the format version, allowed resource kinds, fields, and references. Existing UAI domain validators additionally check nested calculation methods, rates, and recipes. Check that the schema is current with `pnpm check:configuration`; update it after format changes with `pnpm generate:configuration`. These are data for the existing calculation engine. JSON cannot connect arbitrary code, an HTTP endpoint address, a secret, or a new workflow.

References within the bundle: `@rate_card:key`, `@catalog:key`, `@route:key`. Installation references: `@connection:primary`, `@budget:period`. They are resolved only in designated fields. The publisher does not replace strings inside user text or formulas.

Example of a separate installation binding file, which must not be added to Git:

```json
{
  "connections": {"primary": "conn_example"},
  "budgets": {"period": "provider-month"}
}
```

These are identifiers, not API keys. A connection must belong to the same installation and match the model's provider. Funds, credentials, and enabled status are checked by normal admission when work is accepted. The publisher does not create or reconfigure these operational resources.

## Validation, Publication, and Activation

First apply migrations to the selected local database with `pnpm db:migrate`. The commands below read `DATABASE_URL` from the environment; replace `org_example` and `app_example` with existing identifiers.

```sh
pnpm configuration validate --file configurations/ai/openai-nano.json --bindings .data/bindings.json --organization org_example --application app_example
pnpm configuration preview --file configurations/ai/openai-nano.json --bindings .data/bindings.json --organization org_example --application app_example
pnpm configuration publish --file configurations/ai/openai-nano.json --bindings .data/bindings.json --organization org_example --application app_example --actor owner
pnpm configuration status --organization org_example --application app_example
pnpm configuration activate --release release_example --revision 0 --organization org_example --application app_example --actor owner
```

`validate` and `preview` require the target database: they perform real publication checks in a savepoint and roll back all changes. Preview shows paths and changed values relative to the latest publication, including bindings. These commands do not activate versions or call providers.

`publish` stores the entire bundle in one transaction. Normalized content and bindings form a digest. Repeated and concurrent publication of the same bundle returns the existing release without creating versions. A changed binding creates a new version. All references resolve to immutable database version IDs.

Publication from a dirty working tree is prohibited by default. The explicit `--allow-dirty` flag is available for local verification. History records Git HEAD, whether the file differs from HEAD, SHA-256 of the bytes read, relative path, schema version, publisher, release, and published dependencies. Repeating the same content preserves the first publication's provenance. The file must reside inside the current Git repository, including checking the real symlink path.

`activate` separately switches the entire bundle. `--revision 0` means there was no previous activation; subsequent values come from `status`. A revision conflict rejects an outdated switch. Repeating the same command is safe. An old release can be reactivated with the current revision. Switch history is stored separately.

Inactive file versions are available to administrators but excluded from public discovery and new quote selection, even when an explicit recipe number is supplied. An existing quote and accepted operation use stored references, parameters, formula, and adapter version. Changing a Git file alone does not affect execution.

Provider cost uses the currently active rate; customer charging preserves the existing comparison policy against the accepted rate. Stored markup comes from the accepted operation. A new inactive publication does not change the current rate. This preserves the separation between provider cost and customer charge, including existing `outcome_unknown` rules.

The TS adapter registry contains the existing `openai@1`, `anthropic@1`, `cartesia@1`, and `serper@1`. A file model specifies its version explicitly; the quote carries it into the stored route, and runtime selects the implementation by that version. An unknown version is not automatically replaced with another. Adapter behavior changes must receive a new version; the old implementation is retained while unfinished work references it. This mechanism does not prevent arbitrary code replacement under the same ID.

## Administrative Interface

On Models, Pricing, Routes, and Recipes pages, file records are marked `Git · Active` or `Git · Inactive`. An active old version remains visible when a new one is published. The card provides source, Git revision, hash, author, dependencies, and the standard visual representation of the model, calculation, rates, or recipe.

Editing, renaming, and creating a new version of a file record through the UI are disabled. Old HTTP paths also return `file_managed_configuration`; SQL triggers protect the source and published records. Creating a version with the same key through a legacy path cannot be bypassed using a new version number. The read-only calculator allows changing trial inputs and calculating prices without modifying the definition or calling the model.

Connections, budgets, quotas, and notifications remain operational settings. Publication does not overwrite them. Use the CLI to activate releases; the admin interface does not provide a publication editor.

## Migrating Existing Profiles

`configuration export --file <repo-file.json> --bindings <local-bindings.json> --baseline <local-baseline.json> --bundle <key> --organization <id> --application <id>` reads definitions without changing the database. Output files are created only if files with those names do not already exist. `scripts/export-local-configuration.ts` is a limited wrapper for the local demo; it does not read credentials.

`configuration adopt --file <repo-file.json> --bindings <local-bindings.json> --baseline <local-baseline.json> --reason <reason> --organization <id> --application <id> --actor <id>` checks IDs/hashes of the latest legacy versions, transfers keys to a single file owner, and publishes a release in one transaction. A changed baseline requires another export. Activation uses the separate `activate` command; publication does not change operational limits or credentials. Original versions are preserved. After adoption, they cannot be edited or renamed through legacy API/SQL. Returning to DB-managed editing is not supported; rolling back an operational profile requires publication/activation of a verified file definition.

## Universal Execution Policies

The execution_policy resource stores the complete execution schema. Example: [default](../configurations/execution/default.json). It uses the same validate/preview/publish/activate path; a separate policy bundle does not require a recipe. An active policy with key=default sets the application default. A route may reference execution_policy_version_id through the @execution_policy:key symbol inside the bundle and partially override execution. Accepted requests store the final terms and version ID. Operational max_attempts and max_deadline_seconds live in invocation_execution_limits, rather than an independent file policy editor.

## Additional model examples

See [model capabilities](MODEL_CAPABILITIES.md) for embeddings, structured responses, SVG support, limits and example configurations. Publish compatible profiles and configure connection budgets before making real calls.

## GPT-6 Luna

A separate [openai-luna6.json](../configurations/ai/openai-luna6.json) bundle adds `gpt-6-luna` with reasoning, Standard rates, caching, and actual charging. Profile parameters and limits are defined in this JSON file.
