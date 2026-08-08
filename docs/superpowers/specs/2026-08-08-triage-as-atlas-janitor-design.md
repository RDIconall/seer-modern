# Triage, reimagined: the janitor for Atlas

Date: 2026-08-08
Status: subsystem design — incorporated into
`2026-08-08-seer-brain-atlas-architecture.md`

## Reframing

Atlas is the app. Matters are its top-level unit — one real-world concern
explaining why a group of conversations is still in the inbox. Triage is
not a destination, a tab, or a peer view: it is a **function on top of
Atlas** with exactly two jobs:

1. **Clear what was never a matter** — spam, junk, promos, inert notices,
   the disposable mass a good filter or a real assistant would remove
   before the user ever saw it.
2. **Detect what has stopped being a matter** — mail that is stale, or
   evidence of a matter whose story has ended (goal reached, counterparty
   gone quiet, work concluded) whose conversations are now records, not
   open work.

Everything Triage removes is one of those two things. Everything else
belongs to Atlas.

The anchoring insight (from the inbox review that started this work): for
most of the inbox, **"kept" just means "never triaged" — and that is
itself the finding.** ~130 of 170 messages were machine-generated noise
no one had ever cleared. Triage's job is to make "kept" mean "kept for a
reason" again.

## Why the current triage fails (audit, 2026-08-08)

It fails on aggressiveness, timidity, reasons, and consistency at once,
and the root causes are structural:

1. **Two brains, and the wrong one decides.** The snippet-grader
   (`classifyInboxWithAssistant`, prompt v24) assigns `guide.action`; the
   deep read (`Understanding`) reads full bodies. The matter-vs-digest
   partition — the core triage decision — is made by the snippet-grader
   (`DIGEST_ACTIONS` filter on `guide.action` in `matters.ts`). An email
   whose deep read says "Sign the CDA" can land in the disposable digest
   because the snippet-grader said `read_and_delete`.
2. **The grader doesn't grade everything.** 4 batches × 40 emails with a
   30-second budget per load, on an inbox scanned 1200 deep. Overflow
   falls to keyword rules whose uncached verdicts still partition the
   digest.
3. **User actions barely teach.** Only single-item `/api/action` records
   anything (sender-level archive-vs-trash counts). Bulk sweeps, the
   legacy `/api/archive` and `/api/delete` routes, and — most damaging —
   **archiving a whole matter** teach nothing. No closure memory exists,
   so rebuilds resurrect finished matters.
4. **Nothing detects staleness or closure.** Matters carry `goal`,
   `owner`, `updatedAt`; no code ever asks whether the goal was reached,
   whether `owner: "them"` has sat silent for weeks, or whether mail
   stopped. Urgency decay exists only for keyword-expiring items.
5. **Inconsistency is built in.** Two engines disagree per email; the
   decision cache expires after 3 days; label eras and prompt bumps flip
   verdicts between loads; rules-fallback verdicts differ from what the
   model would have said.

## Design

### 1. One brain: the understanding record is the only judge

The deep read (already: one read per email, cached forever, backlog
drains via cron, `unread` count surfaced in Atlas) becomes the **sole
source of triage judgment**. The snippet-grader is retired from the sync
pipeline.

- `Understanding` gains two fields (bump `UNDERSTANDING_VERSION` → 2):
  - `disposition: "matter" | "record" | "fyi" | "disposable"` — the
    read's own verdict on what this email is *for*. `matter` = evidence
    of ongoing work; `record` = keep, findable later (receipt, executed
    contract, statement); `fyi` = worth one glance, then gone;
    `disposable` = never needed eyes.
  - `expires?: string` (ISO date) — when the email's relevance dies on
    its own (delivery window, event date, check-in, code). Set only when
    the body states or implies one.
- The matter/filed/digest partition in `buildBrief` keys off
  `disposition` (with `importance` and `ask` as tie-breakers), never
  `guide.action`.
- **Not read yet = not triaged yet.** An unread email is never
  rules-guessed into the digest; it stays visible as unread. Atlas
  already says "N still being read" — that stays the honest state.
- Deterministic layers survive only as **facts and floors**, applied to
  the read's verdict, not competing with it: codes/amounts/dates
  extraction, self-sent and already-replied detection, calendar-invite
  state, the person-protect and VIP floors, taught sender overrides, and
  urgency expiry (now driven by `expires`, not keyword regexes).
- The 9-action `TriageAction` taxonomy stops driving the pipeline.
  Migration: `guide` remains as a derived presentation shim
  (`disposition` → suggestion text) until the reader/AssistBar surfaces
  are moved over, then the grader path is deleted.

### 2. The noise sweep (job 1)

- The digest is composed of `disposition: "disposable" | "fyi"`
  conversations, grouped into themes as today.
- A **sweep slate** replaces the Triage tab: one screen, grouped by
  reason ("Expired on its own · 14", "Senders you always delete · 9",
  "Marketing, importance 0 · 31"), each row showing the read's one-line
  meaning, one confirm to execute. Rows are individually un-tickable —
  exactly the checkbox model the old TriageTable proved out.
- Records (`disposition: "record"`) are never swept to trash — they
  archive.

**Protected classes (the `bulk-delete` lesson).** A keyword `bulk-delete`
rule currently live on `main` has nuked real, consequential mail —
Qualio approval requests, IRB/regulatory notices, SharePoint/document
comments, DMV and government renewals. No sweep (proposed or auto) may
touch a conversation whose read carries any of:
- `owner: "you"` or a non-informational `ask`
- `signature` present
- an approval / regulatory / government / legal-deadline `kind`
- a person-protected or VIP sender (existing floors)
- membership in any matter

These are hard floors evaluated after the disposition, before the slate
is built. A protected email that a reason would have swept is instead
left in Atlas, not silently binned. This is the single most important
guard against the "too aggressive" failure.

### 3. Closure detection (job 2 — new capability)

- The matters pass gains a per-matter duty: for every previous matter
  carried forward, emit
  `status: "active" | "waiting" | "looks-closed" | "dormant"` with a
  one-line `statusWhy`, judged from the new evidence ("the executed SOW
  went back to Roche June 3 — the goal is met").
- Lifecycle is event-driven, not timer-driven. Closure evidence includes:
  - a later message superseding or completing the work
  - the matter's goal being met
  - an authoritative system-of-record state (for example Salesforce
    Closed Won/Lost, or a completed/terminated study)
  - every conversation's `ask` answered or `expires` passed
- Silence alone can raise a soft review flag but never a closure
  proposal. A live/open system-of-record object or recent file, note, or
  Timeglass activity protects a long-tail matter as **quiet but alive**.
- Atlas shows closure proposals inline on the matter: *"Looks closed —
  the executed copy went back June 3. Archive its 12 conversations?"*
  Accepting archives every thread (existing thread-aware actions) and
  writes a **closure record**.
- **Closure records** (`closed-matters` store): `{ matterId, titleTokens,
  closedAt, reason, by: "user" | "auto" }`. Rebuilds must not resurrect a
  closed matter: the clustering payload carries closed matters as
  negative examples, and the merge step drops any output matter whose
  identity (id or title tokens) matches a closure — unless it cites mail
  **newer than `closedAt`**, in which case it surfaces explicitly as
  *"Reopened: <title>"*. Reopening is a feature, not a bug; silent
  resurrection is the bug.
- Matter closures are **never auto-executed in v1**. This is where being
  wrong costs real work.

### 4. The learning ledger: every action teaches at its level

| Action | What is recorded | What it teaches |
|---|---|---|
| Archive/close a matter | Closure record + exemplar | This concern is done; don't rebuild it |
| Delete/archive one row deliberately | Sender prior (existing `action-memory`) | This sender's default fate |
| Confirm a sweep slate | Per-**reason** acceptance count | This *category* of sweep is trustworthy |
| Untick a row before confirming | Strong negative on that reason + sender | The gate was too wide |
| Undo from the ledger | Reversal on that reason; sender prior decremented | Immediate correction signal |
| Reject a closure proposal | Matter marked `active` for N days; proposal suppressed | The story isn't over |

Bulk confirms still never write sender-level priors (the American
Airlines lesson stands) — they write **reason-level** trust instead.

- **The ledger** (`triage-ledger` store): append-only, most recent ~500
  entries, each `{ at, kind, scope, ids, threadIds, reason, source:
  "auto" | "confirmed" | "manual", undone? }`.
- **Ledger UI**: a "Cleaned" panel in Atlas listing everything Triage did
  (auto or confirmed), with one-tap undo. Undo restores the mail
  (un-archive/un-trash via the provider) and records the reversal.

### 5. The autonomy ladder: earning C

The target is a true spam-filter experience — Triage acts alone. It gets
there per-category, by evidence:

- An `autonomy` store maps each sweep reason to
  `{ mode: "propose" | "auto", accepted, reversed }`.
- **Start narrow.** Ships with `auto` for exactly three reasons:
  expired-by-date (`expires` passed), learned senders (existing 3+
  consistent actions), and organizer-side RSVP receipts ("Accepted:
  Standup" — deterministic, zero-information). Everything else starts as
  `propose`.
- **Promotion**: a reason flips to `auto` after ≥ 20 accepted proposals
  with < 2% reversals.
- **Demotion**: 2 reversals within the trailing 20 auto-actions flips it
  back to `propose`. Demotion is instant; promotion is slow.
- Auto-actions are archives by default; only reasons whose accepted
  proposals were deletions graduate to deleting.
- Matter closure is outside the ladder in v1 (always propose).

### 6. Surfaces

Atlas remains the only app. Triage manifests as exactly three things:

1. The **sweep slate** (proposals needing one confirm)
2. **Closure proposals** inline on matters
3. The **Cleaned ledger** (what happened, with undo)

The standalone Triage tab and `TriageTable` retire once the slate ships.
`/api/today`'s section-building output and the `cards` deck are no longer
load-bearing and follow the grader out.

## Data model changes

- `Understanding` v2: `disposition`, `expires`
- New stores: `closed-matters`, `triage-ledger`, `autonomy`
- `Matter` gains `status?: "active" | "waiting" | "looks-closed" |
  "dormant"` and `statusWhy?: string`
- `Brief` gains the slate:
  `sweep?: { reason: string; mode: "propose" | "auto"; rows: { emailId:
  string; threadId: string; line: string; disposal: "archive" | "trash";
  messageIds?: string[] }[] }[]` — and drops nothing yet;
  `headlines`/`headlineIds` stay for client parity until the slate ships

## What gets deleted (end state)

- `classifyInboxWithAssistant` call from `cron/sync` (and eventually the
  whole snippet-grader path: decision cache, label eras, prompt-version
  bumps, rules-vs-model precedence)
- `DIGEST_ACTIONS` partition in `matters.ts`
- Keyword urgency-expiry regexes (replaced by `expires`)
- The `bulk-delete` keyword rule (replaced by disposition + protected
  classes) — it currently endangers approval/regulatory mail on `main`
- The Triage tab, `TriageTable`, and the cards deck

## Verification

- **Coverage reconciles**: matters + filed + digest + unread = provider
  total, with `unread` never partitioned.
- **No wrong-brain digest**: no digest item has `owner: "you"` or a
  non-informational `ask`.
- **Closure holds**: a closed matter does not reappear after a rebuild;
  new mail on its threads produces an explicit "Reopened" matter.
- **Ledger is total**: every message that left the inbox without the
  user's individual action appears in the ledger; undo restores it.
- **The ladder moves both ways**: a reason with 2 reversals in 20 stops
  auto-acting without a deploy.
- **Protected classes are never swept**: a seeded Qualio approval
  request, IRB notice, SharePoint comment, and DMV renewal all survive
  every sweep, proposed or auto.
- **The Abbott merge test still passes** (`mergeMatters` behavior is
  untouched).

## Out of scope (this design)

- Reply drafting, delegation, unsubscribe-agent changes
- Org-chart / functions registry changes
- CRM sync changes
- Mobile parity for the sweep slate beyond rendering the same data
