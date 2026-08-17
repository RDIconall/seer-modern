# V3 — the old app on the new brain

## Intent

Restore the full email client the legacy app was, on the v2 corpus and decision
engine. Staged (approach A): a first release that is a real client, then
successive slices for the deeper legacy features. Actions follow the Superhuman
model (approach C): the UI is instant, the provider is caught up by a durable
write-behind queue, and the corpus reconciles against the provider as the
source of truth.

This is a design for the whole arc, with Stage 1 specified in enough detail to
plan and build. Later stages are scoped, not detailed.

## What already exists (do not rebuild)

- **Command bus** (`src/lib/v2/commands/`): `delete` (signed-token gated),
  `archive`, `restore`, `markUnread`, `send`, `reply`, `correctConversation`,
  `teachSender`. Idempotent by key, audited, honest about partial failure.
- **Provider contract** (`src/lib/v2/providers/`): `sync`, `getConversation`,
  `search`, `send`, `reply`, `forward`, `mutateConversation`, `nativeUrl` —
  Gmail and Outlook both satisfy it, verified by a shared contract test.
- **Reader / Compose / MessageHtml** components — written, currently unreachable.
- **Corpus**: conversations, messages (bodies, recipients, attachment names,
  `is_unread`, `is_outgoing`), decisions, matters, yields, people, functions.
- **Sync engine**: incremental + full drain, coverage reconciliation, per-page
  transactions. **Inbox only today** (`in:inbox` hardcoded in the adapters).

## The gaps V3 closes

1. **Sync is inbox-only.** Sent and Trash are not in the corpus, and a
   conversation has no notion of which folder(s) it lives in or whether it is
   read.
2. **No write-behind.** Commands call the provider synchronously; a failure
   surfaces as a rejected request, and there is no queue, retry, or undo.
3. **No client shell.** No folder navigation, no reader/compose wiring, no
   search UI, no settings, no sign-out.
4. **Accounts still live in the legacy KV store**, not the v2 relational model.

---

## Architecture

### Required migration order

The deploy applies every committed migration in filename order:

1. `20260810022424_seer_v2_core.sql`
2. `20260811030000_seer_v2_functions.sql`
3. `20260811190000_v3_folders_outbox.sql`
4. `20260811220000_sync_runs_folder_complete.sql`
5. `20260811230000_folder_sync_backfill_complete.sql`
6. `20260811234500_v3_final_review.sql`
7. `20260811235000_v3_final_review_followups.sql`

The final review migration establishes least-privilege RLS and folder snapshot
tables; the follow-up migration upgrades snapshot generations to UUIDs and adds
per-account OAuth health. `seer_app` has no migration-provisioned password:
operators set it separately and provide `SEER_V2_DATABASE_URL`.

### Data model additions

`seer.conversations` gains folder and read state:

- `folders text[] not null default '{}'` — which provider folders the thread
  appears in (`inbox`, `sent`, `trash`, `archive`). A thread can be in several.
- `is_unread boolean not null default false` — derived from its messages, kept
  on the conversation for fast list queries.
- `last_synced_at timestamptz` — for reconciliation ordering.

New table `seer.outbox` — the write-behind queue and the heart of approach C:

```
id              uuid pk
account_id      uuid
command         jsonb         -- the Command, verbatim
idempotency_key text unique   -- dedupe; also the provider idempotency key
status          text          -- pending | inflight | done | failed
attempts        int
last_error      text
created_at, updated_at, next_attempt_at timestamptz
```

Every mutation is written here first, inside the same transaction that applies
the optimistic change to the corpus. A worker drains it against the provider.
The row is the audit trail, the retry state, and the undo substrate at once.

### The write path (approach C)

1. UI dispatches a command → `/api/v2/commands` (exists).
2. The endpoint, in one transaction: applies the optimistic effect to the
   corpus (e.g. add `trash` to `folders`, remove `inbox`) **and** enqueues the
   command in `outbox` with the idempotency key.
3. The endpoint returns immediately with the new view. UI already rolls back on
   failure (the `useInboxView` hook does this today).
4. A drain — piggybacked on the existing sync cron and callable on demand —
   takes `pending` rows oldest-first, marks `inflight`, calls the provider with
   the stored idempotency key (so a retry never double-acts), and marks `done`
   or `failed` with backoff.
5. Sync reconciles: the provider is the source of truth, so a `done` command
   whose effect the provider confirms needs nothing, and a `failed` command
   after max attempts reverts the optimistic effect and raises a visible event.

**Undo** is: while a row is still `pending`, cancel it and revert the optimistic
effect — no provider call ever left. This is exactly how Superhuman's instant
undo works.

### Multi-folder sync

- `MailProvider.sync` gains a folder dimension. Cleanest: add
  `syncFolder(folder, cursor)` and keep `sync` as `syncFolder('inbox')`, so the
  contract test and existing inbox path are unchanged.
- Adapters map `inbox|sent|trash` to Gmail (`in:sent`, `in:trash`) and Graph
  (`SentItems`, `DeletedItems`) queries.
- The sync engine drains each folder, writing `folders` per conversation. Sent
  and Trash do **not** enter the read/decision pipeline — they are storage for
  browsing, not work to be triaged. Only inbox conversations are queued for a
  chief-of-staff read.

### Provider-authoritative folder reconciliation

Folder backfills are durable snapshots, not append-only imports. Each snapshot
has a generation and start timestamp in `seer.folder_sync_state`; every
conversation returned by every bounded page is recorded in
`seer.folder_sync_seen`. When the final page commits, conversations in that
account that were not seen in the generation lose that folder membership. The
membership update is atomic with publishing the completed generation, so a
bounded tick cannot remove a row merely because a later page has not run yet.

Completed folders use a one-page head poll for ordinary incremental ticks. Head
polls only add or update rows; they never remove folder membership. Inbox starts
a bounded full rescan every 15 minutes so archive/trash/restore actions made on
another device converge without restarting the entire Sent or Trash history.
Sent and Trash use a six-hour reconciliation interval because they are browsing
history rather than the paid read queue. A rescan resumes its cursor across
ticks and removes stale membership only after the final page. Failed hydration
rows remain marked as provider-seen, preventing a malformed body from being
mistaken for provider-side deletion.

### The shell

One responsive app (desktop + mobile by CSS), matching the current v2 shell's
approach. Left rail / bottom nav: **Inbox · Sent · Trash · Atlas · Triage ·
Settings**. Inbox/Sent/Trash render from the corpus; Atlas/Triage are today's
views. Reader opens in a pane (desktop) or full screen (mobile). Compose is a
panel. Search is a route over `provider.search` with corpus rows joined for
Seer's read where present.

### Accounts on v2

Move account identity and the sealed OAuth credentials fully into
`seer.mail_accounts` / `seer.oauth_credentials` (already the v2 home), and make
sign-in write there. This retires the last use of the legacy KV token store.
Settings (accounts, sign-out, reconnect) reads and writes the v2 tables.

---

## Staging

**Stage 1 — a real client (this plan).**
Multi-folder sync (inbox/sent/trash) · folder+read columns · the outbox with
drain, retry, and undo · shell with Inbox/Sent/Trash lists · reader wired ·
compose/reply/reply-all/forward wired · search · settings with sign-out and
reconnect · accounts on v2. Inbox rows carry Seer's read (summary, priority,
matter) where the decision exists.

**Stage 2 — depth.** Matter panel (goal/narrative/next/owner/people, rename,
re-file, settle) · teach/correct affordances on rows · attachment download ·
calendar RSVP.

**Stage 3 — assist & CRM.** AI-drafted replies · delegate-to-EA · unsubscribe ·
Salesforce (amounts, study codes) · behavioural learning (action memory,
replied-thread awareness).

Cards, the waiting-on lane, and the unsubscribe agent are explicitly deferred
and re-evaluated after Stage 2 — several were never reachable in the legacy UI.

---

## Testing & gates

- **Outbox** unit + integration: optimistic effect and enqueue are one
  transaction; a retry with the same key never double-acts; undo of a `pending`
  row makes no provider call; a `failed`-after-max row reverts and raises an
  event. (Fake provider, embedded Postgres.)
- **Multi-folder sync** against the fake provider: sent/trash land with correct
  `folders`; inbox-only enters the read queue.
- **Provider contract** extended for `syncFolder`; Gmail/Outlook adapters pass.
- **Reconciliation**: a provider-side change (archive on another device)
  converges the corpus.
- Existing gates stay green: styles, contrast, cron-path exemption, selection
  safety, naming/merge, least-privilege role.
- Manual verification via the dev preview harness and, where possible, a real
  mailbox read-only run.

## Risks

- **Divergence.** The corpus and provider can disagree between a write and its
  drain. Mitigation: idempotency keys, provider-as-source-of-truth
  reconciliation on every sync, and a visible failure path — never a silent
  revert.
- **Scope.** Stage 1 is itself large. It is sequenced so each piece is
  independently shippable behind the allowlist: sync+columns, then outbox, then
  each UI surface.
- **Storage/cost.** Syncing sent/trash grows stored mail and sync time; bodies
  are fetched once and reused. Sent/trash skip the paid read pipeline entirely.
- **Two eventually-consistent stores** is the hardest part and where a
  maintained reconcile step matters most; it is built explicitly, not assumed.
