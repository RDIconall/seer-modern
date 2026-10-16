# Seer ↔ Chief of staff bot contract

The bot cannot sign in through the Seer web app (Vercel Authentication sits
in front of it). It talks to Seer in two ways:

1. **SQL** against the Supabase project `supabase-modern-seer`, schema `seer`
2. **Optional signed webhook** from Seer when Conall posts a chat message or
   changes a task, so the bot can wake without polling

Seer never executes mail actions the bot proposes until Conall approves them
in Atlas. `delete` always means trash / Deleted Items — recoverable, never a
permanent purge.

---

## Enablement

1. Apply the repo migration `supabase/migrations/20261016220000_bot_staff.sql`
   to the **preview** database (or a local test database). Do not apply to
   production from this PR.
2. Seed Conall's 27 open tasks:

   ```bash
   npx tsx scripts/seed-bot-tasks.mts --email <mailbox@rditrials.com>
   ```

   Uses `SEER_V2_DATABASE_URL` or `POSTGRES_URL`. Idempotent on
   `(account_id, external_key)` (`B01`…`B31`).
3. Optional, so the bot is poked instead of polling:

   | Env var | Purpose |
   |---|---|
   | `SEER_BOT_WEBHOOK_URL` | HTTPS endpoint the bot exposes |
   | `SEER_BOT_WEBHOOK_SECRET` | HMAC secret (32+ random bytes) |

   Set these on the Vercel **preview** environment for project `seer-modern`,
   not production, until this is accepted.
4. Point the bot's Supabase SQL connector at the same project. Prefer a
   Postgres role that is a member of `seer_bot` (see Roles). The bot must not
   use the `seer_app` database password.

---

## Roles and RLS

Every new table has RLS enabled. `anon` and `authenticated` are revoked on
schema `seer` (unchanged).

| Role | Access |
|---|---|
| `seer_app` | Full DML on all `seer` tables (the Next.js server) |
| `seer_bot` | DML on `bots`, `bot_tasks`, `bot_task_events`, `bot_messages`, `triage_proposals`. **SELECT only** on `mail_accounts`, `conversations`, `matters`, `messages`. No DML on mail/outbox/commands |
| `anon` / `authenticated` | None |

`seer_bot` is created `NOLOGIN`. In Supabase, create a login role (or use a
dedicated database user) and `grant seer_bot to <login>`. If the connector
runs as `service_role`, it bypasses RLS — still obey this contract and only
touch the tables below.

---

## Who writes what

| Table | Bot | Seer (Conall in Atlas) |
|---|---|---|
| `seer.bots` | Insert a row if a new named bot appears. Prefer the seeded slugs | Seeds the catalog in the migration |
| `seer.bot_tasks` | Insert/update tasks it is running. Set `source = 'bot'` | `createBotTask` / `updateBotTask` commands. `source = 'user'` on create |
| `seer.bot_task_events` | Append `status`, `note`, `comment` as it works | Appends on every user create/update/comment |
| `seer.bot_messages` | Insert replies with `author = 'bot'` | `postBotMessage` with `author = 'user'` |
| `seer.triage_proposals` | Insert `status = 'pending'` proposals. Never set `approved`/`executed` itself | `decideTriageProposal` — the only path that executes mail |
| `seer.outbox` / `command_receipts` | **Never** | Seer enqueues trash/archive after approval |
| Mail corpus (`conversations`, …) | **Read only** (to fill `conversation_id`) | Unchanged sync |

The bot must **not** `UPDATE seer.triage_proposals.status` to `approved` or
`executed`. That would skip Conall's approval. If it needs to withdraw a
proposal, set `status = 'rejected'` with `decided_by = 'bot'` or delete the
pending row.

---

## Tables

### `seer.bots`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `slug` | text unique | Stable id the bot uses: `chief-of-staff` |
| `display_name` | text | Shown in Atlas: `Chief of staff` |
| `created_at` | timestamptz | |

Seeded slugs: `chief-of-staff`, `personal-chief-of-staff`, `snak-bot`,
`it-admin`, `site-outreach`, `recruiter`, `growth`, `proposals-bids`.

### `seer.bot_tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK `mail_accounts` | Always Conall's mailbox |
| `bot_id` | uuid FK `bots` | Owner bot |
| `external_key` | text | Optional idempotency key (`B01`). Unique per account when set |
| `title` | text not null | |
| `status` | text not null | See status values |
| `priority` | int not null default 100 | Lower sorts first |
| `due_at` | timestamptz | |
| `notes` | text | Working notes |
| `his_words` | text | Conall's original wording |
| `current_state` | text | Bot's latest state sentence |
| `next_action` | text | |
| `source` | text not null | `user` \| `bot` |
| `created_at` / `updated_at` | timestamptz | `updated_at` maintained by trigger |

**Status values** (check constraint):

| Value | Atlas label |
|---|---|
| `open` | Open |
| `in_progress` | In progress |
| `blocked` | Blocked |
| `waiting_on_user` | Waiting on Conall |
| `done` | Done |
| `dropped` | Dropped |

When the bot updates `status`, `current_state`, `next_action`, or `notes`, it
must also insert a `bot_task_events` row so Atlas has a trail.

### `seer.bot_task_events`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK | Denormalized for RLS/grants |
| `task_id` | uuid FK `bot_tasks` on delete cascade | |
| `actor` | text | `user` \| `bot` |
| `actor_name` | text | `Conall` or the bot display name |
| `kind` | text | `created` \| `status` \| `comment` \| `note` \| `priority` \| `due` \| `assign` \| `title` |
| `body` | text | Human-readable line |
| `payload` | jsonb | e.g. `{ "from": "open", "to": "blocked" }` |
| `created_at` | timestamptz | |

Append-only. Do not update or delete events.

### `seer.bot_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK | |
| `bot_id` | uuid FK | Which bot is in the thread |
| `task_id` | uuid FK null | **null = general thread** for that bot |
| `author` | text | `user` \| `bot` |
| `body` | text not null | Plain text (or light markdown) |
| `created_at` | timestamptz | |

General thread: `task_id is null` and `bot_id` = Chief of staff.

The bot replies by inserting `author = 'bot'`. Atlas polls `/api/v2/staff`
while the whiteboard is open (~8s).

### `seer.triage_proposals`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK | |
| `bot_id` | uuid FK | |
| `conversation_id` | uuid FK `conversations` | Preferred. Look up from corpus |
| `provider_conversation_id` | text | Gmail thread id / Graph conversation id |
| `sender_email` | text | |
| `subject` | text | |
| `action` | text | `delete` \| `archive` \| `keep` \| `file` \| `filtered` |
| `destination_id` | text | Provider folder/label id when `file` or `filtered` |
| `destination_name` | text | Shown in Atlas |
| `rationale` | text | Why the bot proposes this |
| `status` | text | `pending` \| `approved` \| `rejected` \| `executed` \| `failed` |
| `last_error` | text | Set by Seer if execution fails |
| `outbox_id` | uuid | Set by Seer when trash/archive is queued |
| `created_at` | timestamptz | |
| `decided_at` | timestamptz | |
| `decided_by` | text | `user` \| `bot` (withdraw) |

**Actions after Conall approves:**

| Action | What Seer does |
|---|---|
| `delete` | Outbox `trash` (Gmail trash / Outlook Deleted Items). Never permanent delete |
| `archive` | Outbox `archive` |
| `keep` | Record only. Mail is not moved |
| `file` | Provider `move` to `destination_id` (required) |
| `filtered` | If `destination_id` is set, `move`; otherwise `archive` (out of inbox). Seer does not create a provider inbox rule |

A proposal without a resolvable conversation cannot execute `delete` /
`archive` / `file`. Leave it `pending` until you can set `conversation_id` or
`provider_conversation_id` that exists in `seer.conversations`.

Suggested lookup:

```sql
select id, provider_conversation_id, subject
  from seer.conversations
 where account_id = $account_id
   and (
     provider_conversation_id = $provider_id
     or id = $conversation_id
   )
 limit 1;
```

---

## Webhook (optional)

Seer POSTs to `SEER_BOT_WEBHOOK_URL` after a **user** staff command succeeds.
If the env vars are unset, Seer does nothing; poll SQL.

### Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Seer-Timestamp` | Unix seconds (string) |
| `X-Seer-Signature` | `sha256=<hex>` |

### Signature

```
mac = HMAC_SHA256(SEER_BOT_WEBHOOK_SECRET, `${timestamp}.${rawBody}`)
header = "sha256=" + hex(mac)
```

Reject if `|now - timestamp| > 300` seconds, or if the signature does not
match (timing-safe compare). `rawBody` is the exact JSON bytes posted.

### Payload

```json
{
  "event": "bot_message.created",
  "accountId": "uuid",
  "accountEmail": "conall@rditrials.com",
  "occurredAt": "2026-10-16T23:00:00.000Z",
  "taskId": null,
  "messageId": "uuid",
  "proposalId": null,
  "task": null,
  "message": {
    "id": "uuid",
    "taskId": null,
    "author": "user",
    "body": "Can you kick off Divvy?",
    "createdAt": "2026-10-16T23:00:00.000Z"
  }
}
```

`event` is one of:

- `bot_task.created`
- `bot_task.updated`
- `bot_task.commented`
- `bot_message.created`
- `triage_proposal.decided`

Webhook delivery is best-effort (5s timeout). A failed ping does not roll back
the command. The durable record is always the row in Postgres.

---

## Atlas commands (Seer → DB)

The browser never talks to these tables. Conall's actions are commands on
`POST /api/v2/commands` with `{ command, idempotencyKey }`.

| `command.type` | Effect |
|---|---|
| `createBotTask` | Insert task + `created` event; webhook `bot_task.created` |
| `updateBotTask` | Patch status / notes / due / priority / title / bot; event + webhook |
| `commentBotTask` | Event `kind=comment`; webhook `bot_task.commented` |
| `postBotMessage` | Insert `author=user` message; webhook `bot_message.created` |
| `decideTriageProposal` | `approved` → execute mail; `rejected` → close. Webhook `triage_proposal.decided` |

The bot does not call this HTTP API (SSO). It writes SQL instead.

---

## Polling recipe (if the webhook is off)

```sql
-- Open work
select t.*, b.slug, b.display_name
  from seer.bot_tasks t
  join seer.bots b on b.id = t.bot_id
 where t.account_id = $account_id
   and t.status in ('open', 'in_progress', 'blocked', 'waiting_on_user')
 order by t.priority, t.created_at;

-- New user chat since last seen
select *
  from seer.bot_messages
 where account_id = $account_id
   and author = 'user'
   and created_at > $cursor
 order by created_at;

-- Proposals still waiting on Conall (read-only for the bot)
select *
  from seer.triage_proposals
 where account_id = $account_id
   and status = 'pending';
```

---

## Invariants

1. Nothing in Outlook/Gmail moves until Conall approves a proposal in Atlas.
2. `delete` = trash. There is no purge path on this contract.
3. User chat and task edits are durable in SQL even if the webhook is down.
4. Do not write `seer.outbox`, `seer.command_receipts`, or mutate
   `seer.conversations`.
5. Keep `account_id` on every row. This mailbox is single-owner; still filter
   every query by account.
