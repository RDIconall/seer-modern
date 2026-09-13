# Gmail Incremental Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Seer below Gmail's per-user query-cost limit by retrying transient quota errors, using atomic thread mutations, and processing mailbox history deltas after push notifications.

**Architecture:** Preserve the shared provider contract for full reconciliation while adding a Gmail-specific history feed for ordinary wakes. Gmail history cursors advance only after changed conversations are durably written; absent or expired cursors use the existing bounded head sync and reseed from `users.getProfile`.

**Tech Stack:** TypeScript, Gmail REST API, Postgres, Node `tsx` test scripts

## Global Constraints

- Keep Outlook behavior unchanged.
- Keep full folder scans as the reconciliation and initial-backfill path.
- Do not advance a Gmail history cursor when persistence fails.
- Treat Gmail quota exhaustion as transient without treating permission-denied 403 responses as retryable.

---

### Task 1: Quota-aware provider retries

**Files:**
- Modify: `src/lib/v2/providers/http.ts`
- Modify: `src/lib/v3/outbox/retry.ts`
- Test: `scripts/v2-provider-http.test.mts`
- Test: `scripts/v3-outbox-retry.test.mts`

**Interfaces:**
- Produces: `isProviderQuotaError(error: unknown): boolean`

- [ ] Add tests proving a Gmail quota 403 is transient while an ordinary 403 remains permanent.
- [ ] Run the focused tests and confirm they fail on current behavior.
- [ ] Add quota-payload detection and retry quota-limited safe reads.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Atomic Gmail conversation mutations

**Files:**
- Modify: `src/lib/v2/providers/gmail.ts`
- Modify: `src/lib/v2/providers/contract.ts`
- Test: `scripts/v2-provider-gmail.test.mts`
- Test: `scripts/v3-outbox-drain.test.mts`

**Interfaces:**
- Consumes: Gmail `threads.modify`, `threads.trash`, and `threads.untrash`
- Produces: existing `MutationReceipt`

- [ ] Change mocked expectations to require one thread mutation and no preparatory full-thread fetch.
- [ ] Run the Gmail provider test and confirm it fails.
- [ ] Implement atomic, idempotent thread mutations.
- [ ] Run provider and outbox tests and confirm they pass.

### Task 3: Gmail history delta ingestion

**Files:**
- Modify: `src/lib/v2/providers/gmail.ts`
- Create: `src/lib/v2/sync/gmail-history.ts`
- Modify: `src/lib/v2/sync/wake-account.ts`
- Test: `scripts/v2-gmail-history.test.mts`

**Interfaces:**
- Produces: `GmailProvider.syncHistory(startHistoryId, context?)`
- Produces: `GmailProvider.currentHistoryId(context?)`
- Produces: `syncGmailHistory(accountId, provider, context?)`

- [ ] Add tests for changed-thread deduplication, inbox removal, deleted threads, cursor persistence, and expired-cursor fallback.
- [ ] Run the history test and confirm it fails.
- [ ] Implement paginated `users.history.list` and hydrate only distinct changed thread IDs.
- [ ] Persist delta pages before updating `gmail_history_id`.
- [ ] Route Gmail wake processing through history sync; retain bounded head sync for missing/expired cursors.
- [ ] Run focused history and sync tests and confirm they pass.

### Task 4: Regression verification

**Files:**
- Modify: `package.json`

- [ ] Add focused tests to the relevant suite scripts.
- [ ] Run Gmail provider, HTTP, outbox retry/drain, push, and sync tests.
- [ ] Run TypeScript and lint checks for changed files.
- [ ] Commit and push the verified implementation.
