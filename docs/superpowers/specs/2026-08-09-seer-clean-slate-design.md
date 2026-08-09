# Seer Clean-Slate Design

Date: 2026-08-09  
Status: Approved product direction; implementation pending

## 1. Product standard

Seer is a chief of staff built into an email client.

For any email, Seer's judgment must be no worse than the answer the user
would get by pasting the full email into a good general-purpose AI chat and
asking:

> What does this mean, why does it matter to my business, and what should I
> do?

That is the minimum bar, not the goal. Seer should beat the baseline because
it also knows the user's relationships, active matters, prior conversations,
calendar, CRM, business interests, and explicit corrections.

If Seer cannot perform a complete read, it must say "not read yet." It must
never replace a full read with a snippet, keyword rule, stale label, or
lower-quality fallback and present the result as a decision.

## 2. What the chief of staff does

Seer reads every complete conversation for two separate outputs:

1. **The conversation's home**
   - `matter`: live work that belongs on the Atlas board
   - `record`: completed or reference material to archive and retain
   - `delete`: the useful meaning, if any, has been extracted and the email
     itself can be removed
   - `undecided`: Seer has not earned the right to decide

2. **What the conversation yields**
   - a fact, development, risk, opportunity, decision, or next move connected
     to an active matter, client, prospect, person, competitor, or explicit
     user interest
   - an article or document the user is likely to want to read
   - nothing worth retaining

This distinction is essential. A newsletter can be deleted after Seer lifts
out a Roche development and attaches it to the Roche matter. Seer keeps the
meaning and deletes the husk.

Seer does not surface generic "interesting" content. A surfaced insight must
have evidence connecting it to known work or a demonstrated/explicit user
interest. "Worth your time" remains deliberately small.

## 3. One brain and one final decision

Each conversation receives one context-rich semantic read. The read uses:

- the full thread, not a subject or snippet
- people and relationship history
- prior inbound and outbound mail
- active and closed matters
- calendar context
- CRM context
- explicit corrections and preferences
- known business interests

The read produces one persisted `ConversationDecision`:

```ts
type ConversationDecision = {
  accountId: string;
  conversationId: string;
  home: "matter" | "record" | "delete" | "undecided";
  summary: string;
  rationale: string;
  owner: "you" | "team" | "them" | "nobody";
  ask?: string;
  matterId?: string;
  evidenceRefs: string[];
  yields: Yield[];
  modelVersion: string;
  contextVersion: string;
  decidedAt: string;
};
```

Matter clustering may group conversations already marked `matter`, name the
matter, and merge duplicate concerns. It cannot decide whether a conversation
is a matter.

Atlas, Triage, Reader, export, and bulk actions consume this same record. They
must not reinterpret dispositions, sender tiers, snippets, labels, or guide
actions.

## 4. Safety is a constraint, not a second brain

A deterministic policy validates a proposed decision. It cannot classify an
email or choose another home. It can only veto an unsafe `delete` and return
the conversation to `undecided`.

Deletion is vetoed when any of these are true:

- the user owes an answer or action
- a signature, approval, regulatory, legal, or payment step remains
- the conversation is evidence for a live matter
- the sender has a real relationship with the user
- the sender is within the user's organization
- the read contradicts the subject, body, or its own extracted fields
- useful meaning has been detected but not successfully persisted
- the model lacks the full thread or required context

The delete API accepts only the ID of a stored, current, validated decision.
It does not accept arbitrary client-computed buckets.

## 5. Uncertainty and coverage

Uncertain or unread conversations remain visible. They are never placed near
a bulk-delete action.

During a rebuild, the product reports:

- total conversations in the provider inbox
- completely read
- pending
- failed
- placed in Atlas, records, or delete

The accounting must reconcile to the provider's own totals. A hydration or
pagination failure is visible as a shortfall, not silently omitted.

## 6. Evaluation standard

The quality bar is executable:

1. Maintain a representative, privacy-controlled benchmark of full
   conversations and expected outcomes.
2. Run each example through a context-free full-email baseline.
3. Run it through Seer with business context.
4. A release fails if Seer's answer is materially worse than the baseline.
5. Measure whether Seer adds correct business connections and useful yields,
   not merely whether it matches a label.
6. Give false "safe to delete" decisions the highest cost: actionable or
   valuable mail must not enter a bulk-delete set.
7. Add live shadow evaluation: the new pipeline runs without taking actions,
   and its decisions are compared with the existing app and reviewed before
   cutover.

User corrections apply to one conversation by default. Teaching a persistent
sender or topic preference is a separate, explicit action.

## 7. Email client boundary

Seer provides a dependable everyday email client beneath the chief-of-staff
experience:

- faithful sanitized HTML, inline images, links, and attachments
- correct conversation threading
- contact autocomplete from address book and mail history
- compose and send
- reply, reply all, and forward with correct recipients and quoting
- archive, delete, restore/undo, and mark unread
- search
- matching behavior for Gmail and Outlook

Seer does not clone every provider feature. Every conversation has a reliable
**Open in Gmail** or **Open in Outlook** deep link to the exact native
conversation. Provider-native applications remain the escape hatch for
rules, folders, delegated mailbox administration, encryption/sensitivity,
advanced meeting controls, and account settings.

If Seer cannot complete an action safely for a provider, it does not render a
partially working button. It explains the limitation and opens the exact
native conversation.

## 8. Provider architecture

Routes use one required `MailProvider` contract:

```ts
interface MailProvider {
  sync(cursor?: string): Promise<SyncResult>;
  getConversation(id: string): Promise<Conversation>;
  search(query: string, cursor?: string): Promise<SearchResult>;
  send(command: SendCommand): Promise<SendReceipt>;
  reply(command: ReplyCommand): Promise<SendReceipt>;
  forward(command: ForwardCommand): Promise<SendReceipt>;
  mutateConversation(
    id: string,
    action: "archive" | "trash" | "restore" | "markUnread",
  ): Promise<MutationReceipt>;
  nativeUrl(id: string): string;
}
```

Gmail and Outlook must pass the same contract tests before cutover. Provider
branching is confined to the adapters. Conversation actions are paginated,
thread-complete, idempotent, and report partial failures.

Push/webhook-driven incremental sync is primary. A reconciliation cron repairs
missed events and drains the initial corpus; it is not the normal full-scan
engine.

## 9. Storage and security

Supabase Postgres becomes the sole durable system of record. Redis is an
explicit versioned cache, never a fallback database or dual-write mirror.

Core relational tables:

- users and mail accounts
- encrypted OAuth and integration credentials
- messages and conversations
- people and relationship evidence
- conversation decisions and decision evidence
- matters and matter conversations
- extracted yields and interest signals
- append-only commands/events for mutations, corrections, closure, and undo
- sync cursors and run reports

Every durable row is account-scoped. Schema changes use reviewed migrations;
the application performs no runtime DDL. Writes use transactions, idempotency
keys, and optimistic versions where concurrent user and background changes
can collide.

OAuth, Salesforce, and other integration credentials are encrypted and stored
per account. They are not kept in a shared JSON document or exposed in client
sessions.

## 10. Product and API architecture

There is one server-produced inbox view model. Atlas, Triage, counts, search,
Reader, and export are projections of the same durable decisions.

The browser is render-only for business placement. It does not compute safe
to delete, category roots, relationship protections, or final homes.

Writes go through idempotent commands such as:

- correct this conversation
- teach this sender/topic
- archive/trash/restore conversation
- create/rename/move/close/reopen matter
- send/reply/reply-all/forward

Commands return the updated server projection and append an audit event.
Optimistic UI uses one snapshot/rollback/undo mechanism.

Mobile and desktop share one responsive application and the same domain
components. Layout may differ; behavior and data contracts may not.

## 11. Reset and migration: option B

Preserve:

- connected mail accounts, after moving credentials into encrypted storage
- explicit user corrections and preferences
- explicit VIP choices
- manual matter names, closures, and deliberate user-created matter links
- provider message state

Discard and regenerate:

- briefs and digest themes
- snippet/rules classifications
- cached guide actions
- inferred people tiers
- inferred relationships
- deep-read understandings and dispositions
- inferred matters and matter assignments
- derived accounting and forecasts

The entire available inbox is rebuilt as one corpus. The UI remains honest
about progress and never gives pending mail a guessed home.

## 12. Code removal

The rewrite removes, rather than adapts, the competing architecture:

- the snippet/rules classifier and its decision cache
- `TriageAction` as a placement authority
- client-side `DELETE_DISPOSITIONS` and all UI bucketing
- the parallel `/api/today`, Cards, legacy Inbox, and NLP classification paths
- sender teaching masquerading as a one-message correction
- route-level Gmail/Outlook branching
- overlapping single/bulk/triage mutation routes
- the JSON KV system of record, Redis dual-write fallback, and runtime DDL
- stale brief engine/version machinery made unnecessary by durable decisions
- duplicate mobile and desktop business logic
- dead mail/NLP/waiting components

Deletion happens only after the replacement path covers the same user
capability and its tests pass. Old and new decision systems never feed one
another.

## 13. Delivery and cutover

This is a sequence of deployable changes behind a feature flag, not a single
unreviewable code drop:

1. Establish migrations, encrypted accounts, provider contracts, and contract
   tests.
2. Ingest conversations incrementally into the new relational model.
3. Build the single semantic read, yields, safety validation, and evaluation
   suite.
4. Build the one inbox view model and responsive client against it.
5. Run the new system in shadow mode on the full inbox. No provider mutation
   is allowed from shadow decisions.
6. Review baseline-versus-Seer quality, coverage, provider parity, and
   deletion safety.
7. Cut over one account behind the flag.
8. Remove the legacy pipelines, stores, APIs, components, and flags.

The branch remains deployable at every step.

## 14. Acceptance criteria

The rewrite is complete only when:

- one stored decision determines each conversation's home everywhere
- no snippet, keyword, UI, or provider label can make a placement decision
- Seer is not materially worse than the full-email baseline on the benchmark
- useful business meaning is persisted before its source email can be deleted
- every visible count reconciles with provider totals and reports failures
- Gmail and Outlook pass the same provider contract tests
- common email-client operations work end to end for both providers
- every conversation has a verified native-provider deep link
- credentials are encrypted and account-scoped
- Supabase migrations, transactions, constraints, and RLS protect durable data
- bulk actions are idempotent, auditable, reversible where providers allow,
  and never client-authorized from derived fields
- legacy classifiers, parallel product paths, JSON durable stores, duplicate
  UI logic, and dead routes/components are deleted

