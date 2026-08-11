# V3 final-review fix report

Status: complete. No known Critical or Important final-review findings remain.
The branch was committed but intentionally not pushed, per the request.

## Fixes delivered

1. Added `20260811234500_v3_final_review.sql`. It creates/guards
   `seer_app`, grants DML and default privileges, enables RLS, and adds explicit
   `seer_app` policies for every existing core and V3 table plus `public.seer_kv`.
   `anon` and `authenticated` are explicitly revoked. The test harness now
   creates those roles before applying migrations, verifies denial on every
   table, and exercises actual `seer_app` corpus/KV DML.
2. Added durable folder snapshot generations and `folder_sync_seen`. Bounded
   ticks retain generation/cursor/start state; completion removes stale
   provider membership atomically. Head polls only add/update. Inbox snapshots
   recur every 15 minutes; Sent/Trash snapshots recur every six hours.
3. Provider HTTP retries are limited to GET/HEAD. Send/reply/forward POSTs are
   single-attempt, including network and 5xx failures.
4. Outbox claims exclude newer commands while an older same-conversation
   command is pending/inflight. Inflight operations heartbeat their lease;
   stale reclaim remains covered.
5. `SyncContext` carries deadline/abort state through adapters and HTTP.
   Outlook full-thread hydration checks before each page and propagates
   deadline cancellation; the engine leaves the cursor unchanged on an
   interrupted page.
6. Queueable mutations no longer resolve a provider or refresh a token.
   Outbound commands resolve the provider only when needed and fail visibly if
   unavailable.
7. Command and undo POST routes use the same production Origin validation as
   account mutations.
8. The accounts API enforces the V3 allowlist. Mailbox, body, reader, and
   search-adjacent client state is cleared on account changes; mailbox and body
   cache keys include the active account id.
9. Decision writes verify conversation and matter ownership, account-qualify
   current-decision and metadata joins, and reject cross-account corrections
   before writing events.
10. Per-conversation savepoints allow malformed rows to fail without aborting
    the surrounding page transaction. Provider visibility is retained for
    snapshot reconciliation even when hydration fails.
11. Reader command completion reloads the mailbox and clears the selected
    conversation. Reader delete remains unavailable without a signed safety
    token.
12. Task 8/9 reports and product docs record the live provider state:
    Outlook verification succeeded; the secondary Google refresh token is
    revoked and Settings requires reconnect. Google is not reported healthy.

## Commits

- `43b2ea6` — reconcile provider snapshots and harden schema
- `e0c4d83` — focused regression tests and provider deadline/import fixes
- `8e0bae3` — security, account, ownership, outbox, and reader fixes
- `02a1fe9` — account-scoped cache contract adjustment
- `26a0461` — head-poll reconciliation expectation
- `aa69ddd` — account-scoped reader cache requests
- `e055093` — reconciliation and live provider status documentation
- `465a1f6` — executable least-privilege schema coverage
- `a9cc90e` — Outlook deadline propagation
- `522fabf` — test lint cleanup

## Verification

All commands below passed:

- `npm test`
- `npm run test:v2`
- `npm run test:v3`
- `npx tsx scripts/v2-provider-contract.test.mts`
- `npx tsx scripts/v2-provider-outlook.test.mts`
- `npx tsx scripts/v3-schema.test.mts`
- `npx tsx scripts/v3-sync-backfill.test.mts`
- `npx tsx scripts/v3-sync-folders.test.mts`
- `npx tsx scripts/v3-outbox-drain.test.mts`
- `npx tsx scripts/v3-command-outbox.test.mts`
- `npx tsx scripts/v3-accounts.test.mts`
- `npx tsx scripts/v3-reader-api.test.mts`
- `npx tsx scripts/v3-mailbox-view.test.mts`
- `npx tsx scripts/v3-mailbox-state.test.mts`
- `npx tsx scripts/v2-commands.test.mts`
- `npx tsx scripts/v2-decision.test.mts`
- `npm run lint`
- `npx tsc --noEmit`
- `npm run build`

## Remaining concerns

- The secondary Google account is intentionally still unhealthy until the user
  completes Settings reconnect; no Google-health claim should be made.
- The migration and commits are present locally and were not pushed. Hosted
  Supabase advisor output was not generated in this workspace; the embedded
  security gate covers the same role/grant/RLS shape, including actual
  `anon`/`authenticated` denial and `seer_app` DML.
