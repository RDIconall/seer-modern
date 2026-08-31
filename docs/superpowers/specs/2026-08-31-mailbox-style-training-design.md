# Mailbox style training (inbox-zero and never-archive)

## Problem

Seer was built for a small live Inbox that is archived as it is cleared. A
never-archive Outlook Inbox (tens of thousands of conversations) is the same
folder Seer treats as the working set. Inbox-zero and leave-everything are
opposite habits; one default cannot serve both.

## Goal

Each mailbox has a **style** Seer infers, the user confirms, and Cards/Triage
keep teaching:

1. **Infer** from Inbox size, unread, stars/flags when present, trash vs
   sent, and recent clear actions.
2. **Confirm** on first run: explain Inbox vs Triage vs Cards vs Atlas, then
   show the inferred claims for edit.
3. **Train on Cards** with **“Is this still relevant?”** Yes, or No plus why
   (taken care of / it ended / never was / not for me).
4. **Keep learning** from later Triage. If behaviour disagrees with the
   confirmed style, ask once — never flip silently.

Analysis never becomes policy without user input.

## Non-goals

- Auto-archiving a leave-in-Inbox mailbox
- Dumping the full historical Inbox onto Atlas
- Training a custom ML model
- Shared org-wide style
- Waiting for full backfill before first-run (inference uses provider total
  plus whatever is already stored)

## Personas

| | Inbox-zero | Never-archive |
|---|---|---|
| Clear habit | archive or delete | leave in the provider Inbox |
| “Cleared” | leaves Outlook/Gmail Inbox | hidden from Focus/Cards/Triage; still in Inbox |
| Importance | often the live Inbox itself | flag, unread, or explicit marks |
| Atlas | live matters from a small set | only **still relevant** matters |

## Loop

```
sync snapshot → infer hypothesis
        ↓
first-run map + editable claims (confirm)
        ↓
Cards training deck (real threads)
        ↓
live Triage/Cards events
        ↓
drift prompt if actions contradict style
```

## Style fields (per mail account)

- `clearHabit`: `archive` | `delete` | `leave`
- `importanceCues`: subset of `flag`, `unread`, `star`, or `none`
- `matterBar`: `high` (few Atlas matters) | `medium` | `low` (more threads stay work)
- `confirmed`: user accepted or edited the hypothesis
- `inferred`: last hypothesis + confidence + reasons (claims, not law)
- `driftPrompt`: one sentence to re-confirm, or null

## Inference (hypothesis only)

- Provider Inbox total (or stored Inbox) **≥ 2000** → `leave`, high confidence.
- Small Inbox (≤ 400) with recent archives → `archive`.
- Recent deletes dominate archives → `delete`.
- Unread share **≥ 25%** with a meaningful unread count → cue `unread`.
- Starred/flagged count **≥ 5** → cue `flag` (Outlook) / `star` (Gmail) as available.
- Huge Inbox and few open matters → `matterBar: high`.

## First-run copy

1. **Map (about 20 seconds).** Inbox is the real folder. Triage is decisions
   on mail Seer already judged disposable or keepable. Cards is one thread at
   a time, including “is this still relevant?”. Atlas is only live work.
2. **Claims.** “We think you leave mail in Outlook and use unread as a focus
   signal. Change anything that’s wrong.” Three controls matching the three
   fields. Confirm does not move mail at the provider.
3. **Cards.** Offer a training deck of real threads (newest, unread/flagged
   when cued, a couple of likely-disposable). Skippable after confirm.

Re-open the same flow from Settings.

## Cards: still relevant

Primary question on each card: **Is this still relevant?**

| Answer | Meaning | Filing | Provider |
|---|---|---|---|
| Yes | live work | `matter` | none |
| No — taken care of | done, keep findable | `record` | archive unless `leave` |
| No — it ended | work finished | `record`, close linked matter | archive unless `leave` |
| No — never was | not work | `delete` home | trash if habit is delete, else archive; `leave` hides only |
| No — not for me | FYI / wrong desk | `record` | same as taken care of |

`leave`: set `conversations.focus_hidden`, **do not** remove from Inbox.
Inbox list stays the real folder. Focus, Cards, and Atlas (non-matters) omit
hidden rows.

Swipe right = yes. Swipe left = not relevant (then why, defaulting to
never-was if they commit the swipe without a chip). Archive/Delete remain as
explicit buttons for inbox-zero users.

## Focus set (Cards)

Inbox conversations that are not `focus_hidden`, and any of:

- unread (when that cue is on, or always as a weak signal)
- last message within 14 days
- current home is `matter`
- undecided/pending and last message within 7 days

Newest first. Paginated. Not the 73k dump.

**Inbox** (date sort) is unchanged: provider Inbox folder, newest first.

**Triage** stays the clear pile (`delete` + `record` decisions), excluding
`focus_hidden`.

**Atlas** includes all current **matters**. Other homes only if not hidden and
recent (21 days), so the projection stays bounded.

## Training events

Append-only `seer.training_events`: account, optional conversation, kind
(`confirm_style` | `relevance` | `triage` | `dismiss_drift`), payload JSON.

Triage archive/delete/matter also records an event. Last 12 relevance/triage
events: if ≥ 70% disagree with `clearHabit` or `matterBar`, set `driftPrompt`.
Showing the prompt and **Keep this** / **Update** clears or writes a new
confirm. Never silent overwrite of a confirmed style.

## Brain

`compileContext` adds an `[explicit]` line from confirmed (else inferred)
style: clear habit, importance cues, matter bar. User corrections remain
stronger than the model.

## Safety

- Bulk delete still needs a signed delete token.
- A person answering Cards is `byUser` for trash when habit is delete.
- Confirm/training never archives Lara’s mail because inference said leave.
- `user-correction` decisions stay law for the read queue.

## Settings

Show current style, inferred reasons, **Train again**, and the drift sentence
if present.
