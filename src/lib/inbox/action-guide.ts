import { hybridClassifyEmailBody } from "@/lib/nlp/hybrid-classify";
import {
  ACTION_META,
  type ClassifyResult,
  type TriageAction,
} from "@/lib/inbox/classify";
import { extractAsk } from "@/lib/inbox/extract-ask";
import { senderStory } from "@/lib/inbox/sender-story";

export type ActionGuide = {
  action: TriageAction;
  label: string;
  color: string;
  confidence: ClassifyResult["confidence"];
  reason: string;
  /** Plain-language instruction — the key UX line */
  instruction: string;
  /** Seer NLP detail when available */
  detail?: string;
  debug?: ClassifyResult["debug"];
  source?: "gemini" | "rules" | "override" | "learned";
  /** Who is this sender to you? */
  who?: string;
  /** Harm in deleting / when you actually need it */
  harm?: string;
  /** The actionable sentence pulled from the email — old Seer style */
  ask?: string;
  /** The implied action — imperative ("Fix the autopay payment") or "Be aware: …" */
  task?: string;
  /** Life bucket ("Old trip", "Groceries — delivered", "Money & bills") */
  category?: string;
};

/** Rules-decided mail gets a coarse but honest life bucket. */
function categoryFor(ruleId: string | undefined, action: TriageAction): string {
  const r = ruleId ?? "";
  if (/invite|rsvp|meeting/.test(r)) return "Calendar";
  if (/shipper|delivery/.test(r)) return "Deliveries";
  if (/finance|money|autopay|subscription/.test(r)) return "Money & bills";
  if (/already-replied/.test(r)) return "Handled";
  if (/urgency-expired/.test(r)) return "Expired";
  if (/shopping|promo|marketing|urgency-bait/.test(r)) return "Shopping & promos";
  if (/product/.test(r)) return "Product updates";
  if (/edu-gov/.test(r)) return "School & gov";
  if (/contact|engaged|personal/.test(r)) return "People";
  switch (action) {
    case "respond":
      return "People";
    case "review_subscription":
      return "Money & bills";
    case "unsubscribe":
      return "Mailing lists";
    case "glance_promo":
      return "Shopping & promos";
    case "read_and_archive":
      return "Records";
    default:
      return "Everything else";
  }
}

/**
 * Every email carries an implied action — a concrete verb, or an
 * explicit "Be aware". Rules-decided mail synthesizes one here; Gemini
 * supplies its own (and the discipline of naming it keeps it honest).
 */
function impliedTask(
  action: TriageAction,
  subject: string,
  ask?: string,
): string {
  // Only echo the ask when it's short enough to BE an action phrase —
  // a truncated sentence is not a task. Long asks display separately.
  if (
    ask &&
    ask.length <= 48 &&
    (action === "respond" || action === "act_today" || action === "needs_review")
  ) {
    return `Do it: ${ask.replace(/[?.!]\s*$/, "")}`;
  }
  const gist = subject.slice(0, 40) + (subject.length > 40 ? "…" : "");
  switch (action) {
    case "respond":
      return "Reply — they're waiting";
    case "act_today":
      return "Handle it today";
    case "review_subscription":
      return "Check the charge";
    case "needs_review":
      return "Your call — decide";
    case "read_and_archive":
      return `Be aware: ${gist}`;
    case "read_and_delete":
      return `Be aware: ${gist}`;
    case "delete_now":
      return "Nothing — delete it";
    case "unsubscribe":
      return "Unsubscribe — dead list";
    case "glance_promo":
      return "Glance: worth buying?";
  }
}

const WANTS_ASK = new Set<TriageAction>([
  "respond",
  "act_today",
  "needs_review",
]);

/** html-to-text residue that poisons NLP: image alts, bare <url> refs */
function cleanForNlp(text: string): string {
  return text
    .replace(/\[image:[^\]]*\]/gi, " ")
    .replace(/<https?:\/\/[^>\s]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function instructionFor(
  action: TriageAction,
  subject: string,
  nlpDetail?: string,
): string {
  const sub = subject.length > 60 ? `${subject.slice(0, 57)}…` : subject;
  switch (action) {
    case "respond":
      return nlpDetail
        ? `Reply when you can — ${nlpDetail}`
        : `Respond to this — they may be waiting on you.`;
    case "read_and_archive":
      return `Read "${sub}" if you need it, then archive.`;
    case "read_and_delete":
      return `Skim if curious, then delete.`;
    case "delete_now":
      return `Safe to delete without opening.`;
    case "act_today":
      return nlpDetail
        ? `Do today: ${nlpDetail}`
        : `Time-sensitive — handle today.`;
    case "unsubscribe":
      return `Unsubscribe, then trash future mail.`;
    case "review_subscription":
      return `Check amount and billing — something may be off.`;
    case "glance_promo":
      return `Glance the subject; archive if you're not buying now.`;
    case "needs_review":
      return `You decide — tap a chip to teach the app.`;
  }
}

export function buildActionGuideQuick(
  classification: ClassifyResult & {
    source?: "gemini" | "rules" | "override" | "learned";
    instruction?: string;
    task?: string;
    category?: string;
  },
  subject: string,
  fromName?: string,
  snippet?: string,
): ActionGuide {
  const meta = ACTION_META[classification.action];
  const story = senderStory(
    classification.action,
    classification.debug,
    fromName,
  );
  // The sender's own words beat any generated instruction
  const ask =
    snippet && WANTS_ASK.has(classification.action)
      ? (extractAsk(cleanForNlp(snippet)) ?? undefined)
      : undefined;
  return {
    action: classification.action,
    label: meta.label,
    color: meta.color,
    confidence: classification.confidence,
    reason: classification.reason,
    instruction:
      (ask ? `They ask: "${ask}"` : undefined) ??
      classification.instruction?.trim() ??
      instructionFor(classification.action, subject),
    debug: classification.debug,
    source: classification.source,
    who: story.who,
    harm: story.harm,
    ask,
    task:
      classification.task?.trim() ||
      impliedTask(classification.action, subject, ask),
    category:
      classification.category?.trim() ||
      categoryFor(classification.debug?.ruleId, classification.action),
  };
}

export async function buildActionGuideDetailed(
  classification: ClassifyResult & {
    source?: "gemini" | "rules" | "override" | "learned";
    instruction?: string;
    task?: string;
    category?: string;
  },
  subject: string,
  snippet: string,
  bodyForNlp?: string,
  fromName?: string,
): Promise<ActionGuide> {
  const meta = ACTION_META[classification.action];
  let detail: string | undefined;
  let ask: string | undefined;
  const runNlp = WANTS_ASK.has(classification.action);

  if (runNlp) {
    const text = cleanForNlp(bodyForNlp ?? `${subject}\n\n${snippet}`);
    // The literal ask, old-Seer style ("can you complete this form?")
    ask = extractAsk(text) ?? undefined;
    try {
      const nlp = await hybridClassifyEmailBody(text);
      const top = nlp.sentences
        .filter((s) => s.label === "action" || s.label === "meeting")
        .sort((a, b) => b.score - a.score)[0];
      if (top) {
        detail =
          top.label === "meeting"
            ? `Meeting: "${top.text.slice(0, 80)}"`
            : `"${top.text.slice(0, 100)}"`;
      }
    } catch {
      /* rules-only guide */
    }
  }

  const story = senderStory(
    classification.action,
    classification.debug,
    fromName,
  );
  return {
    action: classification.action,
    label: meta.label,
    color: meta.color,
    confidence: classification.confidence,
    reason: classification.reason,
    instruction:
      (ask ? `They ask: "${ask}"` : undefined) ??
      classification.instruction?.trim() ??
      instructionFor(classification.action, subject, detail),
    detail,
    debug: classification.debug,
    source: classification.source,
    who: story.who,
    harm: story.harm,
    ask,
    task:
      classification.task?.trim() ||
      impliedTask(classification.action, subject, ask),
    category:
      classification.category?.trim() ||
      categoryFor(classification.debug?.ruleId, classification.action),
  };
}
