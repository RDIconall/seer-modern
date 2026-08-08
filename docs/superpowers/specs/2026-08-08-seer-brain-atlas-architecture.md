# Seer: email as intake, the brain as context, Atlas as the work

Date: 2026-08-08
Status: draft — awaiting user review

## Product thesis

Seer takes the streams that reveal a person's work:

- email — what arrived, changed, was requested, and who is waiting
- current activity — files, notes, applications, and time spent
- relationships — customers, board, team, advisers, vendors, family
- calendar — what happened, who attended, and what is coming
- systems of record — the authoritative stage, status, value, and owner
- past behavior — what the user reads, answers, keeps, deletes, closes,
  corrects, and reverses

It turns those streams into a living forecast of:

- what the user's real projects and concerns are
- what changed
- what matters now
- what will matter next
- who owns the next move
- which work is active, waiting, blocked, complete, or merely noise

**Email is the intake. Seer is the brain. Atlas is the display of email in
a new way: not a queue of messages, but a current and forecast state of
the user's work.**

The promise is:

> Give Seer your email, what you are doing, where your contacts live, and
> where your calendar and systems of record live. Seer will forecast your
> projects and work by turning email into exactly what matters, when.

## Product boundaries

### Email is evidence, not the unit

An email is an incoming observation. A thread is a conversation. Neither
is the thing the user is managing. The managed unit is a **matter**:

> One real-world concern that explains why a group of conversations,
> documents, meetings, and actions still matters — a deal, negotiation,
> inspection, dispute, purchase, board decision, hiring process, product
> launch, family concern, or any equivalent concern in the user's role.

A matter has stable identity across days and systems. It carries:

- title and stable id
- goal — what must be true for the matter to be complete
- narrative — the current state in one sentence
- next action — the single next move
- owner — user, team, counterparty, or nobody
- urgency and consequence
- status — active, waiting, blocked, dormant, looks-closed, closed, reopened
- org category and optional subcategory
- people and relationship types
- conversations, documents, notes, meetings, activity, and CRM/project records
- dates, amounts, stages, and other authoritative facts
- provenance for every important assertion

### Atlas is the application

Atlas is not another inbox tab. It is the whole product surface:

- the current matters and their state
- time-sensitive queues such as signatures
- the organization-specific map of work
- a forecast of what matters when
- filed records with no ongoing story
- a compressed digest of FYI and disposable mail
- the small set of decisions where Seer needs the user
- a ledger of what Seer did automatically

Traditional chronological mail remains available as recovery and audit,
not as the primary mental model.

### Triage is a function, not a destination

Triage sits on top of Atlas and performs two jobs:

1. Clear what was never related to a matter.
2. Flag what has stopped being a matter because later evidence superseded
   it or an authoritative system says its lifecycle changed.

Triage does not decide what work is important using a competing model.
It consumes the same brain and evidence as Atlas.

## The Seer brain

The brain is a personalized evidence and forecasting system. It is not a
single prompt and not a generic email classifier.

It has five cooperating parts:

1. **Personal operating model** — how this user names and organizes work
2. **Relationship and entity graph** — who and what the work concerns
3. **Signal store** — normalized observations from every connected source
4. **Context compiler** — retrieves the smallest complete packet of
   relevant, current, sourced context for each judgment
5. **Reasoning pipeline** — understands new evidence, updates matters,
   forecasts work, and proposes or performs actions

### 1. Personal operating model

The personal operating model belongs to the user. It contains:

- their category hierarchy and descriptions
- their language for projects, functions, and responsibilities
- explicit roles: customers, board, team, advisers, vendors, family
- protected people and classes of work
- user-created and user-renamed matters
- examples of correctly categorized work
- corrections, rejected suggestions, and reversals
- autonomy preferences by action and reason
- connected systems and which one is authoritative for which work

The existing categories are the first user's categories, not Seer's
universal taxonomy. Other users receive an inferred draft from their
mailbox, contacts, calendar, role, and connected systems. They can rename,
merge, split, add, remove, and reorder it. Suggested categories never
become permanent without user confirmation.

The model receives the user's registry verbatim. It does not translate
the user's world into hidden generic buckets and then translate back.

### 2. Relationship and entity graph

The graph represents:

- people and their relationship to the user
- organizations and domains
- matters and projects
- documents and notes
- meetings and calendar events
- systems-of-record objects
- study, opportunity, account, ticket, project, and other role-specific ids

Edges carry type, source, confidence, first observed date, last confirmed
date, and optional expiry. Examples:

- Sandy → board member of the user's company (explicit, durable)
- Sandy → attended Board Meeting on Aug 6 (calendar, historical fact)
- Board Meeting → FY2027 operating plan matter (inferred, 0.91)
- Roche opportunity → stage Negotiation, $480k (Salesforce, authoritative)
- RDI_SOW-010.docx → Roche anti-TPO matter (filename/code match, 0.99)

Relationship labels are facts when explicitly set or sourced from an
authoritative system; otherwise they remain visible inferences.

### 3. Normalized signals

Every source becomes a common evidence record:

```ts
type Signal = {
  id: string;
  accountId: string;
  source:
    | "email"
    | "calendar"
    | "contacts"
    | "crm"
    | "project-system"
    | "drive"
    | "notes"
    | "timeglass"
    | "user-action";
  kind: string;
  at: string;
  observedAt: string;
  actorIds: string[];
  entityIds: string[];
  matterCandidates: string[];
  summary: string;
  facts: Record<string, unknown>;
  confidence: number;
  authority: "explicit" | "system" | "observed" | "inferred";
  expiresAt?: string;
  sourceRef?: string;
};
```

Adapters own source-specific authentication, refresh, pagination,
webhooks/polling, and normalization. The brain consumes signals and does
not contain provider-specific logic.

### 4. Context compiler

The context compiler is the center of the brain. It does not dump all
known data into every prompt. It assembles the smallest packet that is
complete for the current decision.

For an email from Sandy after a board meeting, the packet might be:

```text
USER
Conall — CEO

SENDER
Sandy — board member [explicit]
Relationship: senior, close [explicit]
User replied to 18 of 20 messages; median reply time 42m [observed]

RECENT EVENTS
Board Meeting — Aug 6; Sandy attended [calendar]

RELATED MATTER
FY2027 operating plan [0.91 inferred match]
Goal: board approves operating plan
State: revised forecast requested after Aug 6 meeting
Next action: Conall approves hiring assumptions

EXTERNAL FACTS
No customer/vendor relationship [CRM]
Category: Board [user registry]

CURRENT EMAIL
[full body]

DECISION
What changed? What is asked? Who owns the next move?
Does this update an existing matter?
Can it safely leave the inbox?
```

Every included statement is labeled as:

- **fact** — explicit or authoritative
- **observation** — directly measured behavior
- **inference** — model-derived with confidence

Each statement carries recency. Durable facts ("Sandy is a board member")
persist. Situational context ("we just had a board meeting") decays as
current context while remaining historical fact.

Retrieval order:

1. explicit user truth and protected relationships
2. authoritative system-of-record facts
3. current matter state and unresolved goal
4. recent calendar, work, and communication signals
5. behavioral evidence
6. similar user-approved examples
7. model inferences

Conflicts are surfaced and resolved by authority, then recency. A model
inference never overwrites an explicit user correction or CRM stage.

### 5. Reasoning pipeline

The pipeline separates understanding from portfolio reasoning:

#### Stage A — understand each intake item

Each email receives one full read, cached by content/version:

```ts
type Understanding = {
  id: string;
  threadId: string;
  version: number;
  readAt: string;
  kind: string;
  oneLine: string;
  ask: string;
  owner: "you" | "team" | "them" | "nobody";
  deadline?: string;
  expires?: string;
  amounts?: number[];
  entities: string[];
  signature?: SignatureAsk;
  org: { unit: string; confidence: number };
  importance: number;
  disposition: "matter" | "record" | "fyi" | "disposable";
  matterCandidates: { id: string; confidence: number; why: string }[];
  contextRefs: string[];
};
```

The understanding prompt receives the compiled context packet, not only
the body. The same email can therefore be judged correctly for this user:
a short note from a board member after a board meeting is not treated like
a generic FYI.

Not-yet-read email is not triaged. It remains visible as "being read."
Rules may extract exact facts but may not silently decide disposal.

#### Stage B — update the matter

Messages collapse into conversations. New understandings and external
signals update the relevant matter:

- changed narrative
- achieved or changed goal
- next action and owner
- urgency and consequence
- new artifacts and participants
- authoritative stage/status/value
- lifecycle status

The update must explain what changed since the prior state. Matter
identity remains stable; user-created matters and names always win.

#### Stage C — forecast the portfolio

The forecast orders matters by consequence and dependency, not email
arrival:

- action required before a real deadline
- work that blocks other people or matters
- deteriorating risk if untouched
- external commitments and upcoming meetings
- CRM close dates, stages, amounts, or equivalent role-specific facts
- demonstrated activity and available capacity
- waiting work whose next review point has arrived

The forecast outputs:

- **Now** — actions that cost money, trust, or progress if delayed
- **Next** — upcoming work and preparation windows
- **Waiting** — the ball is elsewhere, with a reason and next review event
- **At risk** — signals conflict, a deadline is near, or activity diverges
  from stated priority
- **Quiet but alive** — long-tail matters with authoritative open status
  or current work activity

## Source architecture

### Email: the intake stream

Email remains the highest-volume source of change:

- full body and headers
- conversation/thread identity and who spoke last
- attachments and links
- asks, deadlines, commitments, confirmations, and superseding events
- user actions: opened, replied, archived, deleted, restored

Email is read continuously in the background. Coverage reconciles against
the provider's own totals. Newest and potentially consequential mail is
read first; progress is explicit.

### Calendar and contacts

Calendar supplies:

- meetings, attendees, organizer, response state
- recent shared context ("we just had a board meeting")
- future commitments and preparation windows
- evidence that a relationship is active

Contacts supply names and explicit organization/role data when present.
Auto-collected addresses are observations, not proof of relationship.

### Files, cloud storage, and notes

Adapters cover Google Drive, OneDrive/SharePoint, and note systems.

Metadata is ingested first:

- file/note title
- path or workspace
- created, modified, opened, and shared timestamps
- collaborators
- source id and permission

Content is retrieved on demand only when it would materially improve a
decision and the user granted access. Names, paths, ids, and timestamps
usually establish matter affinity and liveness without copying content.

File activity changes the brain's judgment:

- a document edited yesterday proves its matter is alive
- a document title supplies the user's vocabulary
- a study/opportunity code joins activity to CRM and email
- a final executed artifact may supply closure evidence
- active work protects related mail from cleanup

### Timeglass: observed work

Timeglass supplies what the user actually worked on:

- application and document activity
- inferred tasks/projects
- time allocation
- current and recent work

The adapter should use Timeglass's supported integration surface (MCP if
available for the deployed account; otherwise a documented API/export).
It normalizes project/activity output into signals. Seer does not ingest
raw screenshots by default; it consumes Timeglass's structured task and
activity summaries unless the user explicitly enables richer evidence.

Timeglass projects and Seer matters are two views of the same concerns:
Timeglass observes work performed; Seer observes requests and commitments.
They join by codes, counterparties, people, document names, and confirmed
user mappings.

Timeglass is especially important for lifecycle:

- email silence plus recent work means **quiet but alive**
- stated priority with no observed work may mean **at risk**
- work across multiple artifacts may reveal a matter before email labels it
- time spent provides capacity and priority evidence

### Systems of record

Salesforce is the first system-of-record adapter, not a hardcoded universal
assumption. The common contract is:

```ts
type SystemRecord = {
  provider: string;
  type: string;
  id: string;
  title: string;
  stage?: string;
  status?: string;
  owner?: string;
  value?: number;
  startDate?: string;
  targetDate?: string;
  closedAt?: string;
  entities: string[];
  url?: string;
  authoritativeFields: string[];
};
```

Examples by role:

- CEO/revenue: Salesforce opportunities, accounts, studies, sites
- engineering: Linear/Jira projects and issues
- recruiting: ATS candidates and requisitions
- consulting: PSA engagements and budgets
- legal: matter-management records

The connected system is authoritative for declared fields such as stage,
status, value, and owner. The model may explain those facts but cannot
rewrite them.

For the initial Salesforce integration:

- open opportunities protect long-tail sales matters from stale-by-silence
- Closed Won/Lost is strong lifecycle evidence
- active/completed/terminated study status drives operations lifecycle
- stage, value, close date, and investigators enrich forecasting
- dormant inbox work may be handed off to the CRM: archive the mail while
  preserving a deep link and matter summary

Writing an activity/note back to Salesforce is a later adapter capability.
The initial handoff can be read-only and auditable.

## Matter lifecycle

Lifecycle is event-driven, not timer-driven.

### Events that can change lifecycle

- a later message supersedes an earlier request
- a goal is achieved (signed, approved, paid, delivered, decided)
- the system of record changes stage/status
- the user explicitly closes or reopens the matter
- a new email reopens a closed concern
- current file/note/time activity proves work is still underway
- a meeting creates a new preparation or follow-up phase

### Silence

Silence alone never closes a matter. It may create a review flag:

- "No new evidence; worth reviewing?"
- "Open opportunity, quiet for 90 days"
- "No activity observed despite a near target date"

Long-tail matters tied to an open authoritative record or recent work
activity are protected as quiet but alive.

### Closure and reopening

Closure records persist:

```ts
type MatterClosure = {
  matterId: string;
  closedAt: string;
  reason: string;
  evidenceRefs: string[];
  by: "user" | "system" | "seer";
  handoff?: { provider: string; recordId: string; url?: string };
};
```

Closed matters do not silently reappear during rebuilding. New evidence
after `closedAt` can create an explicit **Reopened** state with the reason.
Seer proposes closures in the first release; it does not autonomously
close matters.

## Atlas experience

### Primary structure

Atlas presents the user's category hierarchy, not a Seer-defined taxonomy.
Within each category:

- pinned time-sensitive queues
- matters ordered by forecast
- filed records
- quiet but alive matters

A matter row answers without opening it:

- What is this?
- What changed?
- What is the goal?
- What happens next?
- Whose court is it?
- Why now?

Opening a matter feels like opening a project:

- current narrative and forecast
- goal, next action, owner, status
- CRM/project-system facts
- people and relationship context
- conversation timeline
- files, notes, meetings, and Timeglass activity
- Seer's suggested actions
- provenance: why Seer believes each important claim

### Forecast view

Atlas's top layer is:

- **Now**
- **Next**
- **Waiting**
- **At risk**
- **Quiet but alive**

This is not a second category tree. It is a temporal lens over the same
matters. The category hierarchy remains the durable organization.

### Desktop and mobile

Desktop is dense and action-rich:

- full category tree and forecast
- matter editing, combining, splitting, and reassignment
- documents, CRM, and evidence side-by-side
- batch review and cleanup

Mobile is decision-oriented:

- Now, changes since last open, and quick replies
- signatures, approvals, and short actions
- closure and cleanup confirmations
- matter read view without dense administration

### User control

The user can:

- rename, create, merge, split, close, and reopen matters
- edit goals, categories, owners, and relationships
- confirm or reject inferred relationships and categories
- correct source mappings
- inspect evidence and provenance
- undo every automated mail action

Explicit user edits are ground truth and survive every rebuild.

## Triage: Atlas's janitor

### Noise sweep

The understanding record's disposition drives cleanup:

- `matter` — stays in a matter
- `record` — archives into a findable category
- `fyi` — summarized, then archived or deleted according to user preference
- `disposable` — candidate for deletion

The sweep slate groups proposals by reason and allows row-level unticking.
It never uses sender shape alone.

Hard protection prevents any sweep from touching:

- `owner: "you"` or a real ask
- signatures, approvals, regulatory/legal/government deadlines
- protected people or roles
- mail already belonging to a matter
- mail linked to recently active documents, notes, or Timeglass work
- mail tied to an open system-of-record object

The current `bulk-delete` keyword rule is retired.

### Matter cleanup

Triage flags:

- goal achieved by later evidence
- authoritative record closed/completed/terminated
- superseded requests
- dormant matters suitable for CRM/system-of-record handoff
- conflicts needing a user call

Date thresholds may trigger review, never closure.

### Learning ledger

Every action teaches at its proper level:

| Action | Learning strength and scope |
|---|---|
| Explicit correction | strongest; exact fact/category/relation |
| Undo/reject | strong negative; reason and affected entities |
| Deliberate single action | strong; sender and item pattern |
| Matter close/reopen | strong; lifecycle and identity |
| Repeated natural behavior | moderate; relationship and preference |
| Confirmed bulk sweep | reason-level only |
| Seer's own automatic action | no positive training evidence |

All automatic and confirmed cleanup appears in a **Cleaned ledger** with
reason, evidence, ids, timestamp, source, and one-tap undo.

### Autonomy

Autonomy is per action and reason, not a global switch:

- starts in propose mode except deterministic, proven-safe reasons
- promotes only after enough accepted examples and a very low reversal rate
- demotes immediately after reversals
- auto-actions default to archive before delete
- matter closure remains propose-only initially

The brain never learns from its own automated action as though it were
user approval. This prevents self-reinforcing mistakes.

## Onboarding and adaptation

### Initial setup

1. Connect email.
2. Connect calendar and contacts.
3. Connect the role's system of record.
4. Optionally connect files/notes and Timeglass.
5. Seer reads the inbox and proposes:
   - category hierarchy
   - important people and relationship types
   - initial matters
   - source mappings
6. The user confirms or edits a short operating-model review.

Seer is useful before every source is connected. Additional sources
increase confidence and forecasting quality rather than blocking setup.

### Continuous personalization

The operating model evolves through:

- explicit edits and corrections
- accepted/rejected relationship suggestions
- individual mail actions
- reply and reading behavior
- matter closure/reopening
- system-of-record changes
- source links the user confirms

The user can inspect, export, and reset learned preferences.

## Trust, privacy, and security

The product reads highly sensitive material. Trust is a functional
requirement:

- least-privilege OAuth scopes per source
- source-level disconnect and deletion
- metadata-first file/note ingestion
- raw Timeglass screenshots excluded by default
- encrypted tokens and stored records
- strict per-account isolation
- provenance visible for important judgments
- append-only action ledger
- reversible actions wherever providers permit
- no model inference silently promoted to fact
- no automatic external writes in the initial release
- configurable retention for source summaries and activity

Prompt context is scoped to the current account and decision. Connected
data is not used to train a shared model.

## End-to-end data flow

```text
Email / Calendar / Contacts / Files / Notes / Timeglass / Salesforce
                              │
                              ▼
                    Source adapters + sync
                              │
                              ▼
                  Normalized signals and graph
                              │
                   Personal operating model
                              │
                              ▼
                     Context compiler
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
        Per-item understanding       Matter updates
                 │                         │
                 └────────────┬────────────┘
                              ▼
                    Portfolio forecast
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
              Atlas                    Triage
       state / forecast / work     sweep / closure / ledger
```

## Data ownership and authority

When evidence conflicts:

1. explicit user correction
2. authoritative system field
3. direct source fact (calendar, file timestamp, sent reply)
4. repeated observed behavior
5. model inference

Recency resolves conflicts only within the same authority class. A new
model guess does not outrank an older user correction.

## Migration from the current application

The existing application already provides:

- full email ingestion and provider totals
- per-message deep understanding records
- conversation collapse
- stable matters and identity merging
- user-created/renamed matters
- category registry
- signature queue
- Salesforce read integration
- background sync
- action APIs and partial behavior learning

Migration proceeds in dependency order:

### Phase 1 — one brain

- add disposition, expiry, matter candidates, and context references to
  `Understanding`
- implement the first context compiler from existing profile, people,
  history, calendar, matters, functions, and Salesforce
- make understanding the only source for matter/file/digest placement
- remove the snippet-grader from the sync decision path
- retire sender-shape `bulk-delete`

### Phase 2 — personal operating model

- unify categories, relationships, protections, exemplars, corrections,
  and autonomy settings behind one account model
- add inferred-category and relationship confirmation
- add provenance and conflict rules

### Phase 3 — external work signals

- introduce the normalized signal contract and graph
- connect file metadata and notes
- connect Timeglass structured activity
- link source artifacts to matters with user-confirmable mappings

### Phase 4 — lifecycle and forecasting

- add matter status, event-driven closure, closure records, and reopening
- add quiet-but-alive and at-risk detection
- add Salesforce/system-of-record handoff
- produce Now/Next/Waiting/At risk forecast

### Phase 5 — Triage autonomy

- replace the standalone Triage tab with sweep proposals, inline closure
  proposals, and the Cleaned ledger
- add undo and reason-level learning
- add per-reason autonomy promotion/demotion
- retire the cards deck and legacy triage sections

### Phase 6 — role portability

- formalize the system-of-record adapter
- add role templates that propose, never impose, initial categories
- add additional providers such as Linear/Jira/ATS/PSA

## Verification

### Understanding and context

- A board member's short post-meeting email receives board and meeting
  context and is never treated as generic FYI.
- A machine sender's approval, regulatory notice, document comment, or
  government deadline survives cleanup.
- Every consequential claim shows its evidence source and authority.
- Not-yet-read mail remains visible and untriaged.

### Matters

- One conversation belongs to exactly one matter.
- A matter carries email, documents, meetings, activity, and CRM records.
- Recent file/Timeglass activity protects a silent matter as alive.
- An open Salesforce opportunity cannot become closed due to silence.
- Closed authoritative status creates a closure proposal, not an
  immediate destructive action.
- New evidence reopens a closed matter explicitly.

### Forecast

- Now/Next ordering explains consequence and dependency.
- Forecast changes when authoritative stage, calendar commitment, or
  observed work changes.
- A stated urgent project with no observed activity can surface as at risk.
- Long-tail work remains quiet but alive when evidence supports it.

### Triage and learning

- Matter + filed + digest + unread coverage reconciles with provider totals.
- Every automatic removal appears in the ledger and can be undone.
- Bulk confirmation does not teach sender-level priors.
- Seer's own auto-actions do not count as user approval.
- Reversals demote autonomy without deployment.

### Personalization and portability

- Categories differ per account and survive rebuilding.
- Explicit category and relationship edits outrank all inference.
- A second user can establish a different operating model without code or
  prompt changes.
- Disconnecting a source removes its future influence and supports
  deletion of its stored context.

## Deliberately out of scope for the first architecture cycle

- Fully autonomous matter closure
- Automatic writes back to Salesforce or other systems of record
- Reading raw Timeglass screenshots by default
- Shared/team-wide operating models and permissions
- Cross-account matter merging
- A universal category taxonomy
