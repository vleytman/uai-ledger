# Unified Modular Admin

[Contents](README.md) · [Architecture](ARCHITECTURE.md)

## Purpose and Boundaries

The user-facing frontend of your product is a separate application and build. It does not connect to this administrative shell.

One installation serves one owner-operated application. UAI provides financial accounting, model configuration, and request execution. The product adds its pages, settings, and payment integration. They are built into one interface with one administrative login. Product data does not become part of UAI's data model.

Your product owns its user-facing frontend, authentication and payment integration. The UAI admin packages do not provide those product-specific features.

## Structure

| Path | Responsibility |
|---|---|
| `packages/admin-shell` | Layout, brand, navigation groups, module identifier validation |
| `packages/admin-module` | UAI pages, forms, financial views, administrative API client, and server adapter |
| `packages/ui` | Shared elements and theme |
| `apps/admin/src/application.ts` | Composition of the specific interface: brand and product modules |
| `apps/admin/src/server/backend.ts` | Server composition: registered product handlers |
| `apps/admin/src/routes` | Thin TanStack Start routes |

The shell knows nothing about logos, wallets, or providers. The UAI module does not import the product. The product is connected at build time. Dynamic loading of arbitrary plugins is unsupported.

## Connecting a Product

A client module provides `id`, `label`, and a `pages` array. A page contains `id`, `label`, optional `description`, and a React component. The component receives the previously verified administrative session for display, a refresh counter, and a navigation function. Server actions still require a new session check.

```tsx
import {UaiAdmin, type AdminApplication} from '@uai/admin-module';
import {ProductSettings} from './product/settings';

const application: AdminApplication = {
  brand: {name: 'My application', tagline: 'Administration'},
  modules: [{
    id: 'product',
    label: 'Application',
    pages: [{id: 'settings', label: 'Settings', component: ProductSettings}],
  }],
};

export function Administration() {
  return <UaiAdmin application={application}/>;
}
```

`ProductSettings` in the example belongs to the application rather than UAI. The brand is used in the menu and login. The document title is set by the application's root route. Styles are imported through `@uai/admin-module/styles.css`.

Additional page addresses have the form `#app.product.settings`. Module and page identifiers are validated; duplicates are rejected. Old UAI links, including wallet and operation panel links, are preserved. The refresh button increments `refresh`; a product page uses it in its loading dependencies.

An identifier starts with a lowercase Latin letter and contains up to 64 characters: lowercase Latin letters, digits, and hyphens. A module must have a nonempty `label` and at least one page. Product groups appear before the UAI group. A page's `description` becomes the header description. `navigate` accepts a key such as `app.product.settings`, without `#`.

The page component loads data and handles errors itself; the shell does not automatically call product APIs. React forms, tables, and tabs can be used inside a page. Basic elements are available through `@uai/ui/components/*`, formatting through `@uai/ui/format`. Internal UAI components, including its DataTable and editors, are not exported as public package API. Host styles must scan its pages through Tailwind `@source`; the generator adds `@source "./"` to `apps/admin/src/styles.css`.

## Server and Access

The browser calls `/api/uai-admin`. The standalone build preserves the old `/api` as a compatible address. A new application may keep `/api` for its own routes and connect only `/api/uai-admin`.

`createAdminBackend` accepts `loadConfig`, `reads`, and `commands`, plus `auth` and `permissions` for external sessions. Setup is described in the [external authentication contract](EXTERNAL_AUTH.md). The password-session description below applies to standalone mode. Additional handler names must have the form `app.<module>.<operation>`; they cannot override `grant`, `refund`, or other UAI commands. Client functions `api` and `command` are exported from `@uai/admin-module/client`.

```ts
import {createAdminBackend} from '@uai/admin-module/server';
import {loadAdminConfig, readSettings, saveSettings} from './product/server';

export const handle = createAdminBackend({
  loadConfig: loadAdminConfig,
  reads: {'app.product.settings': readSettings},
  commands: {'app.product.save-settings': saveSettings},
});
```

`loadAdminConfig` returns server-side UAI configuration, including the service token and session secret. It is never imported by the client build. An additional handler receives `account_id` and `wallet_id`; in external mode it also receives verified staff `identity` and `role`. A command additionally receives `key`, `data`, and `id`. The service token is not passed to it. Product secrets reside in its server module.

`account_id` and `wallet_id` identify resources from installation configuration. The logged-in employee's identity is passed separately. A `reads` handler currently receives neither `id`, query parameters, nor the original Request. A product command does not receive top-level `revision`: when resource version control is needed, pass it inside `data` and check it in your transaction. For pagination, filters, dynamic GET resources, and a custom error system, provide separate product server routes with authorization checks. An arbitrary product-handler error in the current shared adapter becomes a generic 503 response; this is not a complete product API framework.

Client read call: `api('app.product.settings')`. Change: `command('app.product.save-settings', data, commandKey, resourceId)`. The UI page and server handler are registered separately; a menu page does not create an endpoint. Menu changes neither grant nor revoke server permissions.

The administrative session is checked before the handler; changes also require Origin, JSON, and a command identifier. The product must validate `data`, implement transactional idempotency by `key`, audit, and rules for changing its resources. A key's presence does not replace idempotency.

Standalone login grants installation-owner permissions. External mode connects the parent's session and staff `admin`/`viewer` roles with individual audit. It does not implement product registration or memberships. A customer-team administrator does not automatically receive staff access. The user frontend remains separate and uses product client APIs. Hiding a menu does not restrict the API. The shared service admin is for employees; ordinary users work through the product frontend.

By default, `loadConfig` reads a JSON file at the path in `UAI_ADMIN_CONFIG`, rather than JSON directly from the variable. Fields: `api_url`, `admin_token`, `account_id`, `wallet_id`, `session_secret`, `login_password`. The session secret must contain at least 32 characters, and the password at least 16; generate separate random values per installation. A session lasts eight hours; its cookie has HttpOnly and SameSite=Strict, plus Secure on HTTPS. In standalone mode this is a separate owner login. Shared login requires explicitly connecting an external adapter; there is no automatic unification with the product. Behind a reverse proxy, preserve the correct public origin for change validation.

## Payments and Settings

The unified interface already provides existing wallet, charge, refund, and pricing pages. They use existing APIs and financial rules. Product settings and the payment screen connect through the same kind of product module.

Moving the interface does not implement payment acceptance. The product's payment adapter validates the webhook signature and external payment identifier, records incoming revenue separately from provider cost and customer charge, then idempotently calls a UAI credit grant. `/api/uai-admin`, protected by an administrative session, is not a payment-provider webhook endpoint.

## Migration and Deployment

UAI is connected from the shared Git repository as the `vendor/uai` submodule, rather than copied or forked per product. The parent project's commit reference pins the version. Source workspace packages are connected to the product's administrative build; the user frontend does not depend on them. Packages are not yet published to npm.

The product workspace includes `apps/*`, `vendor/uai`, and `vendor/uai/packages/*`. The UAI root package is needed for current internal server-module dependencies. `vendor/uai/apps/*` is excluded from the product's administrative build: standalone UAI admin and demo must not become a second product frontend. UAI services use the same pinned commit separately.

The generator creates only administrative-build files, does not copy UAI, credentials, or data, and refuses to overwrite existing files:

```sh
node scripts/create-admin-host.mjs /path/to/new-product-admin "Product name"
```

The build includes provider icons and source information in `apps/admin/public/providers`: the module accesses `/providers/…`. This is a static snapshot at generation time. On subsequent UAI updates, compare this directory with `vendor/uai/apps/admin/public/providers`; automatically updating the submodule does not replace host files. The standalone admin's personal favicon and manifest are not copied: the host defines product branding and public resources.

Next, connect `https://github.com/vleytman/uai-ledger.git` in the product's Git repository using the generated README instructions. The generator does not create a repository, branch, submodule, or PR. For an existing project, generate the template separately and merge the required settings into its workspace; the user frontend is not replaced.

### Shared Changes and Updates

1. Make a shared fix in the original UAI repository and run its tests.
2. Once published, the commit becomes available to all products.
3. In each product, update only the `vendor/uai` reference and, if necessary, its lockfile. Product pages and settings remain in its own code.
4. Verify the administrative build and product tests; review UAI migrations separately before deployment.

The template includes Dependabot configuration for weekly submodule-update PRs and build-check CI. Automatic merge and production deployment are disabled. Private UAI requires read access for Dependabot and CI; the generator does not configure this. Dependabot updates the submodule commit but does not recalculate pnpm-lock: if dependencies change, update the lockfile in the same PR. CI with `--frozen-lockfile` detects divergence.

This does not promise delivery of SemVer releases only: `gitsubmodule` tracks a Git branch. For a release policy, keep the tracked branch verified or select a tag/commit manually. Restoring an old commit does not roll back database migrations. [Dependabot submodule support](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories).

Another project must reference a published commit containing the packages and generator from these instructions. A documentation commit without implementation is insufficient.

Do not migrate `.data`, passwords, keys, or databases from an existing installation. A new installation receives its own secrets, database, Redis namespace, and application configuration.

API, workers and data services may be deployed separately. A shared admin interface does not require them to run in one process; see [deployment](DEPLOYMENT.md).

To run the administrative build locally from the product root: `UAI_ADMIN_CONFIG=/absolute/path/to/admin-config.json pnpm dev:admin`. The template uses `127.0.0.1:4311`; if standalone UAI admin already occupies this port, stop it or choose another port in the host script. UAI API, workers, and scheduler run separately according to [local run instructions](LOCAL_RUN.md). A new installation requires its own database, Redis namespace, credentials, and S3; do not copy the active demo's environment. Production deployment instructions are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Verification

- `pnpm --filter @uai/admin typecheck`
- `pnpm --filter @uai/admin build`
- `pnpm exec vitest run apps/admin/test packages/admin-module/src/components/configuration-labels.test.ts`
- `pnpm exec vitest run packages/admin-shell/test/scaffold.test.ts`

For a freshly generated product, run `pnpm install`, then `pnpm build`, then `pnpm typecheck`: the build generates the TanStack route file. Once the lockfile is committed, use `pnpm install --frozen-lockfile`. These commands verify administrative-build compatibility, but do not start UAI services or apply migrations.
