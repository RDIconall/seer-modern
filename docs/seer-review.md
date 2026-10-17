# Seer product and engineering review

**Audience:** Conall (CEO) first, then an engineering appendix.  
**Scope:** Read-only review of `RDIconall/seer-modern` on current `main` (`66c68e511d8b187a742bafca9dffc4bf78d98e22`). No code changes, deploys, or migrations were made for this review.  
**Date:** 17 October 2026  
**Live systems checked:** Vercel project `seer-modern` (team `rditrials`); Supabase project `supabase-modern-seer` (`lnbatmukzwbnmrepceol`).

---

## Headline answers

| Question | Answer |
|---|---|
| What is Seer? | RDI’s AI mail desk: it reads the inbox, puts live work on **Atlas**, and helps you clear the rest in **Triage**. |
| Was PR #76 merged to `main`? | **Yes.** Merge commit `66c68e5` on 17 Oct 2026, “Atlas desk for Chief of staff…”. Production Vercel deployed the same minute (`seer-modern-eqqdgf5m7`). |
| Is Microsoft sign-in broken on production? | **No.** Production still has `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER` set (Production-only, for ~77 days). The missing “Sign in with Microsoft” button was a **preview** environment issue: those vars are not attached to Preview. The Chief of staff PR did not change login code. |
| Is the Chief of staff desk live? | **Code and schema are on production.** The staff tables exist (`bots` 8 rows, `bot_tasks` 27 rows). The optional bot webhook env vars are **not** set, so the bot must poll SQL rather than being poked. |

---

## 1. What Seer is and does

Seer is the mail client Conall uses at RDI. It is not a generic inbox clone. The product idea is: **the AI reads every conversation once, like a chief of staff, and files it**. Live work lands on a whiteboard called Atlas. Everything else is either kept as a record, or is safe to clear. Meaning (facts, contacts, “worth reading”) can be kept even when the email itself is thrown away.

Sign-in is restricted to `@rditrials.com` (plus a few extra addresses). Desktop lives at `/`. Phone lives at `/m`. Both open the same V3 workspace (`MailClient`).

### Main surfaces

Once signed in, you do not jump between many websites. You stay in one shell and switch **sections** (the URL hash remembers where you were).

| Place | What it is | How you use it |
|---|---|---|
| **Inbox** | Chronological mail | Open a thread, read, reply, archive, delete, move. |
| **Triage** | The “clear this” pile, sorted by Seer | Archive or delete in bulk; send live work onto Atlas. |
| **Cards** | One-at-a-time swipe deck of that pile | Fast yes/no on relevance; Archive / Delete buttons. |
| **Atlas** | The whiteboard of live work | Scan sections of matters; click a row to open the latest email. |
| **Delegated (new, PR #76)** | A band on Atlas for bots | Tasks owned by named bots, chat with Chief of staff, Approve/Reject mail proposals. |
| **Worth Reading** | Headlines under Atlas | Articles/reports the AI marked as worth your time. |
| **Sent / Trash** | Provider folders | Ordinary folder lists. |
| **Settings** | Accounts and Atlas setup | Connect Google/Microsoft mailboxes, reconnect, propose Atlas sections. |
| **Compose** | New mail / reply / forward | Toolbar and floating button. |
| `/brand` | Internal brand studio | Not the mail product. |
| `/dev/preview` | Fake mailbox for development | Hidden in production. |

### Atlas

Atlas is the living board of **matters** — units of work pulled from email (a pricing negotiation, a recruiting loop, a contract). Matters are grouped into **sections** (functions of the company). Each row shows a short title, who it is waiting on, and age. After two weeks without movement it is marked stalled. Outreach waiting on a reply is parked so it does not look like “yours” work.

**Click a matter → the latest real email opens in the shared reader.** Atlas is an index, not a second detail screen. You can drag rows to reorder. Archive from the reader (or related actions) sends the mail to the archive folder through the same safe queue as the rest of the app. There is no separate “delete this whole matter” button in the current UI.

### Email triage (your hands)

Triage is how **you** clear mail the AI has already judged:

- **Delete pile** — safe to trash (recoverable; never a permanent wipe).
- **Archive pile** — keep it out of the inbox.
- **Atlas pile** — this is live work; promote it onto the board.

Cards are the same pile, one conversation at a time. Swipe or keys mark “this still matters to me” vs “this never was / it ended.”

This is **your** triage. It is separate from the bot’s **proposed** triage (below).

### Tasks — three different things

People say “tasks” for three products that must not be mixed:

1. **Atlas matters** — email-derived work on the whiteboard (`seer.matters`). Clicking one always means mail.
2. **Bot tasks** — chores delegated to named bots (Chief of staff, SnaK-Bot, recruiter, etc.). Statuses: open, in progress, blocked, waiting on Conall, done, dropped. These live in `seer.bot_tasks`, **not** on the matter board, so a matter click never opens a bot chore by accident.
3. **Older leftover screens** (waiting / VIP / “all tasks” APIs) — still in the repo, not in the V3 navigation you use day to day.

### Chief of staff desk (PR #76)

An external bot cannot sign in through the website (Vercel’s SSO sits in front). It talks to Seer by **SQL** on the `seer` schema, and optionally by a **signed webhook** when you chat or edit a task.

On Atlas you get:

- A **Delegated** band: tasks grouped by bot, plus a strip of pending mail proposals.
- **Chat with Chief of staff** (general thread) and per-task comments/history.
- **Create a task** yourself.
- **Approve / Reject** on each proposal.

Proposal actions the bot may suggest:

| Proposal | If you Approve |
|---|---|
| Delete | Mail goes to Trash / Deleted Items (recoverable) |
| Archive | Mail is archived |
| Keep | Nothing moves; the suggestion is recorded |
| File | Mail is moved to a named folder |
| Filtered | Move if a folder is given; otherwise archive. Seer does **not** create a provider inbox rule. |

**Nothing moves until you approve it in Atlas.** Reject closes the suggestion with no mail change. The bot is not supposed to mark a proposal “approved” or “executed” itself.

Twenty-seven open tasks from `fixtures/bot_tasks.csv` are already in the production database.

### Typical day

1. Open Seer on desktop or phone → **Continue with Google** or **Continue with Microsoft** (production). Must be `@rditrials.com` (or an allowed extra address).
2. Land in Inbox. Background sync and AI reading keep filling in.
3. **Atlas:** see what is live; click into threads; reply; optionally work the Delegated band (tasks, chat, Approve/Reject).
4. **Triage / Cards:** clear the rest.
5. Settings if a mailbox needs reconnecting, or to reshape Atlas sections.

---

## 2. Architecture (how the machine is built)

### Frontend

- **Next.js 15** (App Router) and **React 19**, hosted on **Vercel**.
- One main client: `src/components/v3/MailClient.tsx`. Atlas is `src/components/v2/Atlas.tsx`. Staff UI is `StaffBoard` / `StaffPane`.
- Styling: Tailwind v4 plus a large skin file `src/app/seer-skin.css`.
- The signed-in product for allowed org emails **is** this V3 shell. An older inbox UI still exists as a fallback if the org gate ever failed.

### API and server logic

Writes from the current UI go through **one door**:

`POST /api/v2/commands` with a command object and an **idempotency key** (so a double-tap does not send mail twice).

Reads for the board and mailbox:

- `GET /api/v2/inbox` — Atlas / decisions projection
- `GET /api/v3/mailbox`, folders, conversations, search, attachments
- `GET /api/v2/staff` — delegated tasks, proposals, chat (PR #76)

A large set of **legacy** `/api/*` routes (old inbox, Gemini cron, Salesforce, iMessage, etc.) is still in the tree. The V3 UI does not use most of them.

### Database (Supabase / Postgres)

The app does **not** use the Supabase JavaScript client. The Next.js server connects with the `pg` driver as role **`seer_app`** (`SEER_V2_DATABASE_URL`). Schema **`seer`** is private: `anon` / `authenticated` are revoked, so the public Data API should not see this mail.

Live production snapshot (17 Oct 2026): ~74k conversations, ~164k messages, ~4.3k matters, ~53k AI decisions. Staff: 8 bots, 27 tasks, 0 chat messages, 0 pending proposals.

**Key tables and relationships**

```
seer.users
  └── seer.mail_accounts (google | microsoft)
        ├── seer.oauth_credentials          (encrypted tokens)
        ├── seer.conversations
        │     └── seer.messages
        ├── seer.conversation_decisions     (home: matter | record | delete)
        ├── seer.yields                     (worth_reading, facts, …)
        ├── seer.matters ←→ matter_conversations
        ├── seer.functions                  (Atlas section registry)
        ├── seer.outbox                     (queued mail moves)
        ├── seer.command_receipts           (idempotency)
        ├── seer.bot_tasks → bots, bot_task_events, bot_messages
        └── seer.triage_proposals
```

**RLS:** every `seer` table has RLS on. Policies for `seer_app` are `USING (true)` — the app role can see all accounts; **tenant isolation is in application SQL**, not in the database policy. The new `seer_bot` role may DML the staff tables and **SELECT** mail accounts, conversations, messages, and matters, also `USING (true)` (no per-account filter). That is the main security finding below.

### Auth and Microsoft login

- **Auth.js / NextAuth v5** (`src/auth.ts`).
- Google and Microsoft (Entra ID) providers are registered **only if** their env vars are present.
- The login page (`src/components/auth/AuthScreens.tsx`) hides a provider button when those vars are missing. That is why Preview had no Microsoft button: `AUTH_MICROSOFT_ENTRA_ID_*` (and Google, and `AUTH_SECRET`) are scoped to **Production** on Vercel, not Preview.
- Production has had the Microsoft vars for ~77 days. PR #76 did not touch `src/auth.ts`, middleware, or the login page.
- After OAuth, email must pass `src/lib/auth/org.ts` (`rditrials.com` plus extras). Tokens are stored encrypted in Postgres, not in the browser session.

**Production Microsoft login is therefore intact.** Preview will keep hiding the button until those env vars (and matching Entra redirect URIs for `*.vercel.app`) are added for Preview.

### Integrations

| System | Role |
|---|---|
| **Gmail API** | Sync, send, archive/trash, push via Pub/Sub |
| **Microsoft Graph** | Same for Outlook; push via Graph subscriptions |
| **Vercel AI Gateway** | Fast model (Gemini Flash Lite) then a stronger model (Claude Sonnet) when the read looks like live work or a risky delete |
| **Upstash Redis** | Used by **legacy** KV store, not the v2 mail corpus |
| **Bot webhook** (optional) | HMAC-signed POST when you chat or edit a task (`SEER_BOT_WEBHOOK_URL` / `_SECRET`) — **not configured** on Vercel today |
| Salesforce / iMessage / calendar | Legacy routes; not the V3 daily path |

### Background jobs

Vercel cron (`vercel.json`):

- every 5 minutes: `/api/v2/sync` (pull new mail, drain the outbox)
- every 5 minutes: `/api/v2/read` (AI classification queue)
- every 12 hours: `/api/cron/push-renew` (refresh Gmail watches / Graph subscriptions)

Push webhooks wake a mailbox immediately. Worker **leases** stop two crons from trampling the same account. Mail mutations are **optimistic**: the UI updates at once, a row in `seer.outbox` is drained to Gmail/Graph a moment later, with retries.

---

## 3. Core logic (how work actually happens)

### How mail gets in

1. On connect, Seer watches the inbox (Gmail Pub/Sub or Graph subscription).
2. A webhook or the 5-minute cron **syncs the inbox** (production default: inbox only, not Sent/Trash unless a flag is on).
3. First-time **backfill** pages history. If that is slow, a **head poll** still fetches the newest page so new mail is not stuck behind old mail. Signing in also kicks a 15-message catch-up if the inbox is stale.
4. Conversations and messages are upserted into Postgres. Then a **read queue** picks conversations the AI has not judged yet.

### How it is classified

One LLM call per conversation, on the **whole thread** plus a context packet (who you know, live matters, your mailbox habits). There is no keyword shortcut.

The model must pick a **home**:

- **matter** — live work with a counterparty (a real ask, a negotiation, something waiting on you). Time-sensitive noise is not a matter.
- **record** — keep it (invoice, signed contract, confirmation) but it is not live work.
- **delete** — meaning (if any) is already captured; the email itself is not needed.

Safety nets **after** the model:

- Personal-looking mail from a real person cannot be auto-deleted.
- A weak “this is a new matter” is demoted to record.
- An unsafe delete is demoted to record.
- **Salience** 0–3 is scored from “are you the owner, is there an obligation, VIP, addressed to you” — not from the model saying “urgent.”

A second pass **files** matters onto your function registry and writes short Atlas titles (2–6 words, never “Follow-up with Conall”).

The inbox API only **projects** those decisions. The React client does not re-sort mail into Atlas vs trash on its own.

### How Atlas matters appear

The AI promotes `home = matter` and links the conversation, or you promote from Triage. Archive from the UI archives the **conversations**, via the outbox. Marking something irrelevant because “it ended” can close the linked matter.

### How bot tasks and proposals appear

- **Seed:** 27 rows from CSV (already in production).
- **You:** `createBotTask` / update / comment / chat commands.
- **Bot:** SQL insert/update with `source = 'bot'`; it should append history events. Chat replies use `author = 'bot'`.
- **Proposals:** bot inserts `pending` only. You Approve → Seer runs trash/archive/move. File/filtered **needs a live mail provider** on the command (that part is wired). Plain `move` from the reader is a known hole (see issues).

Idempotency receipts and the outbox mean a retried Approve should not double-trash.

---

## 4. Quality and risk

### What is in good shape

- Mail corpus is in a private schema; production DB URL must be the `seer_app` role.
- OAuth tokens are encrypted at rest (`SEER_CREDENTIAL_KEY`).
- V3 writes check request origin and use idempotency keys.
- Outlook push checks a shared `clientState`; the bot webhook (when configured) uses HMAC + clock skew.
- Test suites (`npm test`, `test:v2`, `test:v3`) are large and cover schema, sync, outbox, staff commands, and Atlas UI contracts.
- No secrets committed in the repo (only `.env.example`).

### Top 10 issues (by severity)

| # | Severity | Issue | Where |
|---|----------|-------|-------|
| 1 | **Critical** | `seer_bot` RLS is `USING (true)` on staff tables **and** SELECT of all mail accounts, conversations, messages, and matters. Anyone with the bot DB role can read **every** mailbox in the project, and can `UPDATE triage_proposals` despite the contract saying “never approve yourself.” This is live in production. | `supabase/migrations/20261016220000_bot_staff.sql` (policies ~L189–227); live policies on `lnbatmukzwbnmrepceol` |
| 2 | **High** | Gmail push webhook has **no** signature, OIDC, or shared-secret check. A crafted POST with a known mailbox email can wake sync for that account. Outlook webhooks *are* authenticated. | `src/app/api/webhooks/gmail/route.ts` |
| 3 | **High** | Reader **Move** never gets a mail provider. `needsProvider` lists send/reply/forward/decideTriageProposal but not `move`, while `execute.ts` requires `ctx.provider` for `move`. File-via-proposal still works (it uses `decideTriageProposal`). | `src/app/api/v2/commands/route.ts`; `src/lib/v2/commands/execute.ts`; `src/components/v3/ReaderPane.tsx` |
| 4 | **High** | Dozens of **legacy** write APIs (`/api/send`, `/api/action`, …) skip the origin check that v2/v3 have. If an old screen is still reachable with a session cookie, CSRF defense is weaker. | `src/app/api/action/route.ts`, `src/app/api/send/route.ts`, and other non-v2/v3 routes; origin helper only used in five v2/v3 files |
| 5 | **High** | Preview (and any non-Production deploy) has **no** OAuth env vars. Microsoft (and Google) buttons disappear. Entra redirect URIs also would need preview hosts. This is ops, not a code bug, but it is how the “Microsoft vanished on preview” report happened. | Vercel env targets; `src/auth.ts`; `src/components/auth/AuthScreens.tsx` |
| 6 | **High** | Chief of staff **schema and seed are already on production**, while the original contract said “preview only” and the bot webhook is unset. Atlas will show Delegated tasks; the bot has no wake hook. Cutover is half-done. | Supabase migration `bot_staff`; 27 `bot_tasks`; Vercel env has no `SEER_BOT_WEBHOOK_*` |
| 7 | **Medium** | `seer_app` RLS is also `USING (true)`. A single buggy query or a leaked app password is all mailboxes. Defense is “the server always filters by account_id,” which is true in the code we sampled, but the database will not save you. | Core grants in `supabase/migrations/20260811234500_v3_final_review.sql`; repeated on later tables |
| 8 | **Medium** | BlueBubbles (iMessage) password stored **plaintext** in the legacy KV store, unlike OAuth tokens. | `src/lib/imessage/bluebubbles.ts` |
| 9 | **Medium** | Dual stacks: legacy `src/lib/mail/*` + old `/api/*` + old Settings panel vs v2 providers + V3 UI. Drift (legacy Settings always offers Microsoft even if env is missing). Root `README.md` is still create-next-app boilerplate. | `src/app/page.tsx` fallback; `src/components/inbox/SettingsPanel.tsx`; `README.md` |
| 10 | **Medium** | Scale and cost: `seer.events` is already ~3.4 million rows; `MailClient.tsx` is ~1,200 lines; AI spend is gated by daily budgets but a stuck read queue is expensive. Embedded-Postgres tests can flake on shutdown (`57P01`). | Live table counts; `src/components/v3/MailClient.tsx`; `src/lib/v2/intelligence/model-usage.ts` |

Other notes: owner Gmail is hardcoded in `src/lib/auth/org.ts` (this repo is public). Staff webhook is well designed but optional. Function `seer.touch_bot_task_updated_at` has a mutable `search_path` (Supabase security advisor, warning). There is almost no live test that the Gmail webhook is authenticated, that `needsProvider` includes `move`, or that `seer_bot` cannot read another account’s mail.

---

## 5. Recommendations (priority order)

1. **Tighten `seer_bot` before treating the bot as production-trusted.** Scope SELECT/DML to one account (or a dedicated bot login per mailbox). Forbid `UPDATE` of `triage_proposals.status` to `approved`/`executed` in the database, not only in a markdown contract. Rotate any bot credential that was issued with the current open policy.
2. **Authenticate the Gmail Pub/Sub push** the way Outlook already authenticates (OIDC token from Google, or a shared secret on the subscription). Until then, treat the URL as sensitive.
3. **Add `"move"` to `needsProvider`** (or stop offering Move in the reader). One-line bug; currently Move fails closed with “provider unavailable.”
4. **Finish Chief of staff cutover as an explicit ops checklist:** confirm which mailbox owns the 27 tasks; set webhook env on Production *or* document polling; decide Preview OAuth (copy `AUTH_*` to Preview + register redirect URIs) so preview logins match production.
5. **Retire or freeze the legacy `/api/*` write surface** (or put the same origin check on every session write). Dual clients will keep creating “fixed in V3, still open in V2” bugs.
6. **Per-account RLS for `seer_app`** is a larger project, but worth it before a second human user or a second engineer shares the DB URL. Today three mail accounts share one open app role.
7. **Encrypt or drop BlueBubbles passwords**; move `OWNER_EMAIL` out of git into `SEER_ALLOWED_EMAILS`.
8. **Replace the root README** with a short product + runbook pointer (`docs/` already has the real story).
9. **Watch `seer.events` growth** (~3.4M rows). Add retention before it becomes the expensive table.
10. **Add three tests that would have caught this review’s highs:** Gmail webhook rejects unsigned POSTs; `needsProvider("move")`; `seer_bot` cannot `select` another account’s `messages`.

---

## Engineer appendix

### A. Status of PR #76 and Microsoft login

- **Merged:** https://github.com/RDIconall/seer-modern/pull/76 — merge commit `66c68e511d8b187a742bafca9dffc4bf78d98e22` (parents: `827a64b` on `main`, `ecbb580` on the feature branch).
- **Production deploy:** Vercel `dpl_GppXiKMmdTgf1qnAg8Jv88KbhfsG`, created 17 Oct 2026 00:03:27 UTC, aliases `seer-modern.vercel.app` and `seer-modern-git-main-rditrials.vercel.app`.
- **Auth diff in that PR:** none, except comments in `.env.example` for `SEER_BOT_WEBHOOK_*`. Login button gate:

```13:17:src/components/auth/AuthScreens.tsx
const google =
  Boolean(process.env.AUTH_GOOGLE_ID) && Boolean(process.env.AUTH_GOOGLE_SECRET);
const microsoft =
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);
```

- **Vercel env (project `seer-modern`):** `AUTH_MICROSOFT_ENTRA_ID_ID`, `_SECRET`, `_ISSUER`, `AUTH_GOOGLE_*`, `AUTH_SECRET`, `AUTH_URL` → **Production only**. Preview cannot render either provider button.
- **Fix for Preview (ops, not this PR):** attach those vars to Preview (and Development if needed); add the preview callback `https://<preview-host>/api/auth/callback/microsoft-entra-id` in the Entra app. Do not expect Preview to show Microsoft until both are done.

### B. Runtime map

```
MailClient / Atlas / StaffBoard
    │  GET /api/v2/inbox, /api/v3/mailbox, /api/v2/staff
    │  POST /api/v2/commands
    ▼
executeCommand (idempotency via seer.command_receipts)
    ├── mail mutate → seer.outbox → drainOutbox → GmailProvider / OutlookProvider
    ├── send/reply/forward → provider immediately (receipt reserved first)
    └── staff → src/lib/v2/staff/commands.ts
            └── decideTriageProposal → trash/archive outbox or provider.moveConversation
    ▼
Postgres seer.* as seer_app
    ▲
cron /api/v2/sync, /api/v2/read, /api/cron/push-renew
webhooks /api/webhooks/gmail (unauthenticated), /api/webhooks/outlook (clientState)
AI Gateway  (CHIEF_OF_STAFF_SYSTEM in src/lib/v2/intelligence/model.ts)
```

Entry: `src/app/page.tsx`, `src/app/m/page.tsx`. Session → account: `src/lib/v2/session.ts`. Pool: `src/lib/v2/db/pool.ts` (rejects non-`seer_app` URLs in production).

### C. Classification pipeline (files)

| Step | File |
|---|---|
| Sync page | `src/lib/v2/sync/engine.ts`, `providers/gmail.ts`, `providers/outlook.ts` |
| Catch-up | `src/lib/v2/sync/catch-up.ts` |
| Wake | `src/lib/v2/sync/wake-account.ts` |
| Queue | `src/lib/v2/intelligence/queue.ts`, `read-tick.ts`, `read-batch.ts` |
| Prompt + router | `src/lib/v2/intelligence/model.ts` (`CHIEF_OF_STAFF_SYSTEM`, `MODEL_VERSION` `v2-read-3-strict-three-way` in `schema.ts`) |
| Safety | `safety.ts`, `human-correspondence.ts`, `salience.ts` |
| Persist | `reader.ts` → `ensureMatter`, `saveDecision` |
| File + name | `file-matters.ts`, `matter-namer.ts` |
| Project UI | `src/lib/v2/view/build.ts` |

### D. Staff contract vs live DB

Contract: `docs/bot-integration-contract.md`.  
Migration: `supabase/migrations/20261016220000_bot_staff.sql` — applied on production as version `20261016234409` / name `bot_staff`.

Live policies sampled:

- `seer_bot_bot_tasks` / `seer_bot_triage_proposals`: `FOR ALL USING (true)`
- `seer_bot_messages_select` / `seer_bot_mail_accounts_select`: `FOR SELECT USING (true)`

`seer_bot` is created `NOLOGIN` in SQL; a login role must be `GRANT`ed it. If the bot connector uses `service_role`, RLS is bypassed entirely.

Webhook implementation (good): `src/lib/v2/staff/webhook.ts` (`sha256=` HMAC of `timestamp.body`, `timingSafeEqual`). Env vars **absent** on Vercel as of this review.

### E. Test inventory

- `package.json` `test` — 6 scripts (merge, triage view, send, export, …)
- `test:v2` — schema through operating-model **plus** `v2-staff-{schema,seed,webhook,commands}`
- `test:v3` — mailbox, outbox, Atlas UI, `atlas-staff-ui`, compose, org-access, …

Gaps called out in §4. First v2 run in a recent agent session died on embedded Postgres shutdown (`57P01`); a rerun was green — treat as flake, not a product bug.

### F. Production data (non-secret)

Supabase `lnbatmukzwbnmrepceol`, schema `seer`, RLS enabled on all listed tables. Notable counts: `conversations` 74147, `messages` 163910, `matters` 4252, `conversation_decisions` 52969, `events` 3437417, `bots` 8, `bot_tasks` 27, `operating_models` 0 (functions registry still has 72 rows — filing uses `seer.functions`). Security advisor: one warning, `seer.touch_bot_task_updated_at` mutable `search_path`.

### G. File map

```
src/app/page.tsx, m/page.tsx, middleware.ts, auth.ts
src/app/api/v2/commands/route.ts, staff/route.ts, sync/route.ts, read/route.ts, inbox/route.ts
src/app/api/v3/mailbox, outbox/*, conversations/[id]
src/app/api/webhooks/gmail/route.ts, outlook/route.ts
src/components/v3/MailClient.tsx, Settings.tsx, ReaderPane.tsx, TriageCards.tsx
src/components/v2/Atlas.tsx, StaffBoard.tsx, StaffPane.tsx, WorthReading.tsx, useStaffView.ts
src/lib/v2/commands/{types,execute,repository}.ts
src/lib/v2/staff/{types,commands,repository,webhook,seed}.ts
src/lib/v2/intelligence/{model,reader,safety,salience,file-matters,matter-namer}.ts
src/lib/v3/outbox/{drain,repository,optimistic}.ts
src/lib/auth/org.ts
supabase/migrations/*.sql
docs/bot-integration-contract.md
docs/atlas-product-status.md
```

---

*This document is a review of `main` as of 17 Oct 2026. It does not authorize schema or env changes.*
