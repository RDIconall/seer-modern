# Task 8 report — Settings and canonical v2 account cutover

Status: implemented. No live production migration or provider token refresh was run.

Final implementation commit before this report: `90c2500`.

## Delivered

- OAuth sign-in and refresh now upsert `seer.users`, `seer.mail_accounts`, and encrypted `seer.oauth_credentials` atomically.
- Expiry inputs accept OAuth seconds or application milliseconds and persist as PostgreSQL timestamps.
- Refreshes retain an existing refresh credential when a provider omits `refresh_token`.
- V3 account API returns account metadata only. It scopes list, switch, and destructive remove operations to the authenticated relational user.
- Removal requires `confirmed: true`, revokes the Google grant when possible, and cascades relational credentials.
- V3 Settings now supports current account, add/connect, reconnect, remove, switch, and sign out.
- Mail session resolution uses relational accounts and credentials first. Legacy KV resolution is opt-in through `SEER_V3_LEGACY_ACCOUNT_FALLBACK=1` and is read-only for session fallback.
- NextAuth never exposes provider access tokens to the browser; legacy fallback reads sealed server-side records only.
- Added safe-by-default `scripts/migrate-v3-accounts.mts`; it only writes with `--apply` and never deletes legacy records.

## Verification

- `npx tsx scripts/v3-accounts.test.mts` — pass
- `npm run test:v3` — all V3 tests pass, including `v3-accounts`
- `npm run test:v2` — all V2 tests pass
- `npm test` — all baseline tests pass
- `npx tsc --noEmit` — pass
- Targeted ESLint — pass
- `npm run build` — pass

## Concerns and follow-up

- The migration script was intentionally not executed against production because this task forbids live-data mutation. Task 9 must run it, verify token refresh for each provider, and then remove the fallback flag and legacy account paths.
- The NextAuth server JWT still needs provider credentials internally for its refresh callback; browser session exposure is gated off after cutover.
- Microsoft grant revocation remains best-effort/unsupported by the existing provider integration; reconnect requests fresh consent.
- The pre-existing non-V3 `/api/accounts` and legacy cron paths remain available only when their legacy account fallback is explicitly enabled. They should be retired with the fallback in Task 9.

## Security review remediation

The follow-up review findings are addressed:

- Legacy fallback is owner-scoped by authenticated email, never selects a global first token, and legacy switch/remove/upsert mutations are disabled.
- V2 active-account resolution applies the httpOnly active-account cookie only after owner-scoped relational listing; invalid or foreign IDs fall back to the signed-in mailbox.
- Migration now uses `listAccountsWithTokens()` from the legacy module, which opens sealed records; it no longer reads raw KV.
- Active removal clears credentials and the active cookie, returns `requiresSignOut: true`, and Settings invokes authenticated sign-out. Provider revocation is best effort, with Microsoft's limitation retained and local deletion unconditional.
- V3 account mutation POSTs reject missing or cross-origin `Origin` headers in production. Same-origin and cross-origin cases are covered by regression tests.

Security-remediation commit: `d469f5a` (final branch hash is recorded after this report commit).
