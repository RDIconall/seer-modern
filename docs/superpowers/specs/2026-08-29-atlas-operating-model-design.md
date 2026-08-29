# Atlas operating model (per-mailbox categories)

## Problem

Atlas shelves are seeded from a CEO/CRO function list (`board`, `operations — studies`, …). That registry is the filing vocabulary: the model may not invent sections. A personal mailbox (or another RDI role) therefore lands with empty columns or everything unfiled. Users cannot edit the registry, and Seer never looks at how *this* person already treats mail.

## Goal

Each mailbox has its own Atlas split, proposed from evidence, then edited like Superhuman split inboxes:

1. Seer samples **starred/saved**, **sent**, **trash**, live **inbox**, existing **matters**, and **Salesforce** activity (when connected).
2. One strong-model call (AI Gateway: Claude, with ChatGPT/Gemini fallbacks) proposes functions (work) and topics (not-work mail).
3. The user edits names, order, and a short **guidance** paragraph (“family logistics are matters; newsletters are topics”).
4. Apply replaces the live registry. Automatic filings that used old names are cleared so the cheap filing pass re-homes them. User-made filings are kept.

## Non-goals

- Shared/org-wide taxonomies
- Auto-applying a proposal without a tap
- Training a custom model
- Full historical folder backfill as a prerequisite (propose live-samples one page per folder)

## Data

`seer.operating_models` (one row per mail account): `guidance`, last `proposal` JSON, timestamps.

`seer.functions` remains the live shelves. Cron `seedFunctions` only plants CEO defaults when the registry is **empty**, so a custom apply is not overwritten.

## API

- `GET /api/v2/operating-model` — live registry, guidance, last proposal, sample counts
- `POST /api/v2/operating-model` `{ action: "propose", note? }` — sample + model; stores proposal, does not apply
- Command `applyOperatingModel` — persist guidance + replace registry (idempotent)

## Filing

Filing and chief-of-staff context treat user guidance as `[explicit]` law, after the existing safety floor.
