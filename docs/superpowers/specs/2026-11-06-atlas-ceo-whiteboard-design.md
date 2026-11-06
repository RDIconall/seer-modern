# Atlas CEO Whiteboard — design

Date: 2026-11-06
Status: accepted for implementation (single-owner Seer; cloud agent)

## Problem

Conall reviewed live Atlas (`#section=atlas`) and three things failed at once:

1. **Delegated / Chief of staff (41)** rendered every open bot task as uncompressed rows at the top of Whiteboard, pushing the 98 Atlas matters below the fold.
2. Opening an email (`#section=atlas&conversation=…`) filled the right pane while the left pane stayed parked at the top of Delegated. The matching Atlas matter was neither scrolled into view, expanded, nor shown beside the thread.
3. The CEO Whiteboard he already runs in OneNote (Due Now, Cash + Lender, Sales + Marketing, Board, Ops, Company Future, Contracts, Security, Relationships, Done) is not a first-class surface in Seer, so bots cannot keep it current.

## Goal

Atlas is Conall's executive desk. The default surface is his CEO Whiteboard. Live mail matters sit in the same domains. Delegated bot work has its own Bots lens, collapsed by default. Selecting a matter, whiteboard item, or bot task that has mail opens that thread **next to the row** — the row stays highlighted, expanded, and anchored, with status/next action visible beside the reader.

## Non-goals

- Auto-executing mail. Triage proposals still wait for Conall.
- Rewriting `seer.matters` or mixing bot tasks into the brain's filing pass.
- Destructive schema changes. New tables/columns are additive. The app degrades if they have not been migrated yet.
- Applying the migration to production from this PR.

## Lenses

Sticky chrome under the Whiteboard title:

| Lens | What it shows |
|---|---|
| **Board** (default) | CEO domain boxes. Whiteboard items, a few related mail matters, and a compact **Needs you** strip of `waiting_on_user` bot tasks. |
| **Mail** | Today's email-backed Atlas matters (All / Mine, sections, drag, archive). |
| **Bots** | All delegated work grouped by bot, collapsible, filterable (Open / Waiting / Blocked / Done), plus triage proposals and Chat. |

`#section=atlas&atlas=mail&conversation=…` is optional. A conversation hash with no lens infers Board / Mail / Bots from whichever object owns the thread.

## Email next to the task

Root causes in the current code:

- `StaffBoard` is mounted **above** every matter column and lists every active task.
- `BoardMatter` is hard-coded `open={false}`, so the selected matter never expands to show next action / threads.
- Hash load sets `conversationId` for the reader and does not scroll the owning row in `.mail-folder-pane`.
- Opening a staff task **clears** `conversationId` and replaces the reader with `StaffPane`, so mail and the task cannot appear together.

Fix:

1. Move the full bot list to the Bots lens. Board only surfaces waiting-on-Conall work.
2. The selected matter/item/task expands (`open={current}`) and `scrollIntoView({ block: "nearest" })` against the folder pane.
3. A sticky **anchor dock** stays under the chrome on the left, and a matching strip sits at the top of the reader, so the title/status/next action remain adjacent to the email if the list scrolls.
4. A bot task or whiteboard item with `conversation_id` opens the mail reader **and** keeps the row selected. `StaffPane` is for chat / tasks with no linked thread.

## Data

Additive migration `supabase/migrations/20261106200000_ceo_whiteboard.sql`:

| Object | Purpose |
|---|---|
| `seer.whiteboard_sections` | Per-account catalog (slug + title + sort) |
| `seer.whiteboard_items` | Checklist rows. `external_key` unique per account for bot upserts (`W001`…) |
| `seer.bot_tasks.whiteboard_slug` | Optional domain pin |
| `seer.bot_tasks.conversation_id` | Optional linked thread |

`seer_bot` gets DML on the two new tables (same pattern as staff tables) and still has **SELECT only** on the mail corpus. No grants on `outbox` / `command_receipts`.

First `GET /api/v2/whiteboard` for an account inserts the catalog and the Oct 30 2026 seed (idempotent on `external_key`) when the tables exist and the account is empty. If the tables are missing (`42P01`), the API returns `{ persisted: false }` and the client renders the same seed read-only/local so Atlas still works.

## Commands

| `command.type` | Effect |
|---|---|
| `createWhiteboardItem` | Insert item + optional webhook `whiteboard_item.created` |
| `updateWhiteboardItem` | Patch title/status/section/due/owner/conversation; webhook `whiteboard_item.updated` |

Checking off an item sets `status = done`. The Done box shows done items; domain boxes hide them. Bots upsert by `(account_id, external_key)` over SQL — they do not call the HTTP API.

## Mapping live work onto domains

Deterministic, not a model call:

- Matter section names (`sales — leads`, `finance (ar/ap)`, `operations — studies`, `board`, `recruiting`, …) → a CEO slug or `null` (newsletters stay on Mail only).
- Bot slugs: `growth` / `site-outreach` / `proposals-bids` → Sales + Marketing; `recruiter` → Company Future; `it-admin` → Security; `snak-bot` → Ops; Chief of staff unmapped unless `whiteboard_slug` is set.

Due Now is the CEO time bucket: seed items plus open whiteboard items with a due date in the next week.

## UI density

- Domain boxes use the existing whiteboard type (National 2, 12/14/17, 400/700). Due Now is first.
- A domain box lists its checklist, then up to four related mail matters, then a count chip for mapped bot tasks.
- Bots groups are collapsed; the heading carries `41 · 8 waiting`. Expanding a group shows rows. Waiting-on-Conall rows stay two-line, ≥44px.
- All / Mine stay in the chrome (Board + Mail). Bots uses status filters instead.

## Verification

- Contract tests: Board is default; Delegated no longer dumps every open task; clicking a matter still calls `onOpenConversation`; selected row is current + expanded; Bots lens still lists Chief of staff.
- Schema test: new tables, RLS, `seer_bot` DML, no INSERT on `conversations`.
- Command test: create/update item; missing-table path returns `persisted: false`.
- Preview `/dev/preview#section=atlas` for screenshots: Board with boxes; click a matter and see the thread beside the highlighted row.
