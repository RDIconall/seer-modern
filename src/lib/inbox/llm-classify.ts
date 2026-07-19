import { llmChatJson, llmConfigured } from "@/lib/llm/client";
import type {
  ClassifyInput,
  ClassifyResult,
  Confidence,
  TriageAction,
} from "@/lib/inbox/classify";

const VALID_ACTIONS: TriageAction[] = [
  "respond",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
  "act_today",
  "unsubscribe",
  "review_subscription",
  "glance_promo",
  "needs_review",
];

const VALID_CONFIDENCE: Confidence[] = ["HIGH", "MED", "LOW"];

const SYSTEM_PROMPT = `You triage inbox emails for a busy person. For each email, pick exactly one action:

- respond: a real person is waiting on a reply (questions, requests, personal mail)
- act_today: time-sensitive — codes, boarding passes, deliveries arriving, deadlines today, appointment reminders
- review_subscription: billing anomaly worth a look — failed/declined payment, price change, unexpected charge, renewal the reader may want to cancel
- read_and_archive: worth reading once, then file — receipts, statements, confirmations, useful notifications
- read_and_delete: skim at most, then bin — cold sales outreach, low-value updates
- delete_now: safe to delete unread — pure marketing blasts, spam-adjacent mail
- unsubscribe: recurring list mail the reader clearly never engages with — suggest leaving the list
- glance_promo: promotion possibly worth a glance (a brand the reader shops, a real discount), then archive
- needs_review: genuinely ambiguous — you cannot tell without the reader's judgment

Also return confidence (HIGH when the pattern is unmistakable, MED for a solid guess, LOW when unsure — prefer needs_review over a LOW wild guess) and a short human-readable reason (max 8 words).

Return JSON: {"items":[{"id":string,"action":string,"confidence":"HIGH|MED|LOW","reason":string}]}
Include every id exactly once. Use only the listed action values.`;

export type LlmTriageInput = ClassifyInput & { id: string };

/**
 * Classify a batch of messages with one LLM call. Returns a map of
 * message id -> result. Missing/invalid rows are simply absent so the
 * caller can fall back to rule-based classification per message.
 * Returns an empty map when no LLM is configured or the call fails.
 */
export async function llmClassifyBatch(
  messages: LlmTriageInput[],
): Promise<Map<string, ClassifyResult>> {
  const out = new Map<string, ClassifyResult>();
  if (!llmConfigured() || messages.length === 0) return out;

  const payload = messages.map((m) => ({
    id: m.id,
    from: m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail,
    subject: m.subject.slice(0, 200),
    snippet: m.snippet.slice(0, 300),
  }));

  let raw: string | null;
  try {
    raw = await llmChatJson([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ emails: payload }) },
    ]);
  } catch {
    return out;
  }
  if (!raw) return out;

  let parsed: {
    items?: { id?: string; action?: string; confidence?: string; reason?: string }[];
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }

  const knownIds = new Set(messages.map((m) => m.id));
  for (const row of parsed.items ?? []) {
    if (
      typeof row.id === "string" &&
      knownIds.has(row.id) &&
      VALID_ACTIONS.includes(row.action as TriageAction)
    ) {
      out.set(row.id, {
        action: row.action as TriageAction,
        confidence: VALID_CONFIDENCE.includes(row.confidence as Confidence)
          ? (row.confidence as Confidence)
          : "MED",
        reason:
          typeof row.reason === "string" && row.reason.trim()
            ? `AI: ${row.reason.trim().slice(0, 80)}`
            : "AI triage",
      });
    }
  }
  return out;
}
