# Atlas Chief of staff Implementation Plan

> **For agentic workers:** inline execution in this session. TDD for schema,
> seed mapping, webhook, and commands. Atlas UI covered by a contract test.

**Goal:** Delegated bot tasks, Chief of staff chat, and approval-gated triage
proposals live in Atlas, with a SQL+webhook contract for the external bot.

**Architecture:** New `seer` staff tables + v2 commands + Atlas/reader UI.
Approved mail actions reuse the existing command/outbox path. Bot never hits
the browser.

**Tech Stack:** Next.js, Postgres (`seer` schema), v2 command bus, existing
Atlas whiteboard CSS.

## Global Constraints

- Follow v2 commands with idempotency keys; session via `getActiveV2Account`.
- Do not break mail sync/triage or the Atlas board contract (no matter modal).
- Never permanently delete mail; `delete` = trash.
- Do not apply migrations to production or deploy production.
- RLS on; `seer_app` DML; `seer_bot` limited to staff tables.

---
