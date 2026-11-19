import { kvGet, kvSet } from "@/lib/store/kv";
import type { IntelBreakdown } from "./intel";
import { intelBreakdown, intelContainsAny } from "./intel";
import { splitSentences } from "./sentences";

/**
 * Every caller (public route, message open) reaches OpenAI through
 * hybridClassifyEmailBody, so these bounds are what keep a sender-chosen
 * body from turning into an unbounded, slow, billed request.
 */
export const NLP_CHAR_CAP = 120_000;
export const MAX_GRAY_SENTENCES = 32;
const MAX_LLM_SENTENCE_CHARS = 400;
const OPENAI_TIMEOUT_MS = 4_000;
const DEFAULT_DAILY_LLM_CALLS = 1000;

export type NlpLabel =
  | "action"
  | "meeting"
  | "pleasantry"
  | "non_actionable";

export type SentenceVerdict = {
  text: string;
  score: number;
  label: NlpLabel;
  source: "rules" | "llm" | "rules+llm";
  intel: IntelBreakdown;
};

const GRAY_LOW = 0.32;
const GRAY_HIGH = 0.68;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function emailHeuristicScore(fullText: string): number {
  const b = intelBreakdown(fullText);
  const hits = b.notices + b.schedule + b.request + b.followUp;
  const len = Math.max(1, fullText.length / 800);
  const density = clamp01(hits / (2 + len));
  if (fullText.includes("?")) return clamp01(density + 0.08);
  return density;
}

function sentenceRulesScore(
  sentence: string,
  emailHint: number,
): { score: number; label: NlpLabel } {
  const b = intelBreakdown(sentence);
  const any = intelContainsAny(sentence);
  const q = sentence.includes("?");
  let score = emailHint * 0.35;
  if (any) score += 0.28 + Math.min(0.22, (b.request + b.followUp) * 0.07);
  if (b.schedule > 0) score += 0.18;
  if (b.notices > 0) score += 0.06;
  if (q && /^(can|could|would|will|did|do|are|is)\b/i.test(sentence))
    score += 0.12;
  score = clamp01(score);

  let label: NlpLabel = "non_actionable";
  if (b.schedule > 0 && score >= 0.42) label = "meeting";
  else if (
    /please (call|let me know)|if you have questions|thanks in advance/i.test(
      sentence,
    ) &&
    score < 0.55
  )
    label = "pleasantry";
  else if (score >= 0.52) label = "action";
  else if (score >= 0.4 && (b.request > 0 || b.followUp > 0)) label = "action";

  return { score, label };
}

type LlmRow = { index: number; label: NlpLabel; confidence: number };

/**
 * Deployment-wide daily ceiling on chat-completions calls, shared across
 * instances via KV. Reserves a slot before the call; any failure to read
 * or write the counter means no call (rules-only is always a safe answer).
 */
async function reserveDailyLlmCall(): Promise<boolean> {
  const limit = Number(
    process.env.SEER_OPENAI_DAILY_CALL_LIMIT ?? DEFAULT_DAILY_LLM_CALLS,
  );
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const key = `openai-nlp-calls:${new Date().toISOString().slice(0, 10)}`;
  try {
    const used = (await kvGet<number>(key)) ?? 0;
    if (used >= limit) return false;
    await kvSet(key, used + 1, { ttlSeconds: 2 * 86_400 });
    return true;
  } catch {
    return false;
  }
}

async function refineWithLlm(
  sentences: { index: number; text: string }[],
): Promise<Map<number, { label: NlpLabel; confidence: number }>> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const out = new Map<number, { label: NlpLabel; confidence: number }>();
  if (!apiKey || sentences.length === 0) return out;
  const batch = sentences.slice(0, MAX_GRAY_SENTENCES).map((s) => ({
    index: s.index,
    text: s.text.slice(0, MAX_LLM_SENTENCE_CHARS),
  }));
  if (!(await reserveDailyLlmCall())) return out;
  const allowed = new Set(batch.map((s) => s.index));

  const payload = {
    model,
    temperature: 0,
    response_format: { type: "json_object" as const },
    messages: [
      {
        role: "system" as const,
        content: `You label email sentences for a productivity assistant (Seer revival).
Categories: action (asks reader to do something substantive), meeting (scheduling / time / meet), pleasantry (formulaic politeness, low obligation), non_actionable.
Return JSON: {"items":[{"index":number,"label":"action|meeting|pleasantry|non_actionable","confidence":0-1}]}
Only include the listed indices.`,
      },
      {
        role: "user" as const,
        content: JSON.stringify(batch),
      },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${err.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) return out;
  const parsed = JSON.parse(raw) as { items?: LlmRow[] };
  const labels: NlpLabel[] = [
    "action",
    "meeting",
    "pleasantry",
    "non_actionable",
  ];
  for (const row of parsed.items ?? []) {
    if (
      typeof row.index === "number" &&
      allowed.has(row.index) &&
      typeof row.confidence === "number" &&
      labels.includes(row.label)
    ) {
      out.set(row.index, { label: row.label, confidence: row.confidence });
    }
  }
  return out;
}

export async function hybridClassifyEmailBody(body: string): Promise<{
  emailHint: number;
  sentences: SentenceVerdict[];
}> {
  // Over-cap bodies are graded by rules alone, on their leading slice.
  const llmAllowed = body.length <= NLP_CHAR_CAP;
  const text = llmAllowed ? body : body.slice(0, NLP_CHAR_CAP);
  const emailHint = emailHeuristicScore(text);
  const parts = splitSentences(text);
  if (parts.length === 0) {
    return { emailHint, sentences: [] };
  }

  const preliminary = parts.map((text, index) => {
    const { score, label } = sentenceRulesScore(text, emailHint);
    return { index, text, score, label, intel: intelBreakdown(text) };
  });

  const gray = preliminary.filter(
    (p) => p.score >= GRAY_LOW && p.score <= GRAY_HIGH,
  );
  let llmMap = new Map<number, { label: NlpLabel; confidence: number }>();
  if (llmAllowed) {
    try {
      llmMap = await refineWithLlm(
        gray.map((g) => ({ index: g.index, text: g.text })),
      );
    } catch {
      /* rules-only if LLM fails */
    }
  }

  const sentences: SentenceVerdict[] = preliminary.map((p) => {
    const llm = llmMap.get(p.index);
    const inGray = p.score >= GRAY_LOW && p.score <= GRAY_HIGH;
    if (llm && inGray && llm.confidence >= 0.55) {
      return {
        text: p.text,
        score: Math.max(p.score, llm.confidence * 0.95),
        label: llm.label,
        source: "rules+llm",
        intel: p.intel,
      };
    }
    if (inGray && llm && llm.confidence >= 0.45) {
      return {
        text: p.text,
        score: (p.score + llm.confidence) / 2,
        label: llm.label,
        source: "rules+llm",
        intel: p.intel,
      };
    }
    return {
      text: p.text,
      score: p.score,
      label: p.label,
      source: "rules",
      intel: p.intel,
    };
  });

  return { emailHint, sentences };
}
