# External Authentication Integration Plan

[Contents](README.md) · [Modular Admin](MODULAR_ADMIN.md) · [Decisions](DECISIONS.md)

Status: agreed boundaries implemented locally on 2026-09-20. This document preserves the original plan and EA criteria; exact implemented interfaces are described in the [contract](EXTERNAL_AUTH.md), with evidence and limitations in acceptance results. The “Verified Original Implementation” section describes the state before changes.

## Goal and Agreed Boundaries

Connect UAI to the parent application's authentication without a second registration or a copy of its users. One person may belong to multiple teams. Each team has a shared wallet; separate personal wallets are unnecessary in this integration. Application staff access the shared product and UAI admin through the same identity source.

The parent application chooses its login system. Better Auth is planned for LogoPanel, but UAI neither depends on it nor implements its configuration. The contract is verified using a test application.

| UAI responsibility | Parent application responsibility |
|---|---|
| Server adapter contract for external authentication | Registration, login, sessions, account recovery |
| Accepting verified identity and request financial scope | Users, teams, invitations, membership, and selected team |
| Binding an external team to account and wallet | Checking current membership and project permissions |
| Staff `admin` and `viewer` roles for the shared admin | Assigning these roles to staff |
| Resource isolation and existing service scopes | Team roles: view; view and chat; view, chat, and generation |
| Individual audit attribution | Project permission overrides, including extending a general role |
| Executing an accepted operation and settling with its team | Approvals, participant presence, rounds, notifications |

A team administrator is an ordinary product user. They may manage participants and their product permissions, but this does not grant service-admin access. Each participant sees the team's available balance; the parent backend decides whether a specific action may start.

In LogoPanel, an ordinary AI chat response is permitted to a participant with chat permission and paid for by the team. Creating images, files, and researcher requests requires product generation permission or approval. Choosing the approver and permissions for a request, round, or project belongs entirely to LogoPanel. UAI does not receive `approval`, `round`, or `researcher` entities, or a product `can_generate` flag.

## Verified Original Implementation

- [packages/auth](../packages/auth/src/index.ts) validates the service token, expiry, revocation, scopes, organization/application, and allowed account IDs. The principal currently represents a service rather than a human.
- [Account creation](../apps/api/src/server.ts) already matches `external_account_id` within an application through upsert. The [accounts schema](../migrations/0001_foundation.sql) ensures uniqueness of `application_id + external_account_id`.
- The [architecture](ARCHITECTURE.md) already permits a team as the `account_id` payer. A team is not a UAI `organization_id`.
- [createAdminBackend](../packages/admin-module/src/server/backend.ts) uses a local owner password session and one server admin token. There is no external identity resolver; account/wallet come from configuration.
- The [admin UI](../packages/admin-module/src/admin.tsx) displays password login and performs logout itself. The [page context](../packages/admin-module/src/application.ts) does not yet contain the person or their permissions.
- Administrative and financial commands use `actor_id = service principal ID`. Individual initiators are not distinguished.
- The [SDK](../packages/sdk/src/index.ts) has separate paths for ordinary HTTP requests, file transfer, and SSE; context must pass through all these paths.
- The [API](API.md) description of user sessions with roles is ahead of implementation. Align the specification with actual behavior when implementing this plan.

## Contract and Trust Boundaries

### Identity and Wallet

A person's stable ID belongs to the parent application. Email is not an access key or financial binding. Changing email does not change identity. Identical external user IDs in different applications do not mix: identity is always considered with the application from the verified service token.

The stable team ID is used as `external_account_id`. One UAI account corresponds to one team. A wallet belongs to an account in the existing credit unit. UAI does not store a memberships table; a user's departure from a team does not delete its account, wallet, or financial history.

The parent server verifies membership, then obtains or idempotently creates the team → account/wallet binding. The parent may store the binding. Do not create an account for each HTTP request; repeated creation is a safe way to restore a binding. Provisioning is a separate server action with `accounts:write`, rather than a universal browser command.

The active team is explicitly passed for each user request and checked by the server. Do not store it in a globally mutable SDK instance: parallel tabs and requests may work with different teams. When switching teams, an old operation retains its original payer.

### Server Adapter

Extend the server contract with these responsibilities while preserving library independence:

1. Obtain a verified user from Request through the parent's session. An absent or expired session yields 401; an identity-source error does not grant access.
2. For a user call, check the selected team and product permissions for the action/resource. This is parent code, rather than a universal UAI project-role model.
3. For the shared admin, return a separately assigned staff `admin` or `viewer` role. A team role is not converted into a staff role.
4. Build an immutable context for one server request: external user ID, financial scope for a user call, and staff role only for an administrative call.

Provide explicitly selected `standalone` and `external` modes in `createAdminBackend`. The former preserves local owner login. The latter requires an adapter, needs no local password, and never switches to standalone on external-authentication failure. Separate shared server credentials from local session settings.

Do not treat configured `account_id` and `wallet_id` as proof of access. In a new external administrative build, they may only be an explicitly selected viewing target; access is determined by staff role and service scope. A user call requires financial scope.

### Passing Context to the Separate UAI API

Proposed minimal transport: one versioned service header with a validated schema and size limit. The server SDK creates it on top of existing Bearer authentication. Context contains no email, cookies, passwords, arbitrary roles, or parent secrets.

Provide a separate service-token permission for asserting external identity, provisionally named `identity:assert`. Without it, submitted context is rejected rather than ignored. Organization/application always come from the service token. In user context, account further restricts the request beyond token restrictions. In administrative context, staff role further restricts permitted actions beyond scopes.

Validate context types separately: a user call with an account does not become administrative; an external administrative action requires a staff role. Context cannot grant scopes missing from the service token. Viewer does not become admin because the server token has broad permissions.

The parent backend is the trusted party asserting identity and authority. A header alone does not establish membership. The backend must create it from a verified session and its own data, rather than forwarding an identically named browser header. Operational server-to-server transport uses HTTPS. This integration needs no separate JWT issuer, token exchange, or custom OAuth server.

Ordinary service-only calls from workers, payments, and existing integrations remain supported. Their keys remain privileged server credentials. This plan does not promise protection against a compromised trusted backend holding such a key.

Check order: service authentication → external context validation → scopes and staff role → account and resource ownership → domain command. Access checks are mandatory on idempotent replay too. Replay does not rewrite the operation's original author, payer, or parameters.

### Two Staff Roles

| Shared admin actions | `viewer` | `admin` |
|---|---|---|
| Permitted pages, reports, and safe audit data | Yes | Yes |
| Changing configuration, prices, providers, limits | No | Yes, within service scopes |
| Grants, refunds, credit revocation, and other financial commands | No | Yes, within service scopes and financial rules |
| Start, cancel, retry, resolve incident, paid check | No | Yes, within service scopes |
| Obtaining provider secrets, tokens, and cookies | No | Not added by this plan |

Create one explicit registry of administrative actions and required permissions. Viewer is allowed only explicitly permitted reads; unknown actions are forbidden. Do not determine safety solely from the HTTP method: POST preview and GET with side effects require classification by behavior. A preview that starts external work or changes state is not a read.

Use the registry both in built-in server action checks and UI descriptions. Product extensions must explicitly declare required access; do not automatically grant viewer access to all `reads`. The backend rechecks permissions on each request. The UAI API also checks the asserted administrative context's role, so bypassing UI or BFF does not remove restrictions.

Product roles and staff lists are not copied into UAI. Access to customer project content does not arise from availability of an administrative page; existing content-delivery rules remain. The registry must distinguish a safe administrative-data view from delivery of prompts, files, and other customer materials.

### Individual Audit

Store the service principal and external person separately. New calls need application, external user ID when present, service principal ID, account when present, action, resource, operation link when present, time, and the existing command reason. For a team operation, also store the stable external team ID matching the selected account's `external_account_id`. Obtain it from the verified account binding rather than trusting an independent browser field. Audit context is formed server-side, rather than taken from arbitrary metadata or form fields. Email changes and membership deletion do not alter stored user/team IDs or prevent reading historical attribution.

Do not change historical `actor_id` semantics without a migration decision. Recommended path: preserve previous service attribution and add separate external-initiator fields with a new migration. Old entries retain an unknown human; do not attribute them to the current administrator.

Preserve the initiator when accepting a user operation. Worker/scheduler acts as the system and retains a reference to the original context without impersonating a human. If another employee later cancels an operation or issues a refund, audit reflects that employee without rewriting the launch author.

The payer is fixed on operation acceptance. Background retries, recovery, and late results use the original account/wallet under accepted financial rules. A refund links to the original charge and its team; the refund initiator's currently active team does not determine the recipient. Historical attribution does not depend on the user's continued membership.

UAI does not store LogoPanel approval history. The parent determines the verified initiator of the submitted action; who proposed and who approved a product request is stored in the parent. Do not add special approval fields to the financial core.

### Session Termination and Access Revocation

The external UI uses host-configured login and logout and displays safe user and role information. Logout terminates the session through the parent adapter; merely clearing local React state does not count as logout. Do not accept arbitrary redirect URLs from the browser.

For cookie authentication, preserve CSRF protection for changes, public-origin checks, and JSON. Behind a reverse proxy, origin must be determined from trusted configuration. External authentication does not cancel these checks.

After team removal or staff-role revocation, new actions are forbidden. Long user event streams pass through the parent backend, which rechecks access before delivering further events and closes the stream upon revocation. A stale role copy in the browser does not preserve access. UAI continues checking service-token revocation and the financial scope of its own streams.

Already accepted generations and tasks continue at the original team's expense, including after initiator removal. Continuing accepted work does not authorize new human actions or transfer results to another team. Extending an operation requires a new parent check. Existing cancellation, recovery, and settlement rules remain.

## Implementation Phases

### 1. Define Types and Permission Table

- Describe external request context and its two forms: user with account, and administrative with staff role.
- Describe the server-build adapter interface and safe session response for UI.
- List all built-in administrative actions, classify reads/changes, and define product-extension rules. Align with current service scopes without weakening them.
- Update [API](API.md), [architecture](ARCHITECTURE.md), [modular admin](MODULAR_ADMIN.md), and API schemas. Do not describe unimplemented roles as ready.

Result: one contract independent of Better Auth and LogoPanel entities. Do not create a separate authentication service; use existing auth/contracts and the administrative module's public server export.

### 2. Request Context, SDK, and API Checks

- Extend [auth](../packages/auth/src/index.ts) with trusted-context validation and additional account/staff-role restrictions.
- Pass context through ordinary SDK requests, upload/download, and SSE. Provide an immutable context-bound client or explicit per-request parameter, without a global user switch.
- Check all API paths: operations, quotes, requests, assets, results, wallets, events, financial and administrative commands. A nested resource ID must be checked against its actual owner.
- Keep team-account provisioning as a server operation with separate permissions. Do not give user calls `accounts:write`, `credits:grant`, or admin scopes merely for adapter convenience.
- Check idempotency compatibility: parent keys are unique per logical action; transport retry preserves context, key, and body; another account does not receive a cached replay response.

Result: user calls are constrained to the selected account and original service scopes; individual context does not expand service permissions.

### 3. Audit and Accepted-work Context

- Find every actor persistence point, including accounting, configuration, quotes/operations, and execution. Do not limit this to administrative audit_events.
- Add a new migration for the selected external-identity storage and link to accepted work. Do not edit applied migrations.
- Store necessary attribution in the same transaction as the change. System continuation of an operation preserves the original initiator link.
- Update safe audit projections and SDK schemas; do not expose secrets or session data.

Result: different employees' actions are distinguishable even with one service token. For old data, the human identity honestly remains unknown.

### 4. External Authentication for the Shared Admin

- Extend `createAdminBackend`, `AdminPageContext`, and extension contexts with verified identity and permissions.
- Apply the server permission registry to all built-in and product handlers, including direct endpoint calls.
- Add external login/logout and 401/403/identity-source-unavailable states to `UaiAdmin`. Hide or disable prohibited viewer actions while preserving server rejection.
- Preserve standalone mode explicitly and separately. Update the [create-admin-host](../scripts/create-admin-host.mjs) generator and [template](../templates/product-admin/README.md) with an external-adapter example independent of a specific auth provider.

Result: a parent-application user signs in once; only an employee with an authorized role accesses the service admin.

### 5. Test Integration

Create a local test host with a replaceable identity source, fake provider, and synthetic data. Do not connect Better Auth or create a real LogoPanel. The test source must support changing membership and staff role during a session; it is a fixture rather than a production-registration example.

Data: two teams, a person in both, a person only in the first, a team administrator without a staff role, staff viewer, and staff admin. The shared person has different product permissions in the two teams. The parent's test backend checks them before UAI without passing project-role names into the core.

Result: a verified server-to-server integration example another parent project can reproduce with its own session source.

### 6. Documentation and Acceptance

- Align current implementation descriptions in DECISIONS, API, MODULAR_ADMIN, LOCAL_RUN, and ACCEPTANCE_RESULTS. Preserve existing requirement/acceptance IDs; add new scenarios separately.
- Document trust boundary, provisioning order, access revocation, SSE behavior, audit attribution, and standalone compatibility.
- Perform the next section's checks and record actual results. Do not describe fixture verification as Better Auth integration or production readiness.

## Acceptance Criteria

New `EA-*` identifiers belong to this plan and do not replace existing criteria.

| ID | Check |
|---|---|
| EA-01 | One person works with two teams; parallel requests and tabs do not mix accounts, wallets, or results |
| EA-02 | Repeated and concurrent provisioning of one team returns the same account/wallet; changing email does not create a new account |
| EA-03 | Substituting team/account/wallet/operation/request/asset/quote IDs does not expose other parties' resources, including download and SSE |
| EA-04 | An external-identity header without an authorized service token is rejected; forged browser identity/staff roles do not pass the test backend |
| EA-05 | A team administrator without a staff role cannot enter the service admin, even when their product role is called admin |
| EA-06 | Viewer reads permitted sections; built-in and product changes are forbidden on direct HTTP calls, including unusual methods and unknown actions |
| EA-07 | Staff admin acts only within service scopes; external context does not grant missing permissions or access to another application |
| EA-08 | Two people using a shared service token are distinguishable in audit; user ID, external team ID, account, and operation link survive email changes and membership deletion; old entries receive no invented author; secret/session data is absent |
| EA-09 | Logout, session expiry, membership revocation, and staff-role changes block new calls; a long stream stops delivering data after revocation is checked |
| EA-10 | An accepted task completes and charges the original wallet after initiator removal; team switching, background retries, and late results do not change the payer; refund links to the original charge and team |
| EA-11 | Transport retry and idempotent command replay create no second expense or author change; access is checked before returning a replay result |
| EA-12 | Resolver failure does not enable standalone; CSRF and origin checks work in both modes |
| EA-13 | Built-in forms, product pages, upload/download, and SSE use one correct context; the SDK does not lose it in alternative HTTP paths |
| EA-14 | Existing service-only calls and standalone admin pass regression; financial rules do not change |
| EA-15 | Project role and the generation decision are checked by the test parent; UAI contains no product tables for teams, approvals, rounds, or researchers |

Implementation checks: targeted unit/API/DB tests, migrations on a clean database and on an old-schema snapshot with synthetic data, then typecheck and builds of affected packages. Accounting/execution regression is mandatory when changing operation acceptance or financial-command attribution. Check UI in the browser through Aside on the exact local host: login, viewer/admin, direct links, role revocation, logout, and two teams in different tabs.

Existing repository commands: `pnpm docs:check`, `pnpm check:api`, `pnpm typecheck`, `pnpm build`, targeted `pnpm exec vitest run ...` runs. The new test set is determined during implementation; successful documentation validation alone does not fulfill EA scenarios.

## Release Order and Limitations

First contract and API/SDK with backward compatibility, then audit, administrative backend/UI, and test integration. Enable the new context consistently in the API and calling SDK; do not enable external mode until the API can validate it. A capability/version check at external-host startup is recommended so an old API cannot silently ignore the new header.

Old service tokens do not automatically receive `identity:assert`. Issuing new credentials and enabling external mode are separate deployment actions. Changing the application version does not roll back migrations or financial history.

Scope excludes implementing LogoPanel/Better Auth authentication, production deployment, paid provider calls, payment integration, invitations, a role editor, personal wallets, and an approval system. The plan does not require creating a branch or PR without separate permission.
