import { hybridClassifyEmailBody } from "@/lib/nlp/hybrid-classify";
import {
  ACTION_META,
  type ClassifyResult,
  type TriageAction,
} from "@/lib/inbox/classify";
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
};

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
  },
  subject: string,
  fromName?: string,
): ActionGuide {
  const meta = ACTION_META[classification.action];
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
      classification.instruction?.trim() ||
      instructionFor(classification.action, subject),
    debug: classification.debug,
    source: classification.source,
    who: story.who,
    harm: story.harm,
  };
}

export async function buildActionGuideDetailed(
  classification: ClassifyResult & {
    source?: "gemini" | "rules" | "override" | "learned";
    instruction?: string;
  },
  subject: string,
  snippet: string,
  bodyForNlp?: string,
  fromName?: string,
): Promise<ActionGuide> {
  const meta = ACTION_META[classification.action];
  let detail: string | undefined;
  const runNlp =
    classification.action === "respond" ||
    classification.action === "act_today" ||
    classification.action === "needs_review";

  if (runNlp) {
    const text = bodyForNlp ?? `${subject}\n\n${snippet}`;
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
      classification.instruction?.trim() ||
      instructionFor(classification.action, subject, detail),
    detail,
    debug: classification.debug,
    source: classification.source,
    who: story.who,
    harm: story.harm,
  };
}
