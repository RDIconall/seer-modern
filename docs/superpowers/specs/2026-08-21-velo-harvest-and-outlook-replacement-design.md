# Velo harvest and Outlook replacement

Date: 2026-08-21  
Status: Analysis and recommended product direction. Not an implementation plan.  
Source app: [avihaymenahem/velo](https://github.com/avihaymenahem/velo) (Apache-2.0, cloned 2026-08-21)  
Depends on: `docs/superpowers/specs/2026-08-11-v3-full-client-design.md`

## Intent

Two questions:

1. What can Seer take from Velo while building out the full email client?
2. What would make Seer replace Outlook on the desktop and on iPhone?

The short answers:

- **Take Velo's mail-client craft, not its product.** Keyboard sequences, undo-send delay, RFC 8058 unsubscribe, CID inline images, queue compaction, mailto handling, native-shell chores (tray, badge, OS notifications). Port algorithms. Do not fork the app.
- **Replacing Outlook is a reliability and completeness bar, not an AI bar.** Seer already has the brain Outlook lacks. People keep Outlook because send/search/calendar/push/offline never fail. Until those are boring, Atlas cannot be the daily driver.

Velo is useful as a catalog of a finished Superhuman-style desktop client. It is not a shortcut to either question.

---

## What Velo is

Velo is a local-first desktop mail client: Tauri v2 (Rust) + React 19 + Zustand + SQLite. Tagline: "Email at the speed of thought." License: Apache-2.0.

Architecture:

```
React 19 + Zustand     UI
Service layer          Gmail API / IMAP+SMTP / AI / filters / calendar
Tauri + Rust           tray, OAuth PKCE, SQLite, IMAP, SMTP, deep links
```

Positioning: a fast keyboard client that keeps mail on the machine and bolts AI (summarize, draft, "Ask my inbox") on top.

That is the inverse of Seer. Seer is a chief of staff with a mail surface. The corpus, decisions, matters, yields, and signed delete tokens live in Postgres. Gmail and Microsoft Graph are adapters. The UI renders a server projection.

Velo ships Windows / macOS / Linux installers. It has iOS icon assets because Tauri 2 can target mobile; it does **not** ship an iPhone app. It talks to Outlook through IMAP/SMTP, not Microsoft Graph.

Do not treat Velo as an iPhone strategy, and do not treat IMAP as Seer's Outlook strategy. Seer already speaks Graph.

---

## What Seer already has (do not rebuild from Velo)

V3 already independently covers a surprising amount of Velo's "features" list. Harvest only the gaps.

| Velo feature | Seer today |
|---|---|
| Superhuman `j/k e r a f c`, `g` then folder | Wired in `MailClient` and Atlas `MatterPanel` |
| Command palette (`/` / Ctrl+K) | Actions only in `CommandPalette` — not search, not customizable |
| Gmail-style search operators | `src/lib/v3/search/parser.ts` compiles to Gmail and Graph |
| TipTap composer | `RichComposer` — bold/italic/lists/links, no images/templates/signatures |
| Optimistic mutations + retry queue | `seer.outbox` with pending cancel = Superhuman undo |
| DOMPurify + sandboxed iframe | `MessageHtml` + `sanitizeEmailHtml` |
| Remote image blocking | `src/lib/v3/reader/remote-images.ts` (same `data-blocked-src` trick) |
| Draft autosave | `localStorage` via `src/lib/v3/compose/draft.ts` — not a provider draft, not attachments |
| Contact autocomplete | `/api/v3/contacts` + `RecipientInput` |
| Attachments download | v3 attachment route |
| Multi-account Gmail + Outlook | OAuth + `mail_accounts`; Graph, not IMAP |
| PWA install (desktop + `/m`) | manifests + service worker with foreground update check |
| Inbox / Sent / Trash | Corpus-backed mailbox views |
| Threaded reader | Provider-native threads (Gmail/Graph), not JWZ |

The v3 design already chose the right write path (approach C: instant UI, durable outbox, provider as source of truth). Velo's `pending_operations` table is the same idea implemented locally. Keep Seer's outbox. Steal Velo's compaction and delay-before-drain details, not the store.

---

## Take / leave / already have

Each Velo subsystem, judged against Seer's architecture and the Outlook bar.

### Take — port the algorithm into Seer

These are small, well-bounded, Apache-2.0-portable, and they close real client gaps.

1. **Undo-send delay window.** Velo holds the send in a client timer (default 5s) and shows a toast. Seer's outbox already supports "cancel while `pending`, never call the provider." Wire a configurable drain delay on `send` / `reply` / `forward` and a toast that calls `POST /api/v3/outbox/:id/undo`. This is the one Velo trick that maps onto code we already shipped.

2. **RFC 8058 one-click unsubscribe.** Velo's `parseUnsubscribeHeaders` + POST-then-mailto-then-browser fallback. Legacy Seer had this; v2 does not wire it. Belongs on the reader overflow and as a bulk Triage verb for newsletters. Provider-neutral: parse `List-Unsubscribe` / `List-Unsubscribe-Post` at sync time, persist on the message, execute from the command bus.

3. **CID / inline image resolution.** Velo's `EmailRenderer` fetches `cid:` parts and inlines `data:` URLs before the iframe. Seer sanitizes and blocks remote images but still drops many Outlook HTML signatures and pasted screenshots. This is a reader-fidelity bug that makes people open Outlook "just to see the picture."

4. **Outbox compaction.** Velo's queue processor collapses redundant ops (mark-read then archive → one archive) and classifies retryable vs permanent failures. Seer's drain retries; it does not compact. Cheap insurance against Graph 429 storms.

5. **Keyboard completeness + help overlay.** Seer has the core map but not `#` delete, `u` unsubscribe, `v` move, `s` star, `p` pin, `m` mute, `?` cheat sheet, or rebindable keys. Velo's `shortcuts.ts` + two-key sequence with a 1s timeout is the right shape. Bind Seer's verbs (`archive`, `trash`, `restore`, `markUnread`, `send`, Atlas/Triage jumps). Do not bind Velo's Primary/Updates/Promotions tabs — those fight Atlas.

6. **`mailto:` handling.** Velo parses a `mailto:` URL and opens compose. Desktop replacement requires this (links in browsers, Slack, Salesforce). PWA can register a handler; a Tauri/Capacitor shell must too.

7. **Composer depth, selectively.** Port in this order: inline images in the editor, signatures (per account, HTML), drag-and-drop attachments with a size gate we already have, schedule send (outbox `next_attempt_at` in the future). Skip Velo's template-variable language until signatures exist. Skip send-as aliases until a real second From is connected.

8. **Phishing heuristics, later.** Ten pure functions over URLs (homograph, shortener, brand impersonation, display-text mismatch). Useful for a CEO. Not why anyone keeps Outlook. Do not block the replacement bar on this.

When porting, copy the test cases and the algorithm, then rewrite against Seer's types (`Conversation`, `Command`, `MailProvider`). Do not import Velo's Zustand stores, SQLite tables, or Tauri commands.

### Already have — do not take

- Provider abstraction. Seer's `MailProvider` is stricter (conversation-complete, honest partial failure, idempotency keys). Velo's is Gmail-shaped with IMAP bolted on.
- Threading. Gmail and Graph give us threads. JWZ is for IMAP. Skip unless we add a third provider that has no thread id.
- AI summarize / smart reply / Ask Inbox. Seer's chief-of-staff read, yields, and Atlas are the grown-up version. Velo's AI is a per-thread chatbot with a local cache.
- Newsletter bundles and Gmail category tabs. Triage digest + Atlas is the product answer. Bundles would reintroduce a second classification brain.
- Task manager with subtasks and recurrence. Atlas matters are the unit of work. A second task database would split the CEO's attention the way Outlook tasks already do.
- Local SQLite as system of record. The corpus is Postgres. Offline is a cache and an outbox, not a second brain.
- Glassmorphism, 8 accent colors, 4 densities. Conflicts with the standing UX bar (National 2, 400/700, 12/14/17, no chrome for its own sake).

### Leave — wrong architecture or wrong user

- **IMAP/SMTP as the Outlook path.** Basic auth is dead; Graph is how Seer already mutates Outlook. IMAP would silently drop categories, focused inbox, shared mailboxes, and calendar.
- **Forking Velo and "adding Seer logic."** Same trap as driving Superhuman through an MCP: the value (matters, deep reads, org placement, signed deletes) lives below a UI Velo does not expose. You would rebuild the brain against the wrong store.
- **User-authored filter rules as the intelligence layer.** Seer files by meaning. A Superhuman-style filter engine is a power-user escape hatch after teach/correct works, not a substitute for the read.
- **Google Calendar as "the calendar."** This user lives in Outlook. Calendar replacement is Microsoft Graph: mail RSVP, accept/decline/tentative, create event from a thread, conflict display. Velo's Google Calendar module is a reference for UI structure only.
- **Tauri as the product.** Native shells come after the web client is complete enough to wrap. Starting in Tauri would fork the codebase away from the iPhone PWA and from Vercel's deploy path.

### License

Velo is Apache-2.0. Porting algorithms and tests is allowed with attribution. If any Velo file is copied with substantial similarity, add a `NOTICE` entry naming Avihay Menahem / Velo and keep the Apache header on that file. Prefer rewrite-against-Seer-types so we are not carrying a second UI language.

---

## What replacing Outlook actually means

Outlook is not kept because it is good. It is kept because it is the last place that is allowed to fail. Seer replaces it when the user can uninstall the desktop app and delete the iPhone app without a fallback plan.

The standing Seer bar still applies: never truncate the primary object, 44px targets, one hierarchy, actions not narration. Replacement features that violate that bar are not done.

### Desktop — uninstall test

A workday where Outlook stays closed. If any item below sends the user back, Seer is still a sidecar.

1. **Send cannot fail silently.** Reply, reply-all, forward, new mail, attachments, inline images, HTML signatures. Failures are visible. Undo exists for a few seconds after send. Drafts survive a crash.
2. **The mailbox is the mailbox.** Inbox, Sent, Drafts, Trash, Archive, and the user's own folders. Custom folders are browsable and searchable. A thread moved in Outlook on another device converges here.
3. **Search finds old mail.** Years, not the last sync page. Operators the user already types in Outlook/Gmail (`from:`, `has:attachment`, dates). Results open in Seer's reader, not a native-app bounce.
4. **Calendar from mail.** Meeting invites render. Accept / decline / tentative writes to the Outlook calendar (Graph, not Gmail-only). Create a meeting from a thread. See whether the slot is free. Without this, every invite is an Outlook click.
5. **People.** Autocomplete ranks real correspondents. Opening a person shows recent threads and the relationship the brain already knows. Outlook's people pane is shallow; Seer can beat it, but only if it is on screen.
6. **Keyboard as fast as Superhuman, not as fast as Outlook.** The v3 map is the start. `#` delete, undo, move, compose, send (`Ctrl+Enter`), command palette that searches mail *and* runs actions. A `?` overlay. This is how a CEO lives in Superhuman; it is how they will live in Seer.
7. **A window that behaves like software.** Dock/taskbar icon, badge unread (or "needs you") count, `mailto:` from the browser, does not lose drafts when the laptop sleeps, does not blank on Graph 429. A PWA can pass this on desktop Chrome/Edge. A Tauri wrapper is packaging once the web client already works.
8. **Shared and delegated mail, or an honest no.** Stage 1.5 is personal mailboxes only, with a visible Settings line: "Shared and delegated mailboxes still live in Outlook." Graph shared-mailbox sync is Stage 2. Shipping personal-only and calling it a replacement without that sentence will bounce on week one.
9. **Print / save / drag files in.** Low status, high "open Outlook for a second" rate.

Not on the uninstall test: themes, split-inbox tabs, a built-in task app, newsletter bundling, phishing banners, AI that summarizes a thread you can already see.

### iPhone — delete-the-app test

Outlook on iPhone survives for five reasons. Miss any one and it stays.

1. **Push that arrives.** APNs (or Web Push where iOS actually delivers it). VIP / known-sender / "you owe a reply" only — not every newsletter. The product owner already asked "make it push"; it is still unmarked. This is the #1 iPhone replacement item. A PWA on iOS cannot be trusted for this.
2. **The inbox is current when opened.** Background refresh so the first paint is not a spinner. Seer's 5-minute cron helps the server; the phone still needs a fresh projection waiting.
3. **Mail gestures.** Swipe archive/delete, pull to refresh (exists in legacy mobile), checkbox bulk, 44px targets. The current v3 mobile nav is a start; swipe is still listed as missing versus legacy.
4. **Compose like a phone.** Camera and Files as attachments, share-sheet into Seer, `mailto:` from Safari, inline reply that does not lose the thread, signatures.
5. **A badge that means something.** Unread is Outlook's badge. Seer's badge should be "needs you" (owner = you, or unsigned signature queue), not raw unread. Wrong badge trains people to ignore it or to reopen Outlook.
6. **Notification actions.** Reply / archive / later from the lock screen, or the phone is a pager that still needs Outlook to act.
7. **Auth that does not require a desktop.** Graph token refresh on the device. Reconnect from Settings on the phone. An expired Microsoft session that can only be fixed on the laptop is why Outlook stays installed.
8. **HTML that looks like the desktop reader.** Same sandboxed iframe, CID images, no sideways-scroll tables (the scale-to-fit script in `MessageHtml` is the right idea — keep it).

A home-screen PWA can cover 3, 4 (partial), 7, and 8. It cannot honestly cover 1, 6, or a reliable badge. That is the line where Seer needs a real iOS shell (Capacitor or a small native wrapper around the same APIs), not more CSS.

### What Seer already beats Outlook at (keep leading with this)

Once the uninstall tests pass, these are why the user does not go back:

- The inbox is a living corpus with coverage against the provider count.
- Atlas is the work; Triage is delete-or-close; there is no third pile of "maybe."
- One chief-of-staff read per conversation, veto-only delete, signed tokens.
- Salesforce on the matter, not a tab switch.
- Yields: meaning survives the delete.

Do not dilute this to look like Velo's split inbox. The replacement client is Outlook's verbs with Seer's brain on every row.

---

## Approaches

### A — Harvest into the existing web client (recommended for product logic)

Keep the v3 Next.js client, Postgres corpus, Graph/Gmail adapters, and outbox. Port the Take list as Seer modules (`src/lib/v3/unsubscribe`, richer composer, CID resolver, shortcut overlay, send-delay). Ship desktop as the current PWA; keep `/m` as the phone PWA.

- **For:** One codebase, one brain, matches the v3 spec, deploys on the existing path.
- **Against:** iOS push and badge stay weak until a native shell. Desktop `mailto:` and dock badge are browser-dependent.

### B — Fork Velo, attach the Seer brain (reject)

Replace Seer's shell with Velo. Call Seer APIs from Velo's service layer, or dual-write SQLite and Postgres.

- **For:** Instant Superhuman-feeling desktop.
- **Against:** Two stores, two AIs, no iPhone, IMAP Outlook, glass UI vs Seer bar, every matter/triage surface rebuilt against Zustand. Same failure mode as "MCP Superhuman."

### C — Seer web as the product, thin native shells as packaging

Do A until the uninstall tests for *mail verbs* pass in the browser. Then wrap the same origin:

- Desktop: Tauri (steal Velo's tray / badge / single-instance / `mailto:` / autostart, not its database).
- iPhone: Capacitor or native shell whose only jobs are APNs, badge, share sheet, camera, swipe polish. UI remains the Seer web client, or a locked-down WKWebView of `/m`.

- **For:** Native where the platform actually requires it (push, share, badge), without forking the brain.
- **Against:** Two extra binaries to sign and ship. Only worth it after the web client is not the reason people bounce.

**Recommendation:** A immediately, sequenced as a new v3 stage on top of the existing full-client plan. C only for the platform gaps A cannot pass (iOS push/badge/share; desktop mailto/badge if the PWA fails the dock test). Never B.

---

## Sequence (after current v3 Stage 1)

Existing Stage 1 (real client: folders, outbox, reader, compose, search, settings) stays the foundation. Do not restart it. The Outlook replacement work is a Stage 1.5 / 2 split:

**Stage 1.5 — "I stopped opening Outlook for mail."**

- Drafts folder in the corpus (provider drafts + local autosave with attachments).
- Custom folders: `listFolders` is already on the provider; persist membership, move command, `v` shortcut.
- CID inline images + remote-image allowlist per sender.
- Undo-send delay on the outbox; `#` delete; `?` shortcut overlay; palette search of mail, not only commands.
- RFC 8058 unsubscribe on the message and as a Triage bulk verb.
- Graph calendar RSVP (today's `/api/calendar/rsvp` is Gmail-only — this is an Outlook-shaped hole).
- Signatures. Drag-and-drop compose attachments (size gate already exists).
- Visible Settings limitation: shared and delegated mailboxes still live in Outlook.

**Stage 2 — "I stopped opening Outlook for the day."**

- Calendar day/week from Graph, create event from a thread, free/busy on compose.
- Graph shared and delegated mailboxes, or keep the Stage 1.5 limitation visible.
- Schedule send. Follow-up reminder when a thread you own has no reply (legacy had this; Velo has it; Atlas "waiting" is the Seer form — render it).
- Teach/correct UI (commands exist). Matter panel rename/refile/settle.
- Desktop PWA badge / `mailto:` registration. If those fail in real use, Tauri wrapper (approach C) with Velo's native chores only.

**Stage 3 — "I deleted Outlook from the iPhone."**

- APNs (or a native wrapper whose job is APNs). Notification actions.
- Swipe archive/delete. Share sheet. Camera attachments.
- Badge = needs-you, not unread.
- On-device reconnect for Graph.
- Push categories: known senders and owner=you only.

Cards, waiting-on lane, unsubscribe *agent*, Salesforce write-back stay on the existing v3 Stage 2/3 list. They make Seer better than Outlook. They do not make it possible to leave Outlook.

---

## Testing the claim

"Seer replaced Outlook" is not a unit test. Use two explicit gates, run on a real mailbox, not the fake provider:

**Desktop uninstall gate.** Seven consecutive workdays: Outlook desktop stays quit. No meeting invite, search, send, or folder move required opening it. Graph 429 never blanked the UI (already a learned lesson). Undo recovered at least one mistaken send.

**iPhone delete gate.** Fourteen days with Outlook Mail uninstalled. Every VIP/needs-you message produced a notification. Share-from-Photos attached. An expired token was repaired in Seer Settings. No "I'll just check Outlook."

Until both gates pass, call Seer a chief of staff that still requires a mail client — which is today's honest status — and keep harvesting Velo for craft, not for architecture.
