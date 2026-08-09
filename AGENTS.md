# AGENTS.md

## Cursor Cloud specific instructions

### What this is
Seer / Atlas — a single Next.js 15 (App Router, React 19, Turbopack) web app for
AI email triage. There is only one service. Product context lives in
`docs/atlas-product-status.md`; standard scripts live in `package.json`.

### Commands (see `package.json` scripts)
- Dev server: `npm run dev` (Turbopack, http://localhost:3000). Desktop UI at `/`, mobile PWA at `/m`.
- Lint: `npm run lint` (ESLint, `next/core-web-vitals` + `next/typescript`).
- Tests: `npm test` — plain `tsx` scripts under `scripts/*.test.mts` (no test runner). They exercise the core brain (matter clustering, triage view, inbox accounting, mail send, export) with no network or env needed.
- Build: `npm run build` (also Turbopack).

### Running locally — required env
- The app **boots and serves the login screen without any env vars**, but Auth.js logs `MissingSecret` and no auth flow works. For a clean dev run, create a local `.env.local` (it is gitignored — `.env*` — so it does NOT persist across fresh VMs and is not part of the update script):
  ```bash
  printf 'AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" > .env.local
  ```
- `.env.example` documents every optional integration.

### Graceful degradation (why it runs with almost nothing configured)
- **Storage** (`src/lib/store/kv.ts`): Postgres (`POSTGRES_URL`) → Upstash Redis (`UPSTASH_REDIS_REST_URL`/`KV_REST_API_URL`) → local `.data/*.json` files. With none set it uses `.data/` files. Confirm the active backend at `GET /api/health?probe=storage`.
- **Auth** (`src/auth.ts`): Google/Microsoft OAuth providers are only registered when their `AUTH_*` env vars exist. With none set, the login screen shows no OAuth buttons and the **inbox cannot be reached** — the full email-triage flow needs real OAuth credentials (Google Gmail and/or Microsoft Graph) plus a test mailbox, and a Gemini key (`GEMINI_API_KEY`) or Vercel AI Gateway for AI triage. These are external/secret dependencies, not something the VM can self-provision.

### Exercising core functionality without OAuth
- `POST /api/nlp/classify` with `{"text":"..."}` runs the core sentence-level triage brain (action / meeting / pleasantry / non_actionable). It is unauthenticated and falls back to rules-only when `OPENAI_API_KEY` is absent, so it works out of the box.
- `scripts/eval-classifier.mts` re-runs the classifier offline against an exported samples JSON (none is checked in; `fixtures/classifier/` is empty).

### Gotchas
- **Never start a second dev/build against the same checkout.** Turbopack and a plain `next dev` share the `.next` directory; running both corrupts the manifest and the primary server starts returning 500 (`Cannot find module .../[turbopack]_runtime.js`). Recover with: stop the server, `rm -rf .next`, `npm run dev`.
- `src/middleware.ts` only funnels hosts to `AUTH_URL` when `VERCEL_ENV === "production"`, so it is a no-op locally.
