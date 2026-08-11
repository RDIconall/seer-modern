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
