# Atlas / Seer — Living Product Status

This is the source of truth for what was asked, what is built, and what is
left. It is keyed to the product owner's own words (section numbers refer
to `seer-thread.md` on `main`). Update it on every change: move rows to
Built only when the code is deployed and verified, and add a dated line to
the changelog at the bottom.

Legend: ✅ built & deployed · ⚠️ partial (note what's missing) · ❌ not built.

---

## The standing UX bar (non-negotiable)

Hold this on every screen before shipping. A screen that violates any of
these is not done, regardless of the logic behind it.

1. **Never truncate the primary object.** A matter title, a person's name,
   the ask — these wrap or clamp to two lines. One-line `truncate` on the
   thing the screen is about is a bug.
2. **Real tap targets.** Anything tappable is ≥ 44px. No 12px text links
   doing the job of a button.
3. **One hierarchy per screen.** The most important thing is visually the
   biggest/first. No stack of identical gray paragraphs.
4. **The screen earns its space.** No half-empty viewport next to
   truncated content. Density comes from content, not from cramming.
5. **Actions, not narration.** The AI's suggestion is a thing you can do,
   not a sentence describing what you could do.
6. **Recency is always present.** A row you might act on shows its time.
7. **One typeface (National 2), two weights (400/700), three sizes
   (12/14/17).** No synthetic 600. No eyebrow micro-caps. No self-narration
   ("Seer suggests…", confidence scores, rule ids).

---

## Atlas — turn the whole inbox into a living corpus (§18, §20, §21)

| Ask (their words) | Status |
|---|---|
| "Classify the entire inbox into the org format… treat the inbox as a living corpus and I can see its entirety every time" | ✅ Deep read per email, filed into the function registry; coverage reconciled against the provider's own count. `matters.ts`, `AtlasBoard.tsx` |
| "How do I know this is the full inbox?" → accounted-vs-provider header | ✅ One line: "All N placed" / "N not read yet". `AtlasBoard.tsx` |
| "Remove the people/urgency/update filters… one level, don't make me click too much" | ✅ CEO whiteboard: function columns, bare matter names, no filters. `AtlasBoard.tsx` |
| "You dumped 377 emails into operations — add a Salesforce lookup to pull codes" | ✅ Branches by study code / counterparty; CRM amounts on rows. Salesforce connected. |
| "Click into a matter → feel like Pivotal Tracker: goal, next action…" | ✅ `MatterPanel`: next move leads, then state / goal / CRM / people. |
| "…and what does AI suggest to do (or not do) with this email" | ✅ Restored — per-conversation suggestion renders on each row in `MatterPanel`. |

## Triage — delete and close, nothing else (§10, §18, §20)

**The rule:** Triage holds exactly two kinds of thing — mail to **delete** and
work to **close**. Anything with live work in it is already a matter in Atlas.
Triage never asks "should this be a matter?"; that question is the app refusing
to do its own job.

| Ask | Status |
|---|---|
| "It should show me emails to delete, matters or emails to close" | ✅ Two sections, two verbs. Delete trashes; Close archives a record or settles a matter. `TriageDigest.tsx` |
| "Everything else should already be a matter" | ✅ A deep read with `disposition: "matter"` is promoted into a real matter during the brief build (`matterFromRead`). "Possible matters" is gone — there is nothing to approve. |
| "AI creates a brief of the FYI / read-and-delete mass so I don't deal with each one" | ✅ Digest categories in business vocabulary, one sentence each, chunked 60 at a time so a large inbox actually gets categories instead of one "Inbox updates" bucket. A failed chunk falls back to sender grouping, never to a fake summary. |
| Matter closure | ✅ `looks-closed` matters appear in Triage's Close out list with the evidence and a one-tap Close, as well as inside the matter panel. |

## The brain — read everything, think in units (§14, §15, §17, §24)

| Ask | Status |
|---|---|
| "Why keywords at all? Send everything for full meaning up front" | ⚠️ Deep read decides every email's fate; sender-shape delete rule dead. **Grader still runs in cron** (`classifyInboxWithAssistant` in `cron/sync`) to annotate `guide` text; nothing load-bearing depends on it. Full removal pending. |
| "It's a state of what's going on in the work life" | ✅ Matters carry narrative / owner / urgency, carried day to day. |
| "Smart summaries by tracking all the matters left in my inbox" | ⚠️ Clustering + memory built. **The forecast lens (Now/Next/Waiting/At risk/Quiet) is computed on every brief but rendered nowhere.** |
| "The Abbott one — matters aren't getting threaded" | ✅ One concern = one matter; conversations under it. Covered by `mergeMatters` test. |
| Context-full prompts ("Sandy is a board member, we just had a board meeting") | ✅ Context compiler feeds each read relationship / calendar / likely matter / CRM / behavior, with provenance. `brain/context.ts` |
| "No reason to limit matters per person" | ✅ 14-matter prompt ceiling removed; chunking is cost-only. |

## Mechanics (§13, §22, §23)

| Ask | Status |
|---|---|
| "Archive from Atlas should close the thread" | ✅ Thread-wide. Matter **settle/close now writes a durable closure record** (no resurrection) and archives every thread; reopen restores. Row-level archive still archives without a closure record (correct — a single row isn't a matter closure). |
| "Rename matters and create my own" | ✅ Survive every rebuild. |
| "App checks my email for me… summarize new since I last opened" | ✅ 5-min cron + catch-up card. |
| "Make it push" | ❌ Background sync yes; no push notifications. |
| Salesforce connection | ✅ Live. Write-back handoff ❌ (handoff recorded locally only). |
| Timeglass / files / notes ("also key to the brain") | ❌ `WorkSignalAdapter` seam built; no connector. Needs Timeglass MCP/API + Drive scopes. |

## Beyond the original asks (built along the way)

| Item | Status |
|---|---|
| Supabase Postgres as system of record | ✅ Primary store; Redis dual-write + read-through backfill; RLS-locked; verified via `/api/health?probe=storage`. |
| Model-budget failover + honest error banner | ✅ Direct key → AI Gateway on quota/billing; brief carries a human `clusterError`. |
| Contact autocomplete in compose | ✅ `/api/contacts` ranks address book + person graph + mail graph. |
| Send hardening | ✅ Bookkeeping no longer gates delivery; storage calls time-bounded; client reports real failures. |
| Cleaned ledger + undo + reason-level autonomy ladder | ⚠️ APIs + stores built (`triage-ledger`, `autonomy`, `/api/triage/*`); **no ledger UI panel yet.** |
| Shared inbox accounting dashboard | ✅ Same server-computed object renders in Atlas and Triage: as-of timestamp, provider total, messages mapped to matters by function category, Triage count, and pending shortfall. Invariant: total = Atlas + Triage + pending. |

---

## Open, in priority order

1. **Render the forecast lens** — Now / Next / Waiting / At risk / Quiet as the top layer of Atlas. (Data done; UI missing.)
2. **Cleaned ledger panel** — surface `/api/triage/ledger` with one-tap undo. (API done; UI missing.)
3. **Retire the snippet grader** from `cron/sync` and delete the dead classifier path once the reader/AssistBar no longer read `guide`.
4. **Timeglass connector** — behind `WorkSignalAdapter`; lights up the liveness line and "quiet but alive". Needs credentials.
5. **Drive / SharePoint file signals** — same seam; needs OAuth scopes.
6. **Salesforce write-back** for matter handoff (activity/note on the opportunity).
7. **Push notifications** for the "since you last opened" catch-up.

---

## Reading pane

One action row, then the message. Reply is the only labelled button; reply
all, forward, archive and delete are icons; everything secondary — draft a
reply, delegate, block time, unsubscribe, and correcting a wrong call — is in
a single overflow menu. Sender name, address and time sit on one line. The
canned "Say yes / Decline / Buy time" replies are gone, and Archive/Delete no
longer appear twice.

## Auditing what the app did

`GET /api/export/inbox` returns a CSV of every conversation and where it
landed — placement (Atlas matter / Triage close out / Triage delete), the
matter or category name, function, org unit, the one-line read, next action,
the deep read's verdict, message count and thread id. `?format=json` returns
the same rows plus the accounting object. Linked as "Export CSV" from the
inbox dashboard in both Atlas and Triage.

## CEO issue pass (GitHub #10–#15)

- **#10 Fonts:** matter names are content, so they render Regular 400; only
  true headings (function columns, section titles) stay Bold 700.
- **#11 Dashboard tile:** the always-on inbox stats tile is gone
  (`InboxDashboard` deleted). The CSV export moved to a small link in the
  Atlas top strip and the Triage header.
- **#12 Catch-up:** the "while you were away" bar is collapsed to one icon in
  the Atlas top strip; it opens a popover on demand (`CatchupCard` deleted,
  folded into `AtlasBoard`).
- **#13 Settled:** the Settled column is gone. Settling a matter archives its
  conversations and closes it (already the server behaviour) — no parking lot.
- **#14 Reader = Outlook:** the reader shows sender, recipients, subject, body
  and a toolbar (reply / reply all / forward / archive / delete) that calls the
  same provider actions. The Seer "The ask" callout and lifted-link chips — the
  interim panel above the message — are removed; attachments and calendar RSVP
  (both native to Outlook) stay.
- **#15 Triage table:** Triage is a table, one row per conversation, each with
  its own Archive and Delete (optimistic, undoable). Finished matters sit above
  it as one-tap Close rows.

## Export columns

The inbox export (`/api/export/inbox`) carries the native provider fields on
every row — matters, records, and the Triage delete list alike: **From name**,
**From email**, and **Subject**, alongside Seer's own read (the one-line
summary, the deep-read disposition, placement, function, message count). The
brief now persists those native fields on filed rows, digest items, and matter
conversations, so the export stays snapshot-based and never calls the provider.

## Triage table (#16)

Rows are grouped by category, each group has bulk **Archive all / Delete all**
over the whole category, and every row keeps its own Archive and Delete. No
grey text anywhere — every cell reads at foreground strength, which is what
makes a table scannable. Columns: From, Subject, When, Actions.

## CEO issue pass 2 (GitHub #17–#21)

- **#17 Counts:** the Atlas top strip has a counts icon opening a small table —
  Inbox / On the board / In Triage, each in **conversations and messages**.
- **#18 / #20 From:** the Triage table now has distinct **From**, **Subject**,
  and **Seer's read** columns. The native sender and subject come straight from
  the provider (persisted on filed rows and digest items), no longer blended
  with the AI summary. Blank From was stale data — the brief now carries the
  native fields, filled on rebuild.
- **#19 Columns:** the table is `table-fixed` with even spacing and drag-to-
  resize handles on every column edge.
- **#21 Smarter triage:** inside each category the deep read splits rows into
  **Needs a call · maybe a matter** and **Safe to delete**, each with its own
  bulk action, on top of per-row Archive/Delete.

## The relationship floor

The context compiler tells the model who a sender is (VIP, tier, reply
behavior, saved contact, shared meetings, CRM). That is advice. The floor is
law: `knownSenders` (`src/lib/brain/relationships.ts`) is a deterministic set —
VIP, inner/known tier, anyone the user has written to, anyone in the saved
address book — enforced in `buildBrief`. A known sender's mail can never enter
the bulk delete list; it lands in Triage's review bucket, still one deliberate
tap to delete. The export shows the flag in a "Known sender" column so the
enforcement is auditable.

## Changelog

- 2026-08-09 — Relationship floor: known senders (VIP / written-to / saved
  contact / inner-known tier) are excluded from bulk delete in code, not just
  in the prompt; Triage buckets them under review; export gains a
  "Known sender" column.

- 2026-08-09 — Export gains native From name / From email / Subject on every
  row (the triage gap the CEO flagged); brief persists these fields. Triage
  table grouped by category with bulk-by-category actions and all-black text
  (#16).

- 2026-08-09 — One row, one home: a conversation owned by a matter can no
  longer also appear in Triage. The digest is decided per message, so a thread
  carrying live work plus one FYI reply was rendering in both places (the
  accounting deduped, the screen did not). Added the inbox export.

- 2026-08-09 — Fixed sending on Outlook. Microsoft answers `sendMail`, `reply`
  and `replyAll` with **202 Accepted and no body**; the Graph client called
  `res.json()` on that, threw "Unexpected end of JSON input", and the route
  reported a failure for mail Microsoft had already accepted. Both mail clients
  now treat an empty 2xx as success, and the recipient picker's trailing comma
  is stripped before it becomes an empty address.

- 2026-08-09 — Reading pane rebuilt: duplicate Archive/Delete removed, canned
  replies deleted, secondary actions collapsed into one overflow menu, header
  reduced from four stacked blocks to two lines. Triage clears optimistically.
  Unknown codes (raw PO numbers) no longer fragment a vendor's mail, and
  automated senders collapse into one matter per company.

- 2026-08-09 — Triage reduced to its two real verbs. Reads that name work are
  promoted to matters automatically instead of waiting behind a "Make matter"
  button; Delete now trashes rather than archives; the digest is chunked so it
  stops collapsing two thirds of the inbox into one meaningless theme.
- 2026-08-09 — Rebuilt the matter panel and board rows mobile-first (no
  truncation of titles/asks, 44px targets, next-move-first hierarchy).
  Rebuilt Triage on the deep-read brain (digest themes + matter promotion),
  deleted the legacy `TriageTable`. Integrated the CEO whiteboard
  (`AtlasBoard`/`MatterPanel`), collapsed the duplicate settled store into
  `closed-matters`, removed the 14-matter ceiling, added Postgres storage,
  model failover, contact autocomplete, and send hardening.
- 2026-08-09 — Added the shared Atlas/Triage inbox dashboard with the
  provider-total accounting invariant and category counts. Triage now includes
  records-to-file, digest themes, and matter promotion; matter panels surface
  evidence-backed closure proposals.
- 2026-08-10 — Began the clean-slate v2 architecture (`src/lib/v2`, `src/app/api/v2`,
  `src/components/v2`) behind `SEER_V2_ACCOUNT_ALLOWLIST`. One context-rich
  decision per conversation with veto-only delete safety; chief-of-staff yields
  keep business meaning before an email is deleted; one shared Gmail/Outlook
  provider contract; normalized Supabase schema with encrypted credentials; one
  server inbox projection with render-only UI; idempotent command bus; and a
  read-only shadow gate that blocks cutover on any false safe-delete, coverage
  gap, parity failure, or provider mutation. Spec:
  `docs/superpowers/specs/2026-08-09-seer-clean-slate-design.md`; plan:
  `docs/superpowers/plans/2026-08-10-seer-clean-slate-implementation.md`.
  Legacy pipeline still runs until an account passes the shadow gate.
