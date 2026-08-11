import { generateText, Output } from "ai";
import { z } from "zod";
import type { AccountId } from "../db/types";
import { recordModelUsage } from "./model-usage";
import {
  UNFILED,
  fileMatter,
  listFunctions,
  mattersNeedingFiling,
} from "./functions";

/**
 * Filing matters onto the whiteboard.
 *
 * This is a separate, deliberately cheap pass from the conversation read. It
 * decides only which section of the business a matter belongs to, so it sees
 * titles rather than whole conversations and files a whole batch in one call —
 * a few cents for an entire board instead of a re-read.
 *
 * The model picks from the user's registry and may not extend it. Anything it
 * cannot place honestly goes to "unfiled", which is visible and fixable, rather
 * than being forced into a section where it would quietly mislead.
 */

export type MatterToFile = { id: string; title: string; orgUnit: string | null };

const filingSchema = z.object({
  filings: z.array(
    z.object({
      id: z.string(),
      // Nullable rather than optional: some providers require every key.
      functionName: z.string().nullable(),
    }),
  ),
});

export const FILING_SYSTEM = `You file work onto an executive's whiteboard.

Each item is a MATTER — one unit of work — with the counterparty it involves.
Choose the SECTION of the business it belongs to.

Rules:
- Choose ONLY from the provided sections. Never invent one, never reword one.
- File by the KIND OF WORK, not by who it is with. The same company appears in
  several sections: a software fix for Roche is engineering work, a Roche
  purchase order is sales, a Roche invoice is finance.
- If no section genuinely fits, return null. Do not force a guess.
- Return one entry for every id you were given.`;

/** Batch size: titles are short, and one call per board keeps this near-free. */
const BATCH = 40;

export type FilingResult = { attempted: number; filed: number; unfiled: number };

/**
 * File every matter that has no section yet. Returns counts; a matter the model
 * could not place is recorded as UNFILED so it is not retried forever.
 */
export async function fileMatters(
  accountId: AccountId,
  options: { limit?: number; model?: string } = {},
): Promise<FilingResult> {
  const functions = await listFunctions(accountId);
  if (functions.length === 0) return { attempted: 0, filed: 0, unfiled: 0 };

  const pending = await mattersNeedingFiling(accountId, options.limit ?? 200);
  if (pending.length === 0) return { attempted: 0, filed: 0, unfiled: 0 };

  const model =
    options.model ??
    process.env.SEER_ROUTER_FAST_MODEL ??
    "google/gemini-3.1-flash-lite";

  let filed = 0;
  let unfiled = 0;

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const started = Date.now();
    const result = await generateText({
      model,
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
      output: Output.object({ schema: filingSchema }),
      providerOptions: {
        gateway: { caching: "auto", sort: "cost" },
        google: {
          thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false },
        },
      },
      system: FILING_SYSTEM,
      prompt: JSON.stringify({
        sections: functions,
        matters: batch.map((m) => ({
          id: m.id,
          title: m.title,
          counterparty: m.orgUnit ?? "",
        })),
      }),
    });

    const allowed = new Set(functions);
    const byId = new Map(batch.map((m) => [m.id, m]));
    const decided = new Set<string>();

    for (const filing of result.output.filings) {
      if (!byId.has(filing.id)) continue;
      const name = filing.functionName?.trim() ?? "";
      // A section outside the registry is not a filing — the whiteboard's
      // shelves belong to the user.
      const target = name && allowed.has(name) ? name : UNFILED;
      await fileMatter(filing.id, target, "inferred");
      decided.add(filing.id);
      if (target === UNFILED) unfiled++;
      else filed++;
    }

    // Anything the model skipped still needs a resting place, or it would be
    // re-sent on every run forever.
    for (const matter of batch) {
      if (decided.has(matter.id)) continue;
      await fileMatter(matter.id, UNFILED, "inferred");
      unfiled++;
    }

    await recordModelUsage({
      accountId,
      tier: "fast",
      model,
      escalationReasons: ["matter_filing"],
      latencyMs: Date.now() - started,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    }).catch(() => {});
  }

  return { attempted: pending.length, filed, unfiled };
}
