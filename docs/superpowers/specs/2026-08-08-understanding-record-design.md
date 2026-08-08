# Read every email for meaning; keep rules only for facts

Date: 2026-08-08
Status: approved

## Problem

Atlas misfiles mail because deterministic rules are making judgments they
cannot make:

- Adobe Sign requests land in **Systems (IT)** because a sender-domain rule
  (`DOMAIN_HOME`) decides the org unit before anything reads the document.
- Corporate accounting mail (state dissolution forms, an acquisition
  approval) lands in **Sales — Contracting** because a keyword table fires
  on "SOW"/"signature"/"CDA".
- 256 operations rows collapsed under a branch literally named "Work" — a
  grade label standing in for meaning.

The matters pass only ever saw `subject + snippet + task` for the top ~110
messages. Everything else was filed by keyword. The model was never given
the evidence needed to be right.

## Decision

Every inbox email gets exactly **one deep read** at ingest, producing a
durable **understanding record**. Matters, the signature queue, filing, and
the digest all consume understanding records. Rules keep only the work they
are actually better at.

### Evidence vs judgment

**Deterministic (keep):** study/opportunity codes, dollar amounts, dates,
`List-Unsubscribe`, vendor/biller status from the merchant graph, who spoke
last in a thread, Salesforce values for a code, the user's own overrides.
Exact, cheap, and models paraphrase numbers.

**Model (move):** what the email is, what is being asked and of whom, the
deadline, whether a document awaits the user's signature, which org unit it
belongs to and with what confidence, importance, and the one-line gist.

### Cost

507 messages, bodies trimmed to ~8k chars ≈ 2k tokens each ≈ 1M input
tokens for a full backfill — cents on Flash, once. Steady state is ~50 new
messages/day. Viable only because each email is read once and the result is
cached forever, keyed by message id + `UNDERSTANDING_VERSION`.

### Latency

507 deep reads exceed one cron tick. The backfill runs across ticks,
newest and highest-stakes first. Atlas states the truth while it runs
("N still being read"), reusing the existing coverage line.

## The understanding record

```ts
type Understanding = {
  id: string;
  threadId: string;
  version: number;
  readAt: string;
  kind: string;          // "signature request" | "invoice" | "study update" | …
  oneLine: string;       // what this is, in the user's vocabulary
  ask: string;           // what is wanted, or "nothing — informational"
  owner: "you" | "team" | "them" | "nobody";
  deadline?: string;     // ISO date when one is stated
  amounts?: number[];    // extracted deterministically, not by the model
  entities: string[];    // companies and people named
  signature?: {          // present ⇒ a document awaits the user's signature
    document: string;    // "UC Davis Mutual CDA"
    counterparty?: string;
    platform?: string;   // "Adobe Sign" | "DocuSign" | …
  };
  org: { unit: string; confidence: number };  // validated against the registry
  importance: number;    // 0-3
};
```

Stored per account, pruned to current inbox ids so the key stays bounded.

## Consequences

1. `DOMAIN_HOME`, the keyword table inside `inferredOrgUnit`, and the
   `"Work"` fallback branch are deleted. Filing uses `org.unit` when it
   validates against the user's registry, and the counterparty otherwise.
2. **Signature queue** is synthesized deterministically from records with
   `signature` present: one pinned matter, "Things you need to sign", one
   row per document. No keyword hunt, no model clustering.
3. Matters clustering receives records for the whole corpus instead of
   gists for a slice.
4. Rules survive as extractors, user overrides, and an explicitly labeled
   degraded mode when the model is unavailable — never a silent competing
   opinion.

## Also in scope

- **Archive from Atlas closes the thread**: row actions call the existing
  thread-aware action route with `threadId`, archiving every inbox message
  in the conversation.
- **Rename matters** and **create manual matters**: user-authored matters
  persist across rebuilds and are never overwritten by the model; renames
  apply as ground truth, like the existing org corrections.
- **One row per matter**: a sub-branch heading is not rendered above a
  single row; the code appears inline on the row instead.

## Verification

- A rebuild files Adobe Sign requests under signature, not Systems (IT).
- Corporate accounting mail leaves Sales — Contracting.
- No branch is named "Work".
- Coverage still reconciles: matters + filed + digest = provider total.
