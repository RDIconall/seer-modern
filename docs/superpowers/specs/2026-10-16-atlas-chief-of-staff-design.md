# Atlas Chief of staff — design

Date: 2026-10-16
Status: accepted for implementation (single-owner Seer; cloud agent)

## Problem

Conall's external 'Chief of staff' bot works in a separate chat. It cannot sign
in through the browser (Vercel SSO). He wants that work inside Atlas: the
tasks he already gave the bots, a place to talk to the bot next to a matter,
and mail-triage proposals that never move mail until he taps yes.

## Goal

Atlas is the shared desk. Delegated bot work, the conversation with the bot,
and per-email triage proposals all live there. The bot reads and writes a
narrow set of `seer` tables over SQL. Seer optionally pings a signed webhook
when Conall acts, so the bot can react without polling.

## Non-goals

- Letting the bot sign in, scrape the UI, or bypass Vercel SSO
- Auto-executing mail actions (including "filters" that would create provider
  rules)
- Permanent delete
- Changing the existing Atlas matter board, inbox projection, or sync pipeline
- Applying this migration to production or deploying production from this work

## Approach

Separate staff tables, rendered on Atlas — not new `seer.matters` rows.

Email-derived matters stay what they are: concerns with conversations. A
delegated task is work Conall gave a named bot. Mixing them in `seer.matters`
would make the brain's filing pass responsible for bot chores, and would
break the Atlas contract that a matter line opens mail.

Atlas already has a master/detail split. Delegated rows sit in a **Delegated**
band on the whiteboard (grouped by bot; owner = bot name). Opening a row
fills the existing reader pane with the task (status, due, notes, history,
chat). A header control opens the general Chief of staff thread in that same
pane. Pending triage proposals sit above the board as approve/reject actions.

User writes go through the v2 command bus (`POST /api/v2/commands`) with
idempotency keys. Bot writes go straight to SQL. Approved mail actions reuse
`delete`→trash, `archive`, and `move` — never a provider purge.

## Data

See `docs/bot-integration-contract.md` for the column-level contract the bot
follows. Summary:

| Table | Purpose |
|---|---|
| `seer.bots` | Named bots (`chief-of-staff`, `snak-bot`, …) |
| `seer.bot_tasks` | Delegated work, account-scoped |
| `seer.bot_task_events` | Status changes, comments, notes |
| `seer.bot_messages` | Chat; `task_id` null = general thread |
| `seer.triage_proposals` | Proposed mail actions awaiting Conall |

RLS on, `anon`/`authenticated` revoked, `seer_app` DML, `seer_bot` DML only on
these tables plus read on mail identity/corpus for lookups.

## Commands

`createBotTask`, `updateBotTask`, `commentBotTask`, `postBotMessage`,
`decideTriageProposal`. Approve of delete/archive/file runs the existing
outbox or `move` path. `delete` means trash/Deleted Items.

## Webhook

If `SEER_BOT_WEBHOOK_URL` and `SEER_BOT_WEBHOOK_SECRET` are set, Seer POSTs
after a user command that touches staff data. HMAC-SHA256 over
`timestamp + "." + body`. The bot may ignore it and poll SQL instead.

## Seed

`fixtures/bot_tasks.csv` (27 open tasks, Conall's wording). Idempotent script
`scripts/seed-bot-tasks.mts` upserts by `(account_id, external_key)`.

## UI

- Atlas: Delegated band + proposal strip + Chief of staff chat control
- Reader pane: task inspector (not a board modal — Atlas stays an index)
- No `MatterDetail` / `aria-modal` on the board (existing Atlas contract)
