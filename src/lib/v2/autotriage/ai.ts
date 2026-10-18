import { generateText, Output } from "ai";
import { z } from "zod";
import { withinDailyBudget } from "../intelligence/model-usage";
import type { AccountId } from "../db/types";
import type { AiCategory, AiTriageResult, AutoTriageAiCaller } from "./types";

const CATEGORIES = [
  "newsletter",
  "marketing",
  "cold_sales",
  "webinar",
  "app_notification",
  "verification_code",
  "receipt",
  "calendar",
  "human",
  "actionable",
  "other",
] as const;

const schema = z.object({
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const AI_DELETE = new Set<AiCategory>([
  "newsletter",
  "marketing",
  "cold_sales",
  "webinar",
  "app_notification",
  "verification_code",
]);
const AI_ARCHIVE = new Set<AiCategory>(["receipt", "calendar"]);

export function aiAutoAction(
  result: AiTriageResult,
  threshold: number,
): "delete" | "archive" | null {
  if (result.confidence < threshold) return null;
  if (AI_DELETE.has(result.category)) return "delete";
  if (AI_ARCHIVE.has(result.category)) return "archive";
  return null;
}

export const defaultAutoTriageAiCaller: AutoTriageAiCaller = async (input) => {
  const model =
    process.env.SEER_ROUTER_FAST_MODEL?.trim() || "google/gemini-3.1-flash-lite";
  const result = await generateText({
    model,
    temperature: 0,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(30_000),
    output: Output.object({ schema }),
    system:
      "Classify one unknown-sender email for inbox triage. Obvious junk is newsletter, marketing, cold_sales, webinar, app_notification, or verification_code. Receipts and calendar notices are records. Human or actionable mail must not be treated as junk. Be conservative: if unsure, use other or human at low confidence.",
    prompt: JSON.stringify({
      sender: input.sender,
      subject: input.subject,
      snippet: input.snippet ?? "",
    }),
  });
  return result.output;
};

export async function classifyUnknownSender(input: {
  accountId: AccountId;
  sender: string;
  subject: string;
  snippet?: string | null;
  caller?: AutoTriageAiCaller;
}): Promise<AiTriageResult | null> {
  if (!(await withinDailyBudget(input.accountId, "fast"))) return null;
  const caller = input.caller ?? defaultAutoTriageAiCaller;
  try {
    return await caller({
      sender: input.sender,
      subject: input.subject,
      snippet: input.snippet,
    });
  } catch (cause) {
    console.error(
      "[seer:autotriage] AI classify failed",
      cause instanceof Error ? cause.message : cause,
    );
    return null;
  }
}
