# Seer Clean-Slate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Seer's competing classifiers, blob persistence, parallel
product paths, and partial provider adapters with one context-rich
conversation decision system underneath a dependable Gmail/Outlook client.

**Architecture:** Build a versioned v2 path beside the current application,
run it in read-only shadow mode, compare it with a full-email baseline, then
cut over one account and delete the legacy path. Supabase Postgres is the sole
durable store; Gmail and Outlook implement one provider contract; all product
surfaces render one server-produced conversation projection.

**Tech Stack:** Next.js 15 App Router, TypeScript, React 19, `pg`, Supabase
Postgres migrations, Redis as cache only, Zod, Vercel AI SDK, Node test runner
through `tsx`.

## Global Constraints

- A Seer judgment must not be materially worse than a context-free,
  full-conversation AI read.
- A snippet, keyword rule, stale provider label, UI component, or provider
  adapter may never decide a conversation's home.
- Incomplete or uncertain reads remain visible as `undecided`.
- Useful business meaning must be persisted before its source conversation
  becomes eligible for deletion.
- Safety policy is veto-only: it may change `delete` to `undecided` and may
  not choose another home.
- Gmail and Outlook must pass the same provider contract suite before cutover.
- Postgres is the only durable store. Redis is an explicit cache and never a
  write fallback.
- Credentials are encrypted, server-only, and scoped to one mail account.
- All mutations are conversation-complete, idempotent, audited, and report
  partial failure.
- Existing inferred briefs, reads, people tiers, relationships, and matters
  are regenerated. Connected accounts and explicit user intent are preserved.
- Every task uses test-first development and ends in its own commit.

---

## File map

New v2 code lives under focused boundaries and does not import the legacy
classifier or brief builder.

```text
supabase/migrations/              reviewed schema migrations
src/lib/v2/db/                    database pool, transactions, repositories
src/lib/v2/crypto/                credential envelope encryption
src/lib/v2/providers/             provider contract, Gmail, Outlook, fake
src/lib/v2/sync/                  incremental ingestion and reconciliation
src/lib/v2/intelligence/          decision schema, reader, yields, safety
src/lib/v2/eval/                  baseline comparison and release gates
src/lib/v2/view/                  one inbox projection
src/lib/v2/commands/              idempotent mutation command handlers
src/app/api/v2/                   v2 read, command, sync, and shadow APIs
src/components/v2/               responsive mail shell and render-only views
scripts/v2-*.test.mts             domain, provider, security, and flow tests
```

## Task 1: Versioned relational foundation

**Files:**
- Create: `supabase/config.toml`
- Create: migration via `npx supabase migration new seer_v2_core`
- Create: `src/lib/v2/db/pool.ts`
- Create: `src/lib/v2/db/transaction.ts`
- Create: `src/lib/v2/db/types.ts`
- Create: `scripts/v2-schema.test.mts`
- Modify: `package.json`

**Interfaces:**
- Produces: `db(): Pool`
- Produces: `inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>`
- Produces: branded identifiers `UserId`, `AccountId`, `ConversationId`,
  `DecisionId`, and `MatterId`

- [ ] **Step 1: Initialize Supabase migration tooling**

Run:

```bash
npx supabase --version
npx supabase init
npx supabase migration new seer_v2_core
```

Expected: Supabase creates `supabase/config.toml` and prints the exact migration
path. Use that generated path for all SQL in this task.

- [ ] **Step 2: Write the failing schema test**

Create `scripts/v2-schema.test.mts` to connect with `POSTGRES_URL`, query
`information_schema.tables`, and assert these private-schema tables exist:

```ts
const expected = [
  "users",
  "mail_accounts",
  "oauth_credentials",
  "conversations",
  "messages",
  "people",
  "relationship_evidence",
  "matters",
  "matter_conversations",
  "conversation_decisions",
  "decision_evidence",
  "yields",
  "interest_signals",
  "events",
  "command_receipts",
  "sync_state",
  "sync_runs",
];
assert.deepEqual(actual.sort(), expected.sort());
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx tsx scripts/v2-schema.test.mts`  
Expected: FAIL because schema `seer` and its tables do not exist.

- [ ] **Step 4: Define the complete schema**

In the generated migration, create private schema `seer`, revoke access from
`anon` and `authenticated`, and create the tables above. Every business row
has `account_id uuid`, timestamps, and foreign keys. Add:

```sql
alter table seer.mail_accounts enable row level security;
alter table seer.conversations enable row level security;
alter table seer.messages enable row level security;
alter table seer.people enable row level security;
alter table seer.matters enable row level security;
alter table seer.conversation_decisions enable row level security;
alter table seer.yields enable row level security;
alter table seer.events enable row level security;
```

Use unique constraints on provider account identity, provider conversation
identity, provider message identity, decision version, event idempotency key,
and command idempotency key. Add indexes for account/date, account/home,
account/person email, matter status, and sync cursor lookup.

- [ ] **Step 5: Add the typed database boundary**

`src/lib/v2/db/pool.ts` must require a durable connection in production and
must not create schema:

```ts
export function db(): Pool {
  const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("POSTGRES_URL is required for Seer v2");
  return singletonPool(url);
}
```

`inTransaction` issues `BEGIN`, commits on success, and rolls back on any
exception.

- [ ] **Step 6: Apply and verify**

Run:

```bash
npx supabase db push --linked
npx tsx scripts/v2-schema.test.mts
npx tsc --noEmit
```

Expected: schema test PASS and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add supabase src/lib/v2/db scripts/v2-schema.test.mts package.json
git commit -m "Build Seer v2 relational foundation"
```

## Task 2: Encrypted accounts and explicit-intent migration

**Files:**
- Create: `src/lib/v2/crypto/credentials.ts`
- Create: `src/lib/v2/db/accounts.ts`
- Create: `src/lib/v2/db/intent.ts`
- Create: `scripts/v2-credentials.test.mts`
- Create: `scripts/migrate-v2-accounts.mts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `inTransaction`
- Produces: `encryptCredential(plaintext: string): EncryptedValue`
- Produces: `decryptCredential(value: EncryptedValue): string`
- Produces: `getAccount(accountId: AccountId): Promise<MailAccount>`
- Produces: `getCredentials(accountId: AccountId): Promise<ProviderCredential>`

- [ ] **Step 1: Write encryption and isolation tests**

Tests assert:

```ts
assert.notEqual(encryptCredential("refresh-token").ciphertext, "refresh-token");
assert.equal(decryptCredential(encryptCredential("refresh-token")), "refresh-token");
assert.throws(() => decryptCredential(tampered), /authentication/i);
assert.equal(await repository.getOwned(userA, accountB), null);
```

Also query `oauth_credentials` and assert plaintext tokens do not occur in any
text representation of persisted rows.

- [ ] **Step 2: Verify the tests fail**

Run: `npx tsx scripts/v2-credentials.test.mts`  
Expected: FAIL because encryption and repositories do not exist.

- [ ] **Step 3: Implement AES-256-GCM envelope storage**

Use Node `crypto` with a 32-byte `SEER_CREDENTIAL_KEY`. Persist `{ version,
iv, ciphertext, tag }`; authenticate account ID as additional data. Reject
missing keys in production.

- [ ] **Step 4: Implement account repositories**

Every query includes both `user_id` and `account_id`. Token refresh updates
credentials inside a transaction using an optimistic `version` predicate.

- [ ] **Step 5: Build the one-shot migration**

`scripts/migrate-v2-accounts.mts` reads the legacy `accounts` blob once,
creates user/account rows, encrypts credentials, and copies only:

- explicit VIP records
- message-specific corrections
- explicit sender/topic teachings
- manual matter names and links
- explicit closure/reopen events

It does not copy inferred reads, tiers, relationships, briefs, digest themes,
or inferred matter assignments. A `--dry-run` prints counts only and never
prints credentials.

- [ ] **Step 6: Verify**

Run:

```bash
npx tsx scripts/v2-credentials.test.mts
npx tsx scripts/migrate-v2-accounts.mts --dry-run
npx tsc --noEmit
```

Expected: tests PASS; dry run reports preserved/discarded counts; no secret
values appear.

- [ ] **Step 7: Commit**

```bash
git add .env.example src/lib/v2/crypto src/lib/v2/db scripts
git commit -m "Encrypt and isolate Seer v2 accounts"
```

## Task 3: One provider contract with a fake reference adapter

**Files:**
- Create: `src/lib/v2/providers/types.ts`
- Create: `src/lib/v2/providers/provider.ts`
- Create: `src/lib/v2/providers/fake.ts`
- Create: `src/lib/v2/providers/http.ts`
- Create: `scripts/v2-provider-contract.test.mts`

**Interfaces:**
- Produces: `MailProvider`
- Produces: `providerFor(account: MailAccount): Promise<MailProvider>`
- Produces: provider-neutral `Conversation`, `Message`, `SyncPage`,
  `MutationReceipt`, and `SendReceipt`

- [ ] **Step 1: Write the shared contract suite**

The suite must execute unchanged against any provider factory and assert:

- pagination past 1,500 messages
- complete HTML and plain-text bodies
- stable conversation IDs and ordered messages
- correct reply/reply-all/forward recipients
- complete conversation archive/trash/restore
- idempotent send and mutation replay
- partial-failure reporting
- exact native deep link

Example:

```ts
const first = await provider.mutateConversation(id, "archive", key);
const replay = await provider.mutateConversation(id, "archive", key);
assert.deepEqual(replay, first);
assert.equal(first.failed.length, 0);
```

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-provider-contract.test.mts`  
Expected: FAIL because the provider contract is absent.

- [ ] **Step 3: Implement types and fake provider**

The fake provider is the executable reference behavior. It stores ordered
messages in memory, applies whole-conversation actions, simulates pagination
and partial failures, and deduplicates idempotency keys.

- [ ] **Step 4: Add shared HTTP behavior**

`providerHttp` handles retries for 429/5xx, `Retry-After`, empty successful
bodies, structured provider errors, abort timeouts, and trace IDs. It never
logs authorization headers or message bodies.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx tsx scripts/v2-provider-contract.test.mts
npx tsc --noEmit
```

Expected: fake adapter contract PASS.

```bash
git add src/lib/v2/providers scripts/v2-provider-contract.test.mts
git commit -m "Define the Seer mail provider contract"
```

## Task 4: Gmail and Outlook parity

**Files:**
- Create: `src/lib/v2/providers/gmail.ts`
- Create: `src/lib/v2/providers/outlook.ts`
- Create: `src/lib/v2/providers/token-service.ts`
- Create: `scripts/v2-provider-gmail.test.mts`
- Create: `scripts/v2-provider-outlook.test.mts`

**Interfaces:**
- Consumes: `MailProvider`, `providerHttp`, encrypted credentials
- Produces: `GmailProvider` and `OutlookProvider`

- [ ] **Step 1: Run the contract suite against mocked provider APIs**

Provide fixtures for Gmail thread/history endpoints and Graph
messages/delta/folder endpoints. Expected initial result: both adapters FAIL
because they do not exist.

- [ ] **Step 2: Implement one token service**

Use a Postgres advisory lock scoped to account ID. Re-read token version after
lock acquisition, refresh only once, rotate the encrypted refresh token, and
use one five-minute expiry skew for both providers.

- [ ] **Step 3: Implement Gmail**

Use history cursors for incremental sync, thread endpoints for conversation
reads/actions, paginated search, real provider IDs in send receipts, and an
exact Gmail conversation URL. Track listed, hydrated, failed, and retried
counts.

- [ ] **Step 4: Implement Outlook**

Use Graph delta links, paginated `/me/messages` conversation queries across
folders, well-known archive/trash folders, complete restore, and exact Outlook
web deep links. Resolve all pages before mutating a conversation; return every
failed message ID.

- [ ] **Step 5: Verify parity**

Run:

```bash
npx tsx scripts/v2-provider-gmail.test.mts
npx tsx scripts/v2-provider-outlook.test.mts
npx tsc --noEmit
```

Expected: the same contract cases PASS for Gmail and Outlook.

- [ ] **Step 6: Commit**

```bash
git add src/lib/v2/providers scripts/v2-provider-*.test.mts
git commit -m "Reach Gmail and Outlook provider parity"
```

## Task 5: Incremental sync and complete-corpus rebuild

**Files:**
- Create: `src/lib/v2/sync/repository.ts`
- Create: `src/lib/v2/sync/engine.ts`
- Create: `src/lib/v2/sync/reconcile.ts`
- Create: `src/app/api/v2/sync/route.ts`
- Create: `scripts/v2-sync.test.mts`
- Modify: `vercel.json`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `MailProvider.sync`
- Produces: `syncAccount(accountId, mode): Promise<SyncRun>`
- Produces: durable coverage `{ providerTotal, stored, pending, failed }`

- [ ] **Step 1: Write sync tests**

Assert cursor resume, replay idempotency, deletion/tombstone handling, failed
hydration accounting, simultaneous webhook/reconciliation safety, and
provider-total reconciliation.

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-sync.test.mts`  
Expected: FAIL because sync engine does not exist.

- [ ] **Step 3: Implement transactional ingestion**

Upsert conversations and messages in pages, save cursor only after the page
transaction commits, and persist a `sync_runs` report with trace ID and
counts. A failed message remains in `failed`; it is not absent from totals.

- [ ] **Step 4: Add authenticated ingress and reconciliation**

`/api/v2/sync` rejects requests unless signature/secret validation succeeds.
Production startup fails if `CRON_SECRET` is absent. Reconciliation uses the
same engine and never runs the legacy classifier.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx tsx scripts/v2-sync.test.mts
npx tsc --noEmit
```

Expected: PASS with total = stored + pending + failed.

```bash
git add src/lib/v2/sync src/app/api/v2/sync scripts/v2-sync.test.mts vercel.json .env.example
git commit -m "Add durable incremental mailbox sync"
```

## Task 6: Single conversation decision and veto-only safety

**Files:**
- Create: `src/lib/v2/intelligence/schema.ts`
- Create: `src/lib/v2/intelligence/safety.ts`
- Create: `src/lib/v2/intelligence/repository.ts`
- Create: `scripts/v2-decision.test.mts`

**Interfaces:**
- Produces: `ConversationDecision`
- Produces: `validateDelete(decision, facts): SafetyResult`
- Produces: `saveDecision(input): Promise<ConversationDecision>`

- [ ] **Step 1: Write decision invariant tests**

Cover:

```ts
assert.equal(validateDelete(deleteDecision, { owner: "you" }).home, "undecided");
assert.equal(validateDelete(deleteDecision, { liveMatterId: "m1" }).home, "undecided");
assert.equal(validateDelete(deleteDecision, { yieldPersisted: false }).home, "undecided");
assert.equal(validateDelete(matterDecision, unsafeFacts).home, "matter");
```

Also reject decisions without a complete thread, evidence references, model
version, or context version.

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-decision.test.mts`  
Expected: FAIL because the schema and policy are absent.

- [ ] **Step 3: Implement schema and repository**

Use Zod for `home`, summary, rationale, owner, ask, matter reference, yields,
evidence references, versions, and timestamps. Save a decision and its
evidence in one transaction. Enforce one current decision per conversation.

- [ ] **Step 4: Implement veto-only validation**

Return the original decision unless `home === "delete"`. For a veto, retain
the proposed decision in audit metadata, set final home to `undecided`, and
record machine-readable reasons. Do not call a model from safety code.

- [ ] **Step 5: Verify and commit**

Run: `npx tsx scripts/v2-decision.test.mts`  
Expected: PASS.

```bash
git add src/lib/v2/intelligence scripts/v2-decision.test.mts
git commit -m "Create one safe conversation decision"
```

## Task 7: Chief-of-staff read and business yields

**Files:**
- Create: `src/lib/v2/intelligence/context.ts`
- Create: `src/lib/v2/intelligence/reader.ts`
- Create: `src/lib/v2/intelligence/yields.ts`
- Create: `src/lib/v2/intelligence/queue.ts`
- Create: `scripts/v2-reader.test.mts`

**Interfaces:**
- Consumes: full `Conversation`, relationships, matters, calendar, CRM,
  explicit intent
- Produces: `readConversation(input): Promise<ConversationDecision>`
- Produces: `persistYields(decisionId, yields): Promise<void>`

- [ ] **Step 1: Write fixture-driven reader tests**

Include:

- Salesforce "ACTION REQUIRED" cannot produce `ask: informational`
- a Roche mention in a newsletter yields a Roche matter connection before
  the newsletter can become deletable
- an HBR article matching explicit leadership interests yields
  `worth_reading`
- unrelated generic news yields nothing
- a saved contact with a real request cannot be deleted
- incomplete body produces `undecided`

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-reader.test.mts`  
Expected: FAIL because the reader is absent.

- [ ] **Step 3: Adapt the useful context compiler**

Port provenance-labeled evidence from `src/lib/brain/context.ts` without
importing the legacy brief or grader. Context is bounded but includes every
directly relevant matter/person/CRM/calendar/interest reference.

- [ ] **Step 4: Implement one structured model call**

The model receives the complete ordered thread and context packet and returns
the decision plus yields in one schema. No fallback classifier is allowed. A
model, timeout, parse, or coverage failure returns `undecided` with a retryable
error.

- [ ] **Step 5: Persist meaning before delete eligibility**

Within one transaction, persist yields, decision evidence, and final safety
result. Only set current home to `delete` after yield persistence succeeds.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx tsx scripts/v2-reader.test.mts
npx tsc --noEmit
```

Expected: all fixtures PASS.

```bash
git add src/lib/v2/intelligence scripts/v2-reader.test.mts
git commit -m "Read conversations as a chief of staff"
```

## Task 8: Baseline and release-gating evaluations

**Files:**
- Create: `src/lib/v2/eval/types.ts`
- Create: `src/lib/v2/eval/baseline.ts`
- Create: `src/lib/v2/eval/compare.ts`
- Create: `scripts/v2-eval.test.mts`
- Create: `scripts/run-v2-eval.mts`
- Create: `fixtures/v2-eval/README.md`

**Interfaces:**
- Produces: `runBaseline(conversation): Promise<BaselineResult>`
- Produces: `compareDecision(baseline, seer, expected): Evaluation`
- Produces: release verdict with deletion safety, baseline regressions, and
  correct added business connections

- [ ] **Step 1: Write comparison tests**

Assert a release fails when Seer misses an ask the baseline catches, places a
baseline-retained email in delete, fabricates a business connection, or fails
to surface an expected client/matter yield.

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-eval.test.mts`  
Expected: FAIL because evaluator does not exist.

- [ ] **Step 3: Implement privacy-controlled fixtures and scoring**

Fixture files contain redacted full threads, expected home, required facts,
forbidden claims, and expected yields. The baseline receives the full thread
but no Seer context. Comparison emits per-case explanations and exits nonzero
for any false-safe-delete decision.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx tsx scripts/v2-eval.test.mts
npx tsx scripts/run-v2-eval.mts --fixtures fixtures/v2-eval
```

Expected: unit tests PASS; benchmark prints baseline and Seer deltas.

```bash
git add src/lib/v2/eval scripts/v2-eval.test.mts scripts/run-v2-eval.mts fixtures/v2-eval
git commit -m "Gate Seer decisions against a full-email baseline"
```

## Task 9: One server-produced inbox view

**Files:**
- Create: `src/lib/v2/view/types.ts`
- Create: `src/lib/v2/view/build.ts`
- Create: `src/lib/v2/view/repository.ts`
- Create: `src/app/api/v2/inbox/route.ts`
- Create: `scripts/v2-inbox-view.test.mts`

**Interfaces:**
- Produces: `InboxView`
- Produces: `buildInboxView(accountId): Promise<InboxView>`
- Produces: render-ready Atlas matters, records, safe-delete rows,
  undecided rows, yields, coverage, and provider totals

- [ ] **Step 1: Write projection tests**

Assert one conversation has one home, counts reconcile, no client policy is
required, matter-linked yields appear on the matter, and undecided rows cannot
have a bulk action token.

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-inbox-view.test.mts`  
Expected: FAIL because view builder does not exist.

- [ ] **Step 3: Implement one SQL-backed projection**

Return final home and signed current-decision token from the server. Delete
rows include a command token only when the current decision remains validated.
Include exact native provider URLs.

- [ ] **Step 4: Verify and commit**

Run: `npx tsx scripts/v2-inbox-view.test.mts`  
Expected: PASS.

```bash
git add src/lib/v2/view src/app/api/v2/inbox scripts/v2-inbox-view.test.mts
git commit -m "Serve one authoritative inbox view"
```

## Task 10: Idempotent command bus and audit

**Files:**
- Create: `src/lib/v2/commands/types.ts`
- Create: `src/lib/v2/commands/execute.ts`
- Create: `src/lib/v2/commands/repository.ts`
- Create: `src/app/api/v2/commands/route.ts`
- Create: `scripts/v2-commands.test.mts`

**Interfaces:**
- Consumes: `MailProvider`, current decision token
- Produces: `executeCommand(command, idempotencyKey): Promise<CommandResult>`

- [ ] **Step 1: Write command tests**

Cover replay, stale decision rejection, partial provider failure, transactional
event recording, restore/undo, message correction versus explicit sender
teaching, and send/reply/reply-all/forward receipts.

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-commands.test.mts`  
Expected: FAIL because command bus is absent.

- [ ] **Step 3: Implement command execution**

Check ownership and idempotency first. For delete, verify the signed decision
is current and home remains `delete`. Execute provider mutation, persist
receipt/event, update projection, and return partial failures without hiding
failed messages.

- [ ] **Step 4: Verify and commit**

Run: `npx tsx scripts/v2-commands.test.mts`  
Expected: PASS.

```bash
git add src/lib/v2/commands src/app/api/v2/commands scripts/v2-commands.test.mts
git commit -m "Unify mail and matter commands"
```

## Task 11: Dependable Reader, compose, and native escape hatch

**Files:**
- Create: `src/components/v2/Reader.tsx`
- Create: `src/components/v2/MessageHtml.tsx`
- Create: `src/components/v2/Compose.tsx`
- Create: `src/components/v2/ConversationActions.tsx`
- Create: `scripts/v2-mail-client.test.mts`

**Interfaces:**
- Consumes: `InboxView`, conversation API, command API
- Produces: HTML rendering, attachments, reply, reply-all, forward, compose,
  archive, delete, undo, mark-unread, and exact native links

- [ ] **Step 1: Write mail-client behavior tests**

Use rendered fixtures to assert safe HTML sanitization, inline-image mapping,
message order, reply-all recipient exclusion/deduplication, quoted content,
attachment links, command idempotency key, and provider deep-link target.

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-mail-client.test.mts`  
Expected: FAIL because v2 components do not exist.

- [ ] **Step 3: Implement focused components**

`MessageHtml` sanitizes and renders provider HTML without rewriting legitimate
layout. `Reader` renders the complete conversation. `Compose` owns draft
fields and attachment state. `ConversationActions` renders only capabilities
the active provider contract supports; otherwise it renders the exact native
link.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx tsx scripts/v2-mail-client.test.mts
npx tsc --noEmit
npx eslint src/components/v2
```

Expected: tests and static checks PASS.

```bash
git add src/components/v2 scripts/v2-mail-client.test.mts
git commit -m "Build the Seer conversation client"
```

## Task 12: One responsive Atlas and Triage shell

**Files:**
- Create: `src/components/v2/MailApp.tsx`
- Create: `src/components/v2/Atlas.tsx`
- Create: `src/components/v2/Triage.tsx`
- Create: `src/components/v2/WorthReading.tsx`
- Create: `src/components/v2/useInboxView.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/app/m/page.tsx`
- Create: `scripts/v2-ui-contract.test.mts`

**Interfaces:**
- Consumes: render-ready `InboxView`
- Produces: one responsive application with no placement business logic

- [ ] **Step 1: Write UI contract tests**

Static and rendered tests assert components do not contain
`DELETE_DISPOSITIONS`, disposition-to-bucket maps, relationship rules, or
provider branches. Verify Atlas, records, safe delete, undecided, and worth
reading render from server fields.

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-ui-contract.test.mts`  
Expected: FAIL because v2 shell is absent.

- [ ] **Step 3: Implement the responsive shell behind a flag**

`SEER_V2_ACCOUNT_ALLOWLIST` selects v2 server-side. Desktop and mobile route
to the same `MailApp`; CSS changes layout only. `useInboxView` handles fetch,
focus refresh, optimistic snapshot, rollback, and undo from command receipts.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx tsx scripts/v2-ui-contract.test.mts
npx tsc --noEmit
npx eslint src/components/v2 src/app/page.tsx src/app/m/page.tsx
```

Expected: PASS.

```bash
git add src/components/v2 src/app/page.tsx src/app/m/page.tsx scripts/v2-ui-contract.test.mts
git commit -m "Add one responsive Seer v2 application"
```

## Task 13: Shadow rebuild and cutover gate

**Files:**
- Create: `src/lib/v2/shadow/run.ts`
- Create: `src/lib/v2/shadow/report.ts`
- Create: `src/app/api/v2/shadow/route.ts`
- Create: `scripts/run-v2-shadow.mts`
- Create: `scripts/v2-shadow.test.mts`
- Modify: `docs/atlas-product-status.md`

**Interfaces:**
- Produces: full-corpus progress and old/new/baseline comparison report
- Produces: `cutoverEligible: boolean`

- [ ] **Step 1: Write cutover-gate tests**

Reject cutover for pending/failed coverage, any false-safe-delete benchmark
case, provider parity failure, missing native links, unpersisted yields, or a
nonzero command mutation count from shadow mode.

- [ ] **Step 2: Verify failure**

Run: `npx tsx scripts/v2-shadow.test.mts`  
Expected: FAIL because shadow runner is absent.

- [ ] **Step 3: Implement read-only full-corpus shadow**

Queue every stored conversation for v2 reading, expose honest progress, and
compare old versus v2 versus baseline without issuing provider mutations.
Persist aggregate and per-case reports without storing baseline prompt bodies
in logs.

- [ ] **Step 4: Run the real shadow gate**

Run:

```bash
npx tsx scripts/run-v2-shadow.mts --account conall@rditrials.com
```

Expected: report shows complete coverage and an explicit eligible/ineligible
verdict. Do not enable the flag when ineligible.

- [ ] **Step 5: Commit**

```bash
git add src/lib/v2/shadow src/app/api/v2/shadow scripts docs/atlas-product-status.md
git commit -m "Validate Seer v2 in shadow mode"
```

## Task 14: Cut over, verify end to end, and remove legacy code

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/m/page.tsx`
- Modify: `src/auth.ts`
- Modify: `package.json`
- Delete after coverage verification: legacy classifier, brief, KV, parallel
  API, and duplicate UI files enumerated by `rg` in Step 1
- Create: `scripts/v2-no-legacy.test.mts`
- Modify: `docs/atlas-product-status.md`

**Interfaces:**
- Consumes: all v2 boundaries
- Produces: v2 as the only product path

- [ ] **Step 1: Freeze the deletion inventory**

Run:

```bash
rg -l "classifyInboxWithAssistant|TriageAction|DELETE_DISPOSITIONS|kvGet|kvSet|/api/today|/api/alltasks|/api/nlp/classify" src
```

Classify every result as v2 migration support or legacy runtime. Save the
reviewed runtime list in `scripts/v2-no-legacy.test.mts`; the test fails while
any listed path or forbidden import remains.

- [ ] **Step 2: Verify the no-legacy test fails**

Run: `npx tsx scripts/v2-no-legacy.test.mts`  
Expected: FAIL and list all remaining legacy paths.

- [ ] **Step 3: Enable one-account cutover**

Enable `conall@rditrials.com` only after Task 13 reports eligible. Verify:

- Atlas matter and yield placement
- safe-delete reasoning and vetoes
- undecided visibility
- HTML/thread rendering
- autocomplete
- reply/reply-all/forward
- archive/delete/restore/mark unread
- exact Outlook and Gmail links
- counts equal provider totals

- [ ] **Step 4: Delete the replaced system**

Delete the snippet/rules classifier, decision cache, legacy brief builder,
client bucketing, Today/Cards/old Inbox paths, legacy NLP route/components,
overlapping mutation routes, JSON durable stores, runtime DDL, and duplicate
mobile/desktop business logic. Retain only the one-shot migration reader until
post-cutover verification completes; then delete it in the same task.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npx tsx scripts/v2-provider-gmail.test.mts
npx tsx scripts/v2-provider-outlook.test.mts
npx tsx scripts/run-v2-eval.mts --fixtures fixtures/v2-eval
npx tsx scripts/v2-no-legacy.test.mts
npx tsc --noEmit
npx eslint src scripts
npm run build
```

Expected: all commands PASS; evaluator reports zero false-safe-delete
regressions; no legacy runtime path remains.

- [ ] **Step 6: Manually verify complete browser flow**

For both Gmail and Outlook test accounts:

1. Receive and sync a new conversation.
2. Confirm the full thread and HTML render.
3. Confirm the chief-of-staff decision, rationale, and extracted yields.
4. Reply all and verify provider Sent.
5. Archive, undo, delete, and restore.
6. Open the exact conversation in the provider web application.
7. Confirm Atlas/Triage/provider totals still reconcile.

- [ ] **Step 7: Commit and deploy**

```bash
git add -A
git commit -m "Cut over to the Seer v2 architecture"
git push -u origin cursor/triage-atlas-janitor-spec-889f
```

Deploy the flagged account, inspect the persisted sync/shadow/command reports,
then remove the feature flag only after production verification passes.

## Plan self-review

- Spec coverage: product standard, chief-of-staff yields, one decision,
  veto-only safety, uncertainty, baseline evaluation, complete mail client,
  native escape hatch, provider parity, relational storage, option B reset,
  shadow cutover, and legacy deletion each map to explicit tasks.
- Type consistency: provider, decision, sync, view, and command interfaces are
  defined once and consumed by named later tasks.
- Scope: each task ends in an independently testable commit; the feature flag
  keeps the current branch deployable until cutover.
- Placeholder scan: the plan contains no unfinished implementation marker;
  runtime-generated migration paths are obtained from the required Supabase
  CLI command rather than invented.

