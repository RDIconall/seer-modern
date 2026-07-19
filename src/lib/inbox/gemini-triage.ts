import {
  ACTION_META,
  type ClassifyDebug,
  type ClassifyResult,
  type Confidence,
  type TriageAction,
} from "@/lib/inbox/classify";
import { historySignals, type MailHistory } from "@/lib/inbox/mail-history";
import { intelBreakdown, intelContainsAny } from "@/lib/nlp/intel";
import { google } from "@ai-sdk/google";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

const ACTIONS = [
  "respond",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
  "act_today",
  "unsubscribe",
  "review_subscription",
  "glance_promo",
  "needs_review",
] as const;

const batchSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      action: z.enum(ACTIONS),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
      instruction: z.string(),
    }),
  ),
});

export type GeminiTriageItem = {
  id: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
};

export type AssistantClassifyResult = ClassifyResult & {
  source: "gemini" | "rules" | "override";
  instruction?: string;
};

const BATCH = Math.max(
  5,
  Math.min(25, Number(process.env.SEER_GEMINI_BATCH_SIZE ?? "18") || 18),
);

function resolveModel(): { model: LanguageModel | string; label: string } {
  const googleKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;

  // Direct Google Generative AI key (already on this Vercel project)
  if (googleKey) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = googleKey;
    }
    const id = (
      process.env.SEER_GEMINI_MODEL?.trim() || "gemini-2.5-flash"
    ).replace(/^google\//, "");
    return { model: google(id), label: `google:${id}` };
  }

  // Vercel AI Gateway (OIDC or AI_GATEWAY_API_KEY)
  const gatewayModel =
    process.env.SEER_GEMINI_MODEL?.trim() || "google/gemini-3-flash";
  return { model: gatewayModel, label: gatewayModel };
}

/** True when Gemini can be attempted (Google key, Gateway key, or Vercel OIDC). */
export function isGeminiConfigured(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN ||
      process.env.VERCEL,
  );
}

function toConfidence(n: number): Confidence {
  if (n >= 0.75) return "HIGH";
  if (n >= 0.45) return "MED";
  return "LOW";
}

function debugFor(
  input: GeminiTriageItem,
  history: MailHistory | null | undefined,
  ruleId: string,
): ClassifyDebug {
  const signals = historySignals(history, input.fromEmail);
  const text = `${input.subject}\n${input.snippet}`;
  const intel = intelBreakdown(text);
  return {
    ruleId,
    relationship: signals.relationship,
    sentTo: signals.sentTo,
    receivedFrom: signals.receivedFrom,
    daysSinceLastSent: signals.daysSinceLastSent,
    staleEngagement: signals.staleEngagement,
    actionable: intelContainsAny(text) || intel.request > 0 || intel.schedule > 0,
    intel,
  };
}

function systemPrompt(): string {
  return `You are Seer, an elite email copilot. The user's TIME is more valuable than tokens.

Decide an ACTION for every email. Make the call yourself. Do NOT defer to the user unless something is truly ambiguous AND high-stakes.

Actions:
- respond: a real person is waiting on an answer / decision
- act_today: deadline, security, travel, appointment, money risk today
- read_and_archive: useful notification/receipt/FYI — skim then archive
- read_and_delete: low-value human or semi-personal noise — skim once then delete
- delete_now: safe to trash without opening (cold promo, bulk noreply junk)
- unsubscribe: mailing list they clearly don't engage with
- review_subscription: billing anomaly / price change / failed charge
- glance_promo: shopping/deals they might want — glance subject only
- needs_review: LAST RESORT (<5% of mail). Only if a wrong auto-action could hurt a real relationship or money and you truly cannot tell.

Use relationship signals: engaged (they email this person) → prefer respond/act_today/archive over delete.
Cold noreply marketing → delete_now or unsubscribe.
Product/CI (GitHub, Vercel, Figma, etc.) → usually read_and_archive unless promo.
Be decisive. Prefer a confident archive/delete over needs_review.

Return one item per input id. reason = short why. instruction = what the user should do in one sentence.`;
}

async function geminiBatch(
  batch: GeminiTriageItem[],
  history: MailHistory | null | undefined,
): Promise<Map<string, AssistantClassifyResult>> {
  const out = new Map<string, AssistantClassifyResult>();
  if (batch.length === 0) return out;

  const payload = batch.map((m) => {
    const sig = historySignals(history, m.fromEmail);
    return {
      id: m.id,
      from: m.fromName || m.fromEmail,
      email: m.fromEmail,
      subject: m.subject,
      snippet: m.snippet.slice(0, 400),
      relationship: sig.relationship,
      sentTo: sig.sentTo,
      receivedFrom: sig.receivedFrom,
      staleEngagement: sig.staleEngagement,
    };
  });

  const { model, label } = resolveModel();
  const { output } = await generateText({
    model,
    temperature: 0.2,
    output: Output.object({ schema: batchSchema }),
    system: systemPrompt(),
    prompt: `Classify these ${payload.length} inbox emails. Decide for each — user is last resort.\n\n${JSON.stringify(payload)}`,
  });

  if (!output?.items?.length) return out;

  for (const row of output.items) {
    const src = batch.find((b) => b.id === row.id);
    if (!src) continue;
    let action = row.action as TriageAction;
    // Soften: if model picks needs_review with medium+ confidence, force a decisive default
    if (action === "needs_review" && row.confidence >= 0.55) {
      const sig = historySignals(history, src.fromEmail);
      action =
        sig.relationship === "engaged" ? "respond" : "read_and_delete";
    }
    out.set(row.id, {
      action,
      confidence: toConfidence(row.confidence),
      reason: row.reason.slice(0, 200),
      debug: debugFor(src, history, `gemini:${label}`),
      source: "gemini",
      instruction: row.instruction.slice(0, 200),
    });
  }
  return out;
}

/**
 * Gemini-first triage for an inbox list. Taught overrides win.
 * Falls back to rules if Gemini is unavailable or misses an id.
 */
export async function classifyInboxWithAssistant(
  items: GeminiTriageItem[],
  history: MailHistory | null | undefined,
  getOverride: (email: string) => Promise<TriageAction | null> | TriageAction | null,
  rulesFallback: (
    input: {
      fromEmail: string;
      fromName?: string;
      subject: string;
      snippet: string;
    },
    override: TriageAction | null,
    history: MailHistory | null | undefined,
  ) => ClassifyResult,
): Promise<Map<string, AssistantClassifyResult>> {
  const results = new Map<string, AssistantClassifyResult>();
  const forGemini: GeminiTriageItem[] = [];

  for (const item of items) {
    const override = await getOverride(item.fromEmail);
    if (override) {
      results.set(item.id, {
        action: override,
        confidence: "HIGH",
        reason: "You taught this sender",
        debug: debugFor(item, history, "override-taught-sender"),
        source: "override",
        instruction: ACTION_META[override].label,
      });
      continue;
    }
    forGemini.push(item);
  }

  if (forGemini.length > 0 && isGeminiConfigured()) {
    try {
      for (let i = 0; i < forGemini.length; i += BATCH) {
        const chunk = forGemini.slice(i, i + BATCH);
        const mapped = await geminiBatch(chunk, history);
        for (const [id, r] of mapped) results.set(id, r);
      }
    } catch (e) {
      console.error(
        "[seer] Gemini triage failed, falling back to rules:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  for (const item of forGemini) {
    if (results.has(item.id)) continue;
    const r = rulesFallback(
      {
        fromEmail: item.fromEmail,
        fromName: item.fromName,
        subject: item.subject,
        snippet: item.snippet,
      },
      null,
      history,
    );
    results.set(item.id, {
      ...r,
      source: "rules",
      debug: { ...r.debug, ruleId: `rules:${r.debug.ruleId}` },
    });
  }

  return results;
}
