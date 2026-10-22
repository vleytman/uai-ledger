# Test parent host

Run from the repository root: `UAI_ENV=test DATABASE_URL=<local-test-database> pnpm exec tsx scripts/run-external-auth-fixture.ts`. The connection role must have `CREATEDB`. The script creates a separate database, applies migrations and removes it on SIGINT/SIGTERM. Never use production credentials.

The host is available only at `http://127.0.0.1:4327`, with the shared admin interface at `/admin`. The server token and test sessions remain in memory. Real providers are forcibly disabled. This is a synthetic identity source, without Better Auth, registration or production authentication.

Alice belongs to Alpha and Beta; Bob and team-admin belong only to Alpha. Team-admin is not a staff member. Viewer and admin have staff roles. Each tab stores its selected team independently; balances are requested through server-side membership validation and the SDK with request-specific context. Balance values are synthetic.

Test mutation buttons remove Alice's Alpha membership, downgrade the admin role, revoke the current session and restore roles and memberships. They are available only in this test host. The event stream validates the session and membership before every event and every 500 ms while idle. After revocation, it closes the underlying SDK stream. The parent page displays stream status.

Product roles exist only in the test parent. `view`, `chat` and `generate` are cumulative. Alice has `chat` in Alpha and `generate` in Beta; Bob has only `view` in Alpha. Team-admin has `generate` in Alpha, without a staff role. `/fixture/product-action` checks current membership and the server-side role before calling the SDK, ignoring roles supplied by the browser. The chat and generation test buttons perform only a synthetic admission check and a wallet read: they neither invoke a model nor simulate a paid generation. Only standard user identity is passed to UAI, without product role names.
