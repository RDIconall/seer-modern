# V3 Full Email Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the full email client on the v2 corpus and brain, with multi-folder sync and Superhuman-style optimistic mutations backed by a durable write-behind outbox.

**Architecture:** The provider remains source of truth, while the UI renders immediately from the local corpus. Every mutation atomically applies an optimistic corpus patch and enqueues the provider command; a drain retries idempotently and sync reconciles divergence. Inbox, Sent, and Trash are corpus-backed; only Inbox enters the paid read pipeline.

**Tech Stack:** Next.js App Router, React, TypeScript, PostgreSQL/Supabase, `pg`, Gmail API, Microsoft Graph, Zod, existing v2 provider contract and command bus.

## Global Constraints

- Provider-neutral business/UI code: only adapters branch on Gmail vs Outlook.
- Provider is authoritative; corpus converges on every sync.
- Optimistic mutation + outbox enqueue are one database transaction.
- Every provider write uses the stored idempotency key.
- Delete still requires the current signed decision token.
- Sent and Trash never enter the AI read queue.
- App database role stays `seer_app`; no runtime DDL.
- Existing Atlas, Triage, safety, contrast, provider-contract, and cron gates remain green.

---

### Task 1: Folder-aware corpus schema

**Files:**
- Create: `supabase/migrations/20260811190000_v3_folders_outbox.sql`
- Modify: `supabase/migrations/20260810022424_seer_v2_core.sql`
- Modify: `scripts/v2-schema.test.mts`
- Test: `scripts/v3-schema.test.mts`

**Interfaces:**
- Produces `MailFolder = "inbox" | "sent" | "trash" | "archive"`.
- Produces `seer.conversations.folders text[]`, `is_unread boolean`, `last_synced_at timestamptz`.
- Produces `seer.folder_sync_state(account_id, folder, cursor, provider_total, updated_at)`.
- Produces `seer.outbox` with `pending|inflight|done|failed|cancelled`.

- [ ] Write the failing schema test that asserts columns, folder-specific sync state, outbox constraints, and indexes.
- [ ] Run `npx tsx scripts/v3-schema.test.mts`; expect missing relations/columns.
- [ ] Add the migration:

```sql
alter table seer.conversations
  add column folders text[] not null default '{}',
  add column is_unread boolean not null default false,
  add column last_synced_at timestamptz;

create table seer.folder_sync_state (
  account_id uuid not null references seer.mail_accounts(id) on delete cascade,
  folder text not null check (folder in ('inbox','sent','trash')),
  cursor text,
  provider_total int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, folder)
);

create table seer.outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts(id) on delete cascade,
  command jsonb not null,
  idempotency_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending','inflight','done','failed','cancelled')),
  attempts int not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

- [ ] Grant `seer_app` DML/sequence access and create its explicit RLS policy in the migration.
- [ ] Run schema tests; expect PASS.
- [ ] Commit `feat(v3): add folder state and mutation outbox`.

### Task 2: Folder-aware provider contract

**Files:**
- Modify: `src/lib/v2/providers/types.ts`
- Modify: `src/lib/v2/providers/fake.ts`
- Modify: `src/lib/v2/providers/contract.ts`
- Modify: `src/lib/v2/providers/gmail.ts`
- Modify: `src/lib/v2/providers/outlook.ts`
- Test: `scripts/v2-provider-contract.test.mts`
- Test: `scripts/v2-provider-gmail.test.mts`
- Test: `scripts/v2-provider-outlook.test.mts`

**Interfaces:**
- `type SyncFolder = "inbox" | "sent" | "trash"`.
- `MailProvider.syncFolder(folder: SyncFolder, cursor?: string|null): Promise<SyncPage>`.
- Existing `sync(cursor)` remains an inbox-compatible wrapper.

- [ ] Extend shared contract tests: every folder paginates, returns complete conversations, and reports its own total.
- [ ] Run provider tests; expect `syncFolder` missing.
- [ ] Add `SyncFolder` and `syncFolder` to the interface/fake.
- [ ] Gmail queries: `in:inbox`, `in:sent`, `in:trash`; preserve complete thread hydration and label state.
- [ ] Outlook queries: `mailFolders/inbox|sentitems|deleteditems/messages`; preserve attachment expansion.
- [ ] Keep `sync(cursor) { return syncFolder("inbox", cursor) }`.
- [ ] Run all provider tests; expect PASS.
- [ ] Commit `feat(v3): sync inbox sent and trash through provider contract`.

### Task 3: Multi-folder sync and list projection

**Files:**
- Modify: `src/lib/v2/sync/engine.ts`
- Modify: `src/lib/v2/sync/repository.ts`
- Modify: `src/app/api/v2/sync/route.ts`
- Create: `src/lib/v3/mailbox/types.ts`
- Create: `src/lib/v3/mailbox/repository.ts`
- Create: `src/app/api/v3/mailbox/route.ts`
- Test: `scripts/v3-sync-folders.test.mts`
- Test: `scripts/v3-mailbox-view.test.mts`

**Interfaces:**
- `syncFolder(accountId, provider, folder, mode): Promise<SyncRun>`.
- `MailboxView { folder, rows, total, nextCursor }`.
- `getMailboxView(accountId, folder, limit, before?): Promise<MailboxView>`.

- [ ] Write a fake-provider test: inbox/sent/trash persist with correct `folders`, sent rows are outgoing, trash rows are excluded from inbox.
- [ ] Make repository writes merge the current folder into `folders` and compute conversation `is_unread = bool_or(message.is_unread)`.
- [ ] Store cursors in `folder_sync_state`; retain old `sync_state` only for compatibility until cutover.
- [ ] Update sync route to drain all three folders, but report each separately.
- [ ] Build corpus list query returning sender display name, subject, timestamp, unread, snippet, attachments, current decision summary/priority/due date/matter title.
- [ ] Add authenticated `/api/v3/mailbox?folder=inbox|sent|trash&limit=&before=`.
- [ ] Ensure the read queue filters to `folders @> ARRAY['inbox']`.
- [ ] Run folder sync, mailbox-view, and existing sync tests; expect PASS.
- [ ] Commit `feat(v3): persist and project all mailbox folders`.

### Task 4: Durable optimistic outbox

**Files:**
- Create: `src/lib/v3/outbox/types.ts`
- Create: `src/lib/v3/outbox/repository.ts`
- Create: `src/lib/v3/outbox/optimistic.ts`
- Create: `src/lib/v3/outbox/drain.ts`
- Create: `src/app/api/v3/outbox/drain/route.ts`
- Test: `scripts/v3-outbox.test.mts`
- Test: `scripts/v3-outbox-drain.test.mts`

**Interfaces:**
- `enqueueOptimistic(accountId, command, key): Promise<OutboxItem>`.
- `drainOutbox(accountId, provider, {limit}): Promise<DrainReport>`.
- `cancelPending(accountId, outboxId): Promise<boolean>`.
- `applyOptimistic(client, accountId, command)` and `revertOptimistic(...)`.

- [ ] Test atomicity: corpus patch and outbox row commit or roll back together.
- [ ] Define optimistic folder transitions:
  - archive: remove `inbox`, add `archive`
  - trash: remove `inbox|archive`, add `trash`
  - restore: remove `trash`, add `inbox`
  - markUnread: `is_unread=true`
- [ ] Implement enqueue and idempotent replay by key.
- [ ] Test drain: oldest pending first, mark inflight, call provider once, done on success, exponential backoff on transient failure, failed+revert after max attempts.
- [ ] Test undo: cancel pending + revert; no provider call.
- [ ] Add cron-authenticated drain route and call drain before sync reconciliation.
- [ ] Run outbox tests; expect PASS.
- [ ] Commit `feat(v3): add durable optimistic mutation outbox`.

### Task 5: Route commands through the outbox

**Files:**
- Modify: `src/app/api/v2/commands/route.ts`
- Modify: `src/lib/v2/commands/execute.ts`
- Modify: `src/lib/v2/commands/repository.ts`
- Create: `src/app/api/v3/outbox/[id]/undo/route.ts`
- Test: `scripts/v3-command-outbox.test.mts`

**Interfaces:**
- Mutation commands return `{ outboxId, optimistic: true }` immediately.
- Send/reply remain synchronous in Stage 1; they already need provider receipts to form a message.

- [ ] Test archive/delete/restore/markUnread enqueue instead of calling provider synchronously.
- [ ] Keep delete-token verification before enqueue.
- [ ] Keep correction/teaching/send/reply behavior unchanged.
- [ ] Add authenticated undo route that only cancels `pending`.
- [ ] Return fresh mailbox/triage view after optimistic commit.
- [ ] Run command, selection-safety, and outbox tests; expect PASS.
- [ ] Commit `feat(v3): route mail mutations through write-behind queue`.

### Task 6: Conversation reader, search, and attachments

**Files:**
- Create: `src/app/api/v3/conversations/[id]/route.ts`
- Create: `src/app/api/v3/search/route.ts`
- Create: `src/app/api/v3/messages/[id]/attachments/[attachmentId]/route.ts`
- Modify: `src/components/v2/Reader.tsx`
- Modify: `src/components/v2/MessageHtml.tsx`
- Modify: `src/components/v2/Compose.tsx`
- Test: `scripts/v3-reader-api.test.mts`
- Test: `scripts/v3-search.test.mts`

**Interfaces:**
- `GET conversation` returns corpus thread oldest-first and native URL.
- Search calls provider, joins stored decision/matter metadata by provider conversation id, and returns transient rows for not-yet-synced results.

- [ ] Test corpus reader route ownership and thread order.
- [ ] Wire reply/reply-all/forward/archive/delete to command bus; forward adds command type and executor case.
- [ ] Test provider search pagination and metadata join.
- [ ] Add attachment streaming using provider adapters; verify ownership and filename/content headers.
- [ ] Preserve sanitized HTML rendering and text fallback.
- [ ] Commit `feat(v3): wire reader compose search and attachments`.

### Task 7: Responsive full-client shell

**Files:**
- Create: `src/components/v3/MailClient.tsx`
- Create: `src/components/v3/Navigation.tsx`
- Create: `src/components/v3/FolderList.tsx`
- Create: `src/components/v3/SearchBox.tsx`
- Create: `src/components/v3/ReaderPane.tsx`
- Create: `src/components/v3/ComposePane.tsx`
- Create: `src/components/v3/useMailbox.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/app/m/page.tsx`
- Test: `scripts/v3-ui-contract.test.mts`
- Test: `scripts/v3-styles.test.mts`

**Interfaces:**
- One shell, CSS-responsive: split pane desktop; full-screen reader mobile.
- Navigation: Inbox, Sent, Trash, Atlas, Triage, Settings.
- URL/hash restores folder, conversation, and search.

- [ ] Write contract test for every navigation surface and no legacy `useMailbox`/`Brief` import.
- [ ] Implement stale-while-revalidate folder hook with local cache and body prefetch for adjacent rows.
- [ ] Render current Atlas/Triage components unchanged inside the shell.
- [ ] Wire optimistic actions, selection, undo toast, reader, compose, search.
- [ ] Keep native-provider escape hatch visible.
- [ ] Verify mobile: bottom navigation, full-screen reader, visible checkboxes, no hover-only action.
- [ ] Run UI/style/contrast tests and dev-preview screenshots.
- [ ] Commit `feat(v3): restore full responsive mail client shell`.

### Task 8: Settings and v2 account cutover

**Files:**
- Create: `src/components/v3/Settings.tsx`
- Create: `src/app/api/v3/accounts/route.ts`
- Modify: `src/lib/v2/db/accounts.ts`
- Modify: `src/lib/mail/session.ts`
- Modify: `src/lib/store/accounts.ts`
- Create: `scripts/migrate-v3-accounts.mts`
- Test: `scripts/v3-accounts.test.mts`

**Interfaces:**
- Settings: current account, reconnect, add, remove, switch, sign out.
- v2 tables become canonical; legacy account store is read-only fallback during migration, then deleted.

- [ ] Test account isolation and that no API returns token/ciphertext.
- [ ] Make OAuth callback upsert relational account + encrypted credentials.
- [ ] Make session resolve active account from v2, with legacy fallback only until migrated.
- [ ] Implement settings account operations and sign-out.
- [ ] Migrate live accounts; verify provider token refresh.
- [ ] Delete plaintext-compatible fallback only after production verification.
- [ ] Commit `feat(v3): move account management onto encrypted v2 storage`.

### Task 9: Production cutover and verification

**Files:**
- Modify: `vercel.json`
- Modify: `docs/legacy-vs-v2-user-stories.md`
- Test: all `scripts/*.test.mts`

**Interfaces:**
- Allowlisted user receives `MailClient`.
- Existing v2 crons drain outbox, sync all folders, then read inbox-only.

- [ ] Apply migrations with Supabase migration tooling.
- [ ] Commit and push pre-test revision; deploy behind the existing allowlist.
- [ ] Full mailbox reconciliation: provider totals vs corpus per folder.
- [ ] Manual story: open inbox → reader → reply; archive then undo before drain; archive after drain; search; browse Sent/Trash; compose/send; sign out/reconnect.
- [ ] Verify outbox contains no stuck inflight rows and failed actions are visible.
- [ ] Run security advisors, least-privilege test, secret sweep, full suite/build.
- [ ] Update PR and mark rollout notes in docs.
- [ ] Commit `release: cut over allowlisted account to V3 mail client`.

## Self-Review

- Spec coverage: multi-folder sync (Tasks 1–3), write-behind/undo/reconcile (4–5), full client surfaces (6–7), v2 account migration (8), production proof (9).
- No placeholder steps; later stages are intentionally out of this Stage 1 plan.
- Type consistency: `SyncFolder`, `MailboxView`, `OutboxItem`, `enqueueOptimistic`, `drainOutbox` are introduced before consumers.
