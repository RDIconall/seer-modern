# V3 final-review fix report

Status: implemented. No live production migration, password change, or provider
mutation was performed in this fix. The final re-review follow-up is committed
and pushed on the feature branch.

## Fixes delivered

1. Added `seer_app LOGIN NOINHERIT` enforcement and production URL validation.
   Both the v2 and legacy KV Postgres pools require `SEER_V2_DATABASE_URL` and
   accept only `seer_app` or `seer_app.<project>` usernames in production.
   `public.seer_kv` is probe-only in production unless `SEER_KV_SETUP=1`;
   development/test provisioning remains available. The migration does not set
   a password: operators must provision it separately and store the matching
   URL in `SEER_V2_DATABASE_URL`.
2. Added durable UUID folder snapshot generations and `folder_sync_seen`.
   Bounded ticks retain generation/cursor/start state; completion locks and
   verifies the current generation before removing stale membership. Overlapping
   snapshots cannot delete newer membership, and stale cleanup respects active,
   reconcile-needed, and recent-done optimistic outbox masks.
3. Provider HTTP retries are limited to GET/HEAD. Send/reply/forward POSTs are
   single-attempt, including network and 5xx failures. Deadlines now cover
   fetch, body consumption, JSON parsing, retry sleep, and retry headroom.
4. Outbox claims exclude newer commands while an older same-conversation
   command is pending/inflight using `created_at,id` ordering. Inflight
   operations heartbeat their lease; stale reclaim remains covered.
5. `SyncContext` carries deadline/abort state through adapters and HTTP.
   Outlook full-thread hydration checks before each page and propagates
   deadline cancellation; the engine leaves the cursor unchanged on an
   interrupted page.
6. Queueable mutations no longer resolve a provider or refresh a token.
   Outbound commands resolve the provider only when needed and fail visibly if
   unavailable.
7. Command and undo POST routes use the same production Origin validation as
   account mutations.
8. The accounts API enforces the V3 allowlist. Mailbox, brain, body, reader,
   and search-adjacent client state is cleared on account changes; mailbox and
   body cache keys include the active account id. Atlas/Triage ignores
   archive-only and trash-only conversations.
9. Decision writes verify conversation and matter ownership, account-qualify
   current-decision and metadata joins, and reject cross-account corrections
   before writing events.
10. Per-conversation savepoints allow malformed rows to fail without aborting
    the surrounding page transaction. Provider visibility is retained for
    snapshot reconciliation even when hydration fails.
11. Reader command completion reloads the mailbox and clears the selected
    conversation. Reader delete remains unavailable without a signed safety
    token.
12. OAuth credential rows now track `active|reconnect_required` and a bounded
    `last_error`. Refresh failures mark only that account for reconnect;
    successful save/refresh clears the health error. The account API exposes
    status metadata only, and Settings identifies accounts needing reconnect.
13. The inbox brain now scopes yields through the current, non-deleted inbox
    conversation projection. Provider tombstones consult the same outbox
    `SyncMask` as snapshot cleanup, preserving optimistic restore/archive
    membership while commands are active or converging.
14. Search requests now share account-generation/query-token guards and
    `AbortController` cancellation. Account changes abort pending work, and
    stale responses cannot update the visible search results. Provider JSON
    parsing also performs a final deadline check.

## Migration inventory and operator provisioning

Apply these migrations in filename order before deploying the application:

1. `20260810022424_seer_v2_core.sql`
2. `20260811030000_seer_v2_functions.sql`
3. `20260811190000_v3_folders_outbox.sql`
4. `20260811220000_sync_runs_folder_complete.sql`
5. `20260811230000_folder_sync_backfill_complete.sql`
6. `20260811234500_v3_final_review.sql`
7. `20260811235000_v3_final_review_followups.sql`

The follow-up migration upgrades already-applied numeric snapshot generations
to UUIDs and adds OAuth health columns. `seer_app` is created without a
password by design. An operator must set its password/secret through the
deployment's database administration path, then configure the URL as
`SEER_V2_DATABASE_URL=postgres://seer_app:<password>@...` (or the Supabase
pooler form `seer_app.<project>`). No live mutation was run here.

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
- `b05b5f7` — remaining final-review invariants
- `db0b518` — security and provider deadline regression gates
- `92a4049` — UUID snapshot legacy cursor compatibility
- `56c2a8b` — credential health schema gate
- `34276f1` — snapshot generation test contract
- `e6c410c` — production KV probe-only gate
- `4cbe085` — final re-review projection, tombstone-mask, and search-race fixes

## Verification

All commands below passed:

- `npm test`
- `npm run test:v2`
- `npm run test:v3`
- `npx tsx scripts/v3-production-security.test.mts`
- `npx tsx scripts/v2-provider-contract.test.mts`
- `npx tsx scripts/v2-provider-contract.test.mts`
- `npx tsx scripts/v2-provider-outlook.test.mts`
- `npx tsx scripts/v3-production-security.test.mts`
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

The final `npm run test:v2 && npm run test:v3` run passed after the migration
rename and documentation updates. `npm test`, `npm run lint`, `npx tsc --noEmit`,
and `npm run build` also passed.

The final re-review targeted regressions also passed:

- `npx tsx scripts/v2-inbox-view.test.mts`
- `npx tsx scripts/v3-outbox-sync-mask.test.mts`
- `npx tsx scripts/v3-search.test.mts`

## Remaining concerns

- The secondary Google account is intentionally still unhealthy until the user
  completes Settings reconnect; no Google-health claim should be made.
- The migration and commits are present locally and were not pushed. Hosted
  Supabase advisor output was not generated in this workspace; the embedded
  security gate covers the same role/grant/RLS shape, including actual
  `anon`/`authenticated` denial and `seer_app` DML.
