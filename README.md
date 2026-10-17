# Seer

RDI’s AI mail desk. It reads the inbox, puts live work on **Atlas**, and helps you clear the rest in **Triage**. Desktop is `/`. Phone is `/m`.

This is not a generic Gmail clone. After sign-in (`@rditrials.com`, plus any extras in `SEER_ALLOWED_EMAILS`) you stay in one shell: Inbox, Triage, Cards, Atlas, and the Delegated band for bot tasks.

## Product surfaces

| Place | What it is |
|---|---|
| Inbox | Chronological mail |
| Triage / Cards | Clear the pile the AI already judged |
| Atlas | Live matters pulled from email |
| Delegated | Bot tasks, Chief of staff chat, Approve/Reject mail proposals |
| Settings | Connect Google / Microsoft mailboxes |

Nothing the Chief of staff bot proposes moves until you Approve it in Atlas.

## Run locally

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local`. You need `AUTH_SECRET`, Google and/or Microsoft OAuth clients, `SEER_V2_DATABASE_URL` as role `seer_app`, and `SEER_CREDENTIAL_KEY`. Extra personal mailboxes go in `SEER_ALLOWED_EMAILS` (the owner Gmail is **not** hardcoded).

```bash
npm test
npm run test:v2
npm run test:v3
npx tsc --noEmit
npm run build
```

## Docs

- `docs/bot-integration-contract.md` — how the bot talks to Seer (SQL + optional webhook). **Polling is the current production mode**; `SEER_BOT_WEBHOOK_*` is unset.
- `docs/atlas-product-status.md` — Atlas status
- `docs/legacy-vs-v2-user-stories.md` — old vs current client
- `supabase/migrations/` — schema. Harden/reverse staff RLS with `20261017140000_harden_rls_and_retention.sql` and the matching file under `supabase/migrations/down/`.

## Ops notes

- **Gmail push** stays on the 5-minute cron plus the existing Pub/Sub URL until `GMAIL_PUBSUB_VERIFICATION_TOKEN` (or `GMAIL_PUSH_AUDIENCE`) is set on Vercel **and** the GCP subscription sends that token. Unsigned POSTs are still accepted until then.
- **Events retention** (`/api/cron/events-retention`, daily) deletes rows in `seer.events` older than 90 days. It does not delete conversations, messages, decisions, yields, matters, outbox, or staff tables.
- **Preview OAuth:** copy `AUTH_GOOGLE_*`, `AUTH_MICROSOFT_ENTRA_ID_*`, and `AUTH_SECRET` to Preview. Do **not** copy `AUTH_URL` (Auth.js `trustHost` must use the preview host). Register the preview callback URIs in Entra and Google (exact hosts; no wildcard).
