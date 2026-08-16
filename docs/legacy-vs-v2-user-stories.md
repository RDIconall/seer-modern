# Legacy Seer vs v2 — the product, as user stories

Every capability of the legacy system, written as a user story, with its
status in v2. Compiled from a full inventory of the legacy UI
(`src/components/inbox/`, legacy `src/app/api/`) and the legacy intelligence
layer (`src/lib/` outside `v2/`), verified against what the v2 shell actually
wires today.

Legend:
- ✅ v2 has it (sometimes in a different, deliberate form)
- 🟡 partial — usually: the v2 backend supports it, no UI reaches it
- ❌ not in v2
- ⚪ existed in legacy code but was never reachable in the legacy UI either

---

## 1. Getting in, accounts, settings

| As Conall, I can… | Legacy | v2 |
|---|---|---|
| sign in with Google or Microsoft | ✅ | ✅ same auth |
| install Seer as a PWA on my phone | ✅ | ✅ |
| open Settings at all | ✅ | ✅ |
| **sign out** | ✅ | ✅ |
| connect a second mailbox / switch accounts | ✅ | ✅ |
| reconnect an expired account | ✅ | ✅ Settings flow; account health still depends on provider credentials |
| remove an account | ✅ | ✅ |
| see integration health probes | ✅ | ❌ |

## 2. Using mail like a mail client

| As Conall, I can… | Legacy | v2 |
|---|---|---|
| browse Inbox / Sent / Trash | ✅ | ✅ |
| search my mailbox | ✅ | ✅ |
| open a message and read the HTML body in-app | ✅ | ✅ |
| reply / reply-all / forward | ✅ | ✅ |
| compose new mail with contact autocomplete | ✅ | 🟡 compose works; legacy autocomplete is not yet restored |
| download attachments | ✅ | ✅ |
| RSVP to a calendar invite from the email | ✅ | ❌ |
| see unread indicators; mark read/unread | ✅ | ✅ |
| swipe to archive/delete on mobile | ✅ | ❌ (checkbox model instead) |
| jump to the message in Outlook/Gmail web | ❌ | ✅ native deep links everywhere |

## 3. Clearing the inbox (Triage)

| As Conall, I can… | Legacy | v2 |
|---|---|---|
| see triage grouped by my business categories | ✅ functions + AI digest themes | ✅ functions + stable topics registry |
| see "safe to delete" vs "review" buckets | ✅ | ✅ with server-signed delete authorization |
| bulk-clear a category or bucket | ✅ header links | ✅ Gmail-style checkboxes, ranges, sticky toolbar |
| trust that bulk delete can't hit protected mail | 🟡 relationship floor | ✅ signed tokens; mixed selections archive, never escalate |
| archive/delete one row | ✅ | ✅ |
| open the email behind a row | ✅ in-app | ✅ in-app reader with provider deep link |
| resize columns; keep my scroll position on sweeps | ✅ | ✅ |
| export the inbox ledger as CSV | ✅ | 🟡 link exists but still reads the retired legacy brief — broken since cutover |
| undo a sweep | ⚪ ledger + undo API, no UI | 🟡 `restore` command exists; no UI |
| close "finished" matters from triage | ✅ | ❌ |

## 4. The whiteboard (Atlas)

| As Conall, I can… | Legacy | v2 |
|---|---|---|
| see every matter as one line under my sections | ✅ | ✅ balanced multi-track board |
| collapse/expand and keep my arrangement | 🟡 mobile only, not persisted | ✅ both views, persisted |
| switch to an outline (Nuclino-style list) | ❌ (removed BriefPanel) | ✅ |
| open a matter and see goal / narrative / next action / owner / people | ✅ MatterPanel | ❌ conversations + yields only |
| rename a matter | ✅ | 🟡 `title_source='user'` honoured by backend; no UI |
| move a matter to another section (drag or menu) | ✅ | 🟡 user filings protected in backend; no UI |
| reorder matters within a section | ✅ | ❌ |
| drag a triage row onto the board to make it a matter | ✅ | ❌ |
| settle/close a matter; see "this looks finished" | ✅ + CRM-informed | ❌ |
| create a matter by hand | ✅ | 🟡 schema supports; no UI |
| see a "things you need to sign" queue | ✅ pinned signature queue | ❌ |
| catch up on "while you were away" | ✅ popover | ❌ |
| see deal amounts from CRM on matters | ✅ | ❌ |
| see who owns the next move (you/them/team) | ✅ glyphs | 🟡 stored per decision; not rendered on board |
| see coverage counts | ✅ popover | ✅ top-bar line |

## 5. Intelligence under the hood

| As Conall, I need Seer to… | Legacy | v2 |
|---|---|---|
| deeply read each conversation with my context | ✅ snippet triage + deep reads | ✅ single chief-of-staff read: full bodies, recipients, attachments |
| consolidate one request into one unit of work | ✅ whole-inbox clustering, union-find merge | ✅ codes/counterparty/name ties + vagueness guards |
| cross-reference the whole inbox at once | ✅ (its structural strength) | ❌ by design — incremental reads; codes and the registry compensate |
| name matters like a person would | ✅ relative naming, no near-duplicates | ✅ work-not-relationship rules + deterministic rejection |
| protect mail from people I know | ✅ floors | ✅ deterministic veto + signed tokens |
| rank by real urgency and deadlines | 🟡 model urgency 0–3 | ✅ grounded salience + extracted due dates |
| keep meaning even when mail is deleted | 🟡 digest lines | ✅ yields (facts/contacts/connections) 🟡 thinly surfaced |
| learn from my archive/trash behaviour | ✅ action memory | ❌ |
| know I already replied / whose turn it is | ✅ | ❌ |
| decay stale urgency; spot unusual charges | ✅ | ❌ |
| earn autonomy per action type | ⚪ ladder existed; nothing consumed it | ❌ |
| control model spend | ❌ (part of the $480/week problem) | ✅ two-tier routing, per-call telemetry, daily caps |

## 6. Teaching Seer

| As Conall, I can… | Legacy | v2 |
|---|---|---|
| correct one email's placement | ✅ reader menu | 🟡 `correctConversation` command; no UI |
| teach a sender (always/never delete, VIP) | ✅ reader menu | 🟡 `teachSender` command; no UI |
| manage a VIP list | ⚪ sheet built, never opened | 🟡 flag in schema; no UI |
| correct a matter's section and have it stick | ✅ + fed back as few-shot examples | 🟡 user filings never overwritten; not yet fed back as examples |
| maintain an "about me" profile the AI reads | ✅ | ❌ |

## 7. Assistants & automations

| As Conall, I can… | Legacy | v2 |
|---|---|---|
| get an AI-drafted reply | ✅ | ❌ |
| delegate an email to my EA | ✅ | ❌ |
| block calendar time from an email | ✅ | ❌ |
| unsubscribe for real (RFC 8058 one-click) | ✅ | ❌ |
| run a bulk unsubscribe agent | ⚪ built, never opened | ❌ |
| see who I'm waiting on and nudge them | ⚪ built, never mounted | ❌ |
| triage as a swipeable card deck | ✅ | ❌ |
| snooze | 🟡 client-only, forgot on refresh | ❌ |

## 8. Integrations

| As Conall, I can connect… | Legacy | v2 |
|---|---|---|
| Salesforce (deals, study codes, amounts, exemplars) | ✅ | ❌ |
| Google/Microsoft contacts + calendar | ✅ | 🟡 people graph seeded once from legacy data |
| iMessage (BlueBubbles) | ✅ | ❌ |
| Gmail labels as decision cache | ✅ | ✅ replaced by durable provider-neutral decisions |

## 9. Where v2 has no legacy equivalent

- Relational corpus in Postgres with RLS and AES-256-GCM encrypted credentials
  (legacy: JSON blobs in KV, plaintext tokens).
- Idempotent audited command bus; every mutation a receipt.
- Signed, decision-bound delete tokens; deterministic safety veto.
- Model cost telemetry per call, daily caps, deterministic fast→strong routing.
- The functions/topics registry as data rather than a hardcoded list.
- Coverage reconciliation against provider totals.
- Regression gates: styles, WCAG contrast, cron-path exemptions, provider
  contract, selection safety, naming/merge guards.

---

## Reading of the gap

The legacy system was a **full mail client with an intelligence layer bolted
on**. V3 restores that client shell on the v2 corpus: folder lists, search,
reader, compose, settings, account switching, and durable provider mutations.
The engine — corpus, reads, matters, filing, safety, and cost — remains the
system of record. Several legacy strengths (CRM, behavioural learning, and
assist flows) remain intentionally deferred.

Remaining Stage 2/3 work:
1. Teach/correct affordances on rows (`teachSender`, `correctConversation`).
2. Matter panel: rename, re-file, settle (backend contracts all exist).
3. Rebuild export on v2 data (current link reads the retired brief).
4. Assist, CRM, and behavioural-learning surfaces.
