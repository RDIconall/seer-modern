# Mailbox Style Training Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infer a per-mailbox style, confirm it on first run, train with Cards (“still relevant?”), and keep learning in Triage without auto-archiving leave-in-Inbox users.

**Architecture:** Pure inference and relevance mapping in `src/lib/v2/intelligence/mailbox-style.ts`; durable style + events in Postgres; commands `confirmMailboxStyle`, `trainRelevance`, `dismissStyleDrift`; Focus mailbox sort; first-run overlay + Cards UI; style injected into read context.

**Tech Stack:** Next.js App Router, Postgres (`seer` schema), existing command bus, V3 MailClient.

## Global Constraints

- Do not archive or trash provider mail for `clearHabit: leave`.
- Do not load the full Inbox into Atlas; matters plus recent non-hidden rows only.
- User confirm beats inference; drift asks, it does not silently rewrite.
- Tests: `tsx scripts/….test.mts` via `package.json` `test:v2` / `test:v3`.

---

### Task 1: Schema + pure style logic

**Files:**
- Create: `supabase/migrations/20260831120000_mailbox_style.sql`
- Create: `src/lib/v2/intelligence/mailbox-style.ts`
- Create: `scripts/v2-mailbox-style.test.mts`
- Modify: `scripts/v2-schema.test.mts`, `scripts/v3-schema.test.mts`, `package.json`

- [x] Migration: `conversations.focus_hidden`, `seer.mailbox_styles`, `seer.training_events`, RLS/grants
- [x] `inferStyle`, `relevanceOutcome`, `detectDrift`, `styleGuidance`
- [x] Tests for leave vs archive inference, relevance mapping, drift
- [x] Register tests in `package.json`

### Task 2: Persistence + commands

**Files:**
- Create: `src/lib/v2/intelligence/mailbox-style-store.ts`
- Modify: `src/lib/v2/commands/types.ts`, `execute.ts`
- Modify: `src/lib/v2/intelligence/context.ts`, `context-loader.ts`
- Create: `src/app/api/v2/mailbox-style/route.ts`
- Modify: `scripts/v2-commands.test.mts`, `scripts/v2-context-feedback.test.mts`

- [x] Load snapshot, upsert inference, confirm, record events, hide from focus
- [x] Commands execute outcomes; leave does not enqueue archive
- [x] Context line for the brain

### Task 3: Focus mailbox + Atlas bound

**Files:**
- Modify: `src/lib/v3/mailbox/types.ts`, `cursor.ts`, `repository.ts`
- Modify: `src/app/api/v3/mailbox/route.ts`
- Modify: `src/lib/v2/view/build.ts`
- Modify: `scripts/v3-mailbox-view.test.mts`

- [x] `sort=focus` query
- [x] Atlas omits old hidden non-matters

### Task 4: Cards + first-run UI

**Files:**
- Modify: `src/components/v3/triage-deck.ts`, `TriageCards.tsx`
- Create: `src/components/v3/MailboxStyleSetup.tsx`
- Modify: `MailClient.tsx`, `useMailbox.ts`, `mailbox-state.ts`, `Settings.tsx`, `globals.css`
- Modify: deck/UI tests, `package.json` if needed

- [x] Still-relevant flow
- [x] Overlay + Settings
- [x] Cards fetch `sort=focus`
