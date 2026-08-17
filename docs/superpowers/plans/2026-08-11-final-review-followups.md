# Final Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining final-review findings around production database privilege, concurrent folder snapshots, projection correctness, deadline enforcement, account switching, outbox ordering, and account health.

**Architecture:** Keep the existing relational corpus and outbox as the source of truth. Add narrowly scoped shared helpers for production database URL validation and provider request deadlines, make snapshot generations opaque UUIDs with row-locked completion, and expose only account health metadata through the account API. Preserve development/test fallbacks while making production setup fail closed.

**Tech Stack:** Next.js 15, TypeScript, `pg`, PostgreSQL/Supabase migrations, embedded Postgres integration scripts, React client hooks.

## Global Constraints

- Production v2 and legacy KV pools require `SEER_V2_DATABASE_URL` and the `seer_app` role.
- Development and test database fallbacks remain available.
- Production KV runtime code may probe existing schema but may not run DDL unless an explicit setup flag is set.
- Folder snapshot membership is keyed by a durable UUID generation and stale cleanup is conditional on the still-current generation.
- OAuth secrets remain encrypted server-side and never appear in account API responses.
- No live production migration or provider mutation is performed in this workspace.
- Every behavior change gets a regression test before its implementation and each logical change is committed separately.

---

### Task 1: Production database privilege and KV provisioning

**Files:**
- Modify: `src/lib/v2/db/pool.ts`
- Modify: `src/lib/store/pg.ts`
- Modify: `scripts/v2-pool-ssl.test.mts` or a production security test included by `test:v3`
- Modify: `supabase/migrations/20260810022424_seer_v2_core.sql`
- Create: the next Supabase migration after `20260811234500_v3_final_review.sql`
- Test: `scripts/v3-schema.test.mts`

- [ ] Add failing assertions for production URL selection, username validation including `seer_app.<project>`, missing-variable failure, and production KV DDL denial.
- [ ] Run those focused tests and verify they fail for the current fallback and runtime-DDL behavior.
- [ ] Implement a shared parser/validator used by both pools; keep non-production fallbacks.
- [ ] Change the role definition to `LOGIN NOINHERIT` without provisioning a password.
- [ ] Make KV production probe-only by default, with development/test or an explicit setup flag as the only provisioning paths.
- [ ] Run the focused tests and commit the security changes.

### Task 2: UUID snapshot concurrency and outbox-aware cleanup

**Files:**
- Modify: the folder snapshot migration and the next follow-up migration
- Modify: `src/lib/v2/sync/repository.ts`
- Modify: `src/lib/v2/sync/engine.ts`
- Modify: `src/lib/v3/outbox/sync-mask.ts`
- Test: `scripts/v3-schema.test.mts`
- Test: `scripts/v3-sync-folders.test.mts`
- Test: `scripts/v3-sync-backfill.test.mts`
- Test: `scripts/v3-outbox-sync-mask.test.mts`

- [ ] Add failing overlap tests where scan A pages, scan B completes, then scan A completes, and add the pending restore stale-membership case.
- [ ] Run the tests to confirm the current numeric generation and unconditional cleanup fail.
- [ ] Migrate to `snapshot_generation uuid`, generate UUIDs in the locked begin transaction, retain per-generation seen rows, and make completion lock/verify current generation before deleting stale membership.
- [ ] Apply the outbox mask to stale removal, including restore’s expected inbox membership and convergence expiry.
- [ ] Run the focused sync/schema/outbox tests and commit.

### Task 3: Projection and account-switch isolation

**Files:**
- Modify: `src/lib/v2/view/build.ts`
- Modify: `src/components/v2/useInboxView.ts`
- Modify: `scripts/v2-inbox-view.test.mts`
- Modify: `scripts/v3-accounts.test.mts` or add a focused client contract test

- [ ] Add failing projection and account-event assertions.
- [ ] Run them red.
- [ ] Require inbox folder containment in the brain projection query and clear/reload the v2 view on the account-changed event.
- [ ] Preserve existing account-qualified mailbox, reader, and search cache keys.
- [ ] Run the focused tests and commit.

### Task 4: Provider deadline and retry headroom

**Files:**
- Modify: `src/lib/v2/providers/http.ts`
- Modify: `scripts/v2-provider-contract.test.mts`

- [ ] Add failing tests for slow body consumption, caller abort during body consumption, huge `Retry-After`, and no retry without deadline headroom.
- [ ] Run them red.
- [ ] Keep the controller and timer active through body text/JSON parsing, cap retry delay to remaining deadline, and use an abortable sleep.
- [ ] Run provider contract tests and commit.

### Task 5: Outbox order and per-account credential health

**Files:**
- Modify: `src/lib/v3/outbox/drain.ts`
- Modify: `scripts/v3-outbox-drain.test.mts`
- Modify: `src/lib/v2/db/accounts.ts`
- Modify: `src/lib/v2/providers/token-service.ts`
- Modify: `src/lib/mail/session.ts`
- Modify: `src/auth.ts`
- Modify: `src/app/api/v3/accounts/route.ts`
- Modify: `src/components/v3/Settings.tsx`
- Modify: the next Supabase migration
- Test: `scripts/v3-accounts.test.mts`

- [ ] Add failing equal-timestamp archive→restore ordering and credential status tests.
- [ ] Run them red.
- [ ] Add `created_at,id` ordering consistently in claims and same-conversation blocking; add health status/error persistence and clear-on-success behavior.
- [ ] Return only `status`/metadata in the account API and display reconnect-required accounts in Settings.
- [ ] Run focused tests and commit.

### Task 6: Documentation and full verification

**Files:**
- Modify: `.superpowers/sdd/final-fix-report.md`
- Modify: `.superpowers/sdd/task-8-report.md`
- Modify: `.superpowers/sdd/task-9-sync-report.md`
- Modify: migration documentation in the v3 plan/spec
- Modify: `package.json` when new tests need inclusion

- [ ] Document every required migration, including `20260811234500_v3_final_review.sql` and the new follow-up migration.
- [ ] Document operator password provisioning for `seer_app` and explicitly state that this workspace did not mutate live production.
- [ ] Run targeted tests, `npm test`, `npm run test:v2`, `npm run test:v3`, lint, typecheck, and build.
- [ ] Commit documentation and test-list changes.
