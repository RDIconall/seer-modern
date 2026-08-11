# Task 7 — Responsive full mail client shell

## Status

Implemented and committed on `cursor/triage-atlas-janitor-spec-889f`.

Commits:

- `ef3f00d` — `feat(v3): restore full responsive mail client shell`
- `930f3e4` — `fix(v3): preserve provider ids for reader compose`

The branch was not pushed.

## Delivered

- One `MailClient` renders the same business logic at desktop and mobile breakpoints.
- Desktop left rail and split folder/reader layout.
- Mobile bottom navigation and fixed full-screen reader/compose surfaces.
- Inbox, Sent, Trash, Atlas, Triage, and Settings navigation.
- URL hash restoration for section, search query, and conversation.
- Cache-first mailbox hook using versioned local storage plus background revalidation.
- Idle prefetch of adjacent/ focused conversation bodies.
- Search wired to `/api/v3/search`, including visible provider-only/transient results.
- Reader wired to `/api/v3/conversations`, existing Reader actions, attachments, and provider-native escape hatch.
- Compose wired to existing send/reply/reply-all/forward commands.
- Optimistic archive/restore list updates, pending outbox undo via `/api/v3/outbox/:id/undo`, and visible failure notices.
- Task 6 cleanup: removed unused `providerConversationId` from `useReaderCommands` options; reader now preserves the provider id for compose.
- Dev preview now includes representative folder, reader, compose, Atlas, and Triage data without authentication.

## Verification

Passed:

- `npm run test:v3`
- `npm test`
- `npx tsc --noEmit`
- targeted ESLint over changed source files
- `npx tsx scripts/v3-ui-contract.test.mts`
- `npx tsx scripts/v3-styles.test.mts`
- `npx tsx scripts/v2-contrast.test.mts`
- `npm run build`

Manual route check:

- Development server returned `GET /dev/preview 200`.
- The response contained representative `Inbox`, `RMS Amendment`, `Dashboard redesign`, `Search mail`, `Compose`, and `Triage` content.
- No browser/screenshot tooling was available in this subagent, so visual screenshots and tap/keyboard interaction were not captured.
- Production `/dev/preview` returning 404 is intentional because the route is development-only.

## Concerns / follow-ups

- Full `npm run lint` currently scans generated `.vercel/output` files after a build and fails on generated launcher errors plus thousands of generated-code warnings. Targeted lint for the changed source passes; no generated output was committed.
- Settings is a navigable shell placeholder pending Task 8 account cutover.
- Mailbox list rows do not carry safety delete tokens, so reader delete remains visibly blocked with a safety-token message; Triage remains the authorized delete surface.
- Provider-only search results are shown as transient and cannot open a corpus reader until synced.

## Review follow-up

Review findings fixed in `e712381` (`fix(v3): address responsive shell review findings`):

- Folder and reader now render as sibling semantic panes when a folder conversation is open. CSS only changes their desktop/mobile placement; the folder remains mounted and selectable.
- Mobile navigation has an always-visible, labeled Compose action; the SSR contract exercises the compose-open state.
- `useMailbox` clears mismatched or failed views, validates response folder identity, and exposes only `viewForFolder(view, activeFolder)`. Empty Sent cannot retain Inbox rows.
- Hash `q` restoration calls the existing search API once, renders restored results, and clear resets the search state while retaining the active folder.
- Focus, hover, touch selection, and opening a row all call bounded, deduplicated adjacent body prefetch for N-1/N/N+1.

Exact review verification output:

```text
v3-mailbox-state: OK
v3-mail-client-state: OK
v3-ui-contract: OK
v3-styles: OK (58 classes all styled)
v2-contrast: ok (light and dark pass AA)

npx tsc --noEmit
exit 0

targeted eslint
exit 0

npm run test:v3
v3-schema: OK
v3-sync-folders: OK
v3-mailbox-view: OK
v2-sync-report: OK
v3-outbox: OK
v3-outbox-drain: OK
v3-outbox-retry: OK
v3-outbox-sync-mask: OK
v3-command-outbox: OK
v3-reader-api: OK
v3-search: OK
v3-attachment-security: OK
v3-outbound-idempotency: OK
v3-mailbox-state: OK
v3-mail-client-state: OK
v3-ui-contract: OK
v3-styles: OK (58 classes all styled)

npm test
exit 0

npm run build
Compiled successfully
Generating static pages (52/52)
exit 0

manual development preview
GET /dev/preview status=200 bytes=35648
mail-compose: 1
mail-folder-pane: 1
mail-mobile-compose: 1
```

No browser/screenshot tooling was available, so breakpoint screenshots and interactive touch/keyboard recordings were not captured.

## Mobile modal overlay follow-up

Fixed in `9bc6d97` (`fix(v3): isolate mobile modals from navigation`):

- Navigation omits the mobile bottom-nav subtree and Compose FAB whenever reader or compose modal state is open.
- On mobile, the background toolbar/folder pane is marked `inert` and `aria-hidden`; when compose is above a reader, the reader pane is also inert.
- Reader loading, error, and loaded states are full-viewport safe-area dialogs with a back control.
- Compose is a full-viewport safe-area dialog on mobile with its own close button and `aria-modal`.
- Reader stacks at `z-index: 50`; compose stacks at `z-index: 60`.
- Added SSR/component assertions that normal state includes nav/FAB while modal state excludes both, plus CSS stacking assertions.

Exact follow-up verification:

```text
npx tsx scripts/v3-ui-contract.test.mts
v3-ui-contract: OK

npx tsx scripts/v3-styles.test.mts
v3-styles: OK (58 classes all styled)

npx tsc --noEmit
exit 0

targeted eslint
exit 0

npm run test:v3
v3-schema: OK
v3-sync-folders: OK
v3-mailbox-view: OK
v2-sync-report: OK
v3-outbox: OK
v3-outbox-drain: OK
v3-outbox-retry: OK
v3-outbox-sync-mask: OK
v3-command-outbox: OK
v3-reader-api: OK
v3-search: OK
v3-attachment-security: OK
v3-outbound-idempotency: OK
v3-mailbox-state: OK
v3-mail-client-state: OK
v3-ui-contract: OK
v3-styles: OK (58 classes all styled)

npm test
exit 0

npm run build
Compiled successfully
Generating static pages (52/52)
exit 0
```
