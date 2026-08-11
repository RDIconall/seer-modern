# Task 9 sync report — bounded fair multi-folder sync

Status: implemented. Not pushed.

Commit: `0fd3948` on branch `cursor/bounded-fair-sync-92d3`.

## Problem

Production Outlook Sent has ~25,140 messages. `/api/v2/sync?mode=full` spent 300s draining inbox, then ~850 sent messages, timed out, and never reached trash. `syncFolder` looped until cursor null and `syncAccountFolders` ran folders sequentially, so a large Sent backlog starved Trash.

## Delivered

### `syncFolder` bounds (`src/lib/v2/sync/engine.ts`)

- Accepts optional `{ maxPages?, deadlineMs? }`; defaults omit both for full drain (existing tests unchanged).
- Stops before starting a page when `maxPages` reached or `Date.now() + SYNC_PAGE_SAFETY_HEADROOM_MS (15s) >= deadlineMs`.
- Persists cursor after every page (unchanged atomic write path).
- Returns `{ complete, nextCursor, pages, coverage, ... }`.
- `mode=full` resets cursor to null only at invocation start; incremental ticks resume stored cursors.

### Fair folder budgeting (`src/lib/v2/sync/report.ts`)

- `syncAccountFolders(..., budget?)` passes `maxPages: pagesPerFolder` and shared `deadlineMs` to each folder sequentially.
- `defaultSyncBudget()` — 2 pages per folder, 250s deadline from tick start.
- Report entries include `folder`, `pages`, `complete`, `nextCursor`, `providerTotal`, `stored`, `pending`, `failed`.
- Omitting `budget` (direct test callers) retains full drain per folder.

### Route (`src/app/api/v2/sync/route.ts`)

- Production and `mode=full` both use `defaultSyncBudget(tickStarted)` so every 5-minute cron tick advances inbox, sent, and trash.
- Incremental cron is the steady-state path; partial cursors survive between ticks.

### Observability

- Migration `20260811220000_sync_runs_folder_complete.sql` adds nullable `folder` and `complete` to `seer.sync_runs`.
- JSON cron report carries the same fields for immediate visibility without waiting on migration apply.

## Verification

| Command | Result |
|---------|--------|
| `npx tsx scripts/v3-bounded-sync.test.mts` | pass |
| `npm run test:v2` | pass |
| `npm run test:v3` | pass |
| `npx tsc --noEmit` | pass |
| `npm run build` | pass |

## Final follow-up verification

After the UUID snapshot, production role/URL, KV probe-only, provider deadline,
brain projection, account switch, outbox ordering, and OAuth health changes:

| Command | Result |
|---------|--------|
| `npm test` | pass |
| `npm run test:v2` | pass |
| `npm run test:v3` | pass |
| `npm run lint` | pass |
| `npx tsc --noEmit` | pass |
| `npm run build` | pass |

No live migration, password provisioning, or provider token mutation was
performed in this workspace.

### Regression coverage (`scripts/v3-bounded-sync.test.mts`)

- Huge sent (120) + trash (40): one tick processes 2 sent pages **and** 2 trash pages.
- Second incremental tick resumes sent from exact stored cursor; no duplicate `provider_conversation_id` rows.
- Deadline inside 15s headroom stops with 0 pages started.
- Small inbox (7 convos) fully drains when `syncFolder` called without bounds.
- `mode=full` with `maxPages: 1` resets once; next incremental continues from cursor `"10"` → `"20"`, not null.

## Production impact estimate

With Outlook page size ~30 and 2 pages/folder/tick:

- ~60 sent + ~60 trash + inbox progress every 5 minutes.
- Sent backlog (~25k) clears in ~350 ticks (~29 hours) if inbox stays small; inbox also gets 2 pages/tick so active inboxes stay current.
- Trash is never starved by Sent.

Tune `DEFAULT_PAGES_PER_FOLDER` or deadline if provider latency profile differs.

## Concerns and follow-up

- **Migration apply**: `20260811220000_sync_runs_folder_complete.sql` must run on Supabase before deploy; inserts already target new columns — deploy without migration will fail on `sync_runs` insert.
- **Multi-account ticks**: deadline is shared across accounts in one route invocation; many accounts may need per-account deadline subtraction (outbox drain time not yet deducted from budget).
- **`mode=full` manual trigger**: still bounded per tick; operators must run multiple full ticks or temporarily raise `pagesPerFolder` for faster one-shot rebuilds.
- **Outbox time**: `defaultSyncBudget` uses fixed 250s from tick start; heavy outbox drain could compress sync window — consider `deadlineMs: tickStarted + 250_000 - (Date.now() - tickStarted)` per account if observed in prod.

---

## Remediation (backfill state + round-robin fairness)

Status: implemented. Not pushed.

Commit: `68b365c` on branch `cursor/triage-atlas-janitor-spec-889f` (prior: `5c8c2e4`).

### Root cause

Provider cursors are **page offsets**, not incremental history tokens. After a completed drain (`cursor=null`), every incremental cron restarted page 1 and re-drained the entire folder.

### Delivered

#### Backfill state machine (`folder_sync_state.backfill_complete`)

Migration `20260811230000_folder_sync_backfill_complete.sql`:

- `backfill_complete boolean not null default false`
- Existing `cursor=null` + `provider_total>0` rows upgraded to `backfill_complete=true`

Engine behavior:

| State | Incremental | Full |
|-------|-------------|------|
| `backfill_complete=false`, cursor set | Resume backfill from cursor | Resume (no reset) |
| `backfill_complete=false`, cursor null | Start page 1 | Start page 1 |
| `backfill_complete=true` | Head-poll page 1 only; ignore `nextCursor`; keep `cursor=null` | Reset once to `backfill_complete=false`, `cursor=null` |
| Provider returns `nextCursor=null` during backfill | Set `backfill_complete=true`, `cursor=null` | same |

`complete` is evidence-based: `true` only when backfill finished this run (`nextCursor=null`) or head poll ran; `false` for partial backfill, deadline before first page, or maxPages cap.

Reports include `backfillComplete`, `polledHead`, `pages`, `nextCursor`, `telemetryWarning`.

#### Round-robin multi-account fairness

`syncTickRoundRobin()` — 2 rounds × rotated accounts × rotated folders, `maxPages=1` per slice, shared deadline. Route drains outbox per account, builds providers, then runs round-robin (not sequential per-account folder drain). Rotation slot: `floor(tickMs / 300_000)`.

#### Migration-safe `sync_runs` telemetry

`recordSyncRun()` in `src/lib/v2/sync/sync-runs.ts` — tries insert with `folder`/`complete`; on undefined column falls back to legacy insert; never throws; returns warning string on failure.

### Verification

| Command | Result |
|---------|--------|
| `npx tsx scripts/v3-sync-backfill.test.mts` | pass |
| `npx tsx scripts/v3-sync-fairness.test.mts` | pass |
| `npx tsx scripts/v3-sync-runs-compat.test.mts` | pass |
| `npx tsx scripts/v3-bounded-sync.test.mts` | pass |
| `npm run test:v2` | pass |
| `npm run test:v3` | pass |
| `npx tsc --noEmit` | pass |
| `npm run build` | pass |

---

## Final review wave

The final hardening is implemented on
`cursor/triage-atlas-janitor-spec-889f` and remains intentionally unpushed:

- `43b2ea6` — snapshot reconciliation and complete least-privilege schema
- `e0c4d83` — focused regression coverage and provider deadline/import fixes
- `8e0bae3` — origin protection, account allowlist/cache isolation, ownership,
  serialized outbox claims, and reader refresh wiring
- `02a1fe9`, `26a0461`, `aa69ddd` — cache contract, head-poll semantics, and
  account-scoped reader cache URL corrections

Folder reconciliation is provider-authoritative: completed generations remove
stale membership only after their final bounded page. Inbox rescans are due
every 15 minutes; Sent and Trash rescans are due every six hours. Head polls
only add/update and never remove, so a provider-side archive/trash/restore
converges on the next bounded Inbox snapshot without restarting history.

No live provider verification or production database mutation was performed in
this follow-up. A previously revoked or failed Google credential must remain
`reconnect_required` in Settings; no Google-health claim is valid until an
operator completes reconnect and verifies the provider.

### Concerns

- Apply all migrations below in filename order before deploy; the final two
  migrations provide least-privilege policy, UUID snapshot generations, and
  per-account OAuth health:
  `20260810022424_seer_v2_core.sql`,
  `20260811030000_seer_v2_functions.sql`,
  `20260811190000_v3_folders_outbox.sql`,
  `20260811220000_sync_runs_folder_complete.sql`,
  `20260811230000_folder_sync_backfill_complete.sql`,
  `20260811234500_v3_final_review.sql`, and
  `20260811235000_v3_final_review_followups.sql`.
- `seer_app` is created as `LOGIN NOINHERIT` without a password. Operators must
  provision its password outside migrations and configure
  `SEER_V2_DATABASE_URL` with `seer_app` or `seer_app.<project>`.
- Head poll always fetches page 1 — providers must return newest-first for incremental new-mail detection.
- `mode=full` on incomplete backfill resumes cursor (does not restart) — intentional for bounded rebuild continuity.
- Round-robin gives each account×folder at most 2 pages/tick (2 rounds × 1 page); tune `DEFAULT_ROUNDS` if throughput insufficient.

---

## Final review remediation

Status: implemented. Not pushed.

Commit: `e0074b6` (prior: `68b365c`).

### Blocker 1 — full reset durability

**Problem**: `mode=full` on a completed folder persisted `backfill_complete=false` before any provider page. Deadline before first page erased durable completed state; next incremental restarted historical backfill.

**Fix**: Full reset is in-memory only (`workingState`) until the first page is written. If `pages===0` (deadline or cap), return values and DB reflect `durableState` unchanged. First committed page atomically persists `backfill_complete=false` with the page cursor.

**Test**: `v3-sync-backfill` — completed inbox + aborted full tick + incremental head-poll confirms durable state preserved.

### Blocker 2 — double head-poll in round-robin

**Problem**: Default 2 rounds head-polled completed folders twice per tick.

**Fix**: `syncTickRoundRobin` tracks `satisfiedSlices` (`accountId:folder`). Slices with `polledHead=true` or `complete=true` are skipped in round 2+. Incomplete backfills (`complete=false`) still get round 2.

**Test**: `v3-sync-fairness` — completed inbox polled once; huge sent advances twice; trash ≥ once in one 2-round tick.

### Verification

| Command | Result |
|---------|--------|
| `npm run test:v2` | pass |
| `npm run test:v3` | pass |
| `npx tsc --noEmit` | pass |
| `npm run build` | pass |
