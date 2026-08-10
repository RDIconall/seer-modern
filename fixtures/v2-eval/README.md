# Seer v2 evaluation fixtures

Each `*.json` file is one `EvalCase`: a redacted full conversation, the business
context Seer is allowed to use, and the correct outcome. The benchmark runs each
case two ways — a context-free baseline read and the full Seer read — and fails
the release when Seer is worse (see `src/lib/v2/eval/compare.ts`).

## Cardinal rules the benchmark enforces

1. **No false "safe to delete".** If `expectedHome` is not `delete`, Seer must
   not delete it. This is the highest-cost failure.
2. **Never worse than the baseline.** If a naive full-email read would keep the
   message, Seer must not delete it.
3. **No fabricated connections.** A `matter_connection` yield must reference a
   matter in `allowedMatterRefs`.
4. **Required meaning is surfaced.** `requiredYieldKinds` must all appear.

## Case shape

```json
{
  "id": "roche-newsletter",
  "conversation": {
    "providerConversationId": "…",
    "subject": "Daily News: FDA clears Roche tests",
    "messages": [
      {
        "providerMessageId": "…",
        "from": { "email": "newsletters@360dx.com" },
        "to": [{ "email": "you@company.com" }],
        "cc": [],
        "sentAt": "2026-08-08T10:00:00Z",
        "snippet": "…",
        "bodyHtml": null,
        "bodyText": "Full redacted body …",
        "isUnread": true,
        "isOutgoing": false,
        "attachments": []
      }
    ],
    "lastMessageAt": "2026-08-08T10:00:00Z"
  },
  "context": {
    "ownDomain": "company.com",
    "people": [],
    "matters": [{ "id": "roche", "title": "Roche anti-TPO study" }],
    "interests": []
  },
  "expectedHome": "undecided",
  "allowedMatterRefs": ["roche", "Roche anti-TPO study"],
  "requiredYieldKinds": ["matter_connection"]
}
```

## Privacy

Fixtures are committed, so redact real names, addresses, amounts, and any
sensitive content. Keep only what the decision turns on. Do not commit real
customer PII.

## Running

```bash
tsx scripts/run-v2-eval.mts --fixtures fixtures/v2-eval
```

Without a model API key the runner validates fixture shape only. With
`GEMINI_API_KEY` (or the AI Gateway) it performs live baseline-vs-Seer scoring
and exits nonzero on any release failure.
