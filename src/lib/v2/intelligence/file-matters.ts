import { generateText, Output } from "ai";
import { z } from "zod";
import type { AccountId } from "../db/types";
import { recordModelUsage } from "./model-usage";
import {
  UNFILED,
  conversationsNeedingFiling,
  fileConversation,
  fileMatter,
  listRegistry,
  mattersNeedingFiling,
} from "./functions";

/**
 * Filing work onto the whiteboard.
 *
 * Everything the user has — matters on the board, loose mail in triage — is
 * filed under one of THEIR functions: "sales — new requests", "hr",
 * "recruiting". That is the axis their whiteboard uses, and it is the one that
 * makes a list scannable. Filing by the sender's company instead would scatter
 * one function's work across a dozen headings and put unrelated work together
 * just because it shares a counterparty.
 *
 * This is a separate, deliberately cheap pass from the conversation read: it
 * decides only which shelf something belongs on, so it sees titles rather than
 * whole conversations and files a whole batch in one call.
 *
 * The model picks from the user's registry and may not extend it. Anything it
 * cannot place goes to "unfiled", which is visible and fixable, rather than
 * being forced somewhere it would quietly mislead.
 */

const filingSchema = z.object({
  filings: z.array(
    z.object({
      id: z.string(),
      // Nullable rather than optional: some providers require every key.
      functionName: z.string().nullable(),
    }),
  ),
});

export const FILING_SYSTEM = `You file an executive's mail onto their board.

Each item is one piece of work or one piece of mail. Choose the SECTION it
belongs under.

Sections come in two kinds:
- FUNCTIONS are parts of the business, where real work belongs
  ("sales — contracting", "recruiting", "operations — studies").
- TOPICS describe what a piece of mail IS, for things that are nobody's work:
  notifications, newsletters, bulletins, digests.

Rules:
- Choose ONLY from the provided sections. Never invent one, never reword one.
- If the item is real work someone must carry, use a FUNCTION.
- If it is a notification, newsletter or bulletin that no one is working on,
  use a TOPIC. A vendor newsletter is not engineering work; an invoice you must
  pay is finance work, but a receipt filed for the record is a notice.
- File by the KIND OF WORK, not by who it is with. The same company appears in
  several sections: a software fix for Acme is systems work, an Acme purchase
  order is sales, an Acme invoice is finance, an Acme candidate is recruiting.
- If nothing genuinely fits, return null. Do not force a guess.
- Return one entry for every id you were given.`;

/** Batch size: items are short, so one call files a large part of a board. */
const BATCH = 40;

export type FilingResult = {
  matters: { attempted: number; filed: number; unfiled: number };
  conversations: { attempted: number; filed: number; unfiled: number };
};

type Item = { id: string; [key: string]: unknown };

/**
 * Ask the model to file one batch, then apply the answers. Returns how many
 * landed on a real shelf and how many ended up unfiled.
 */
async function fileBatch(
  accountId: AccountId,
  sections: { functions: string[]; topics: string[] },
  items: Item[],
  model: string,
  apply: (id: string, section: string) => Promise<unknown>,
): Promise<{ filed: number; unfiled: number }> {
  const functions = [...sections.functions, ...sections.topics];
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
      functions: sections.functions,
      topics: sections.topics,
      items,
    }),
  });

  const allowed = new Set(functions);
  const known = new Set(items.map((i) => i.id));
  const decided = new Set<string>();
  let filed = 0;
  let unfiled = 0;

  for (const filing of result.output.filings) {
    if (!known.has(filing.id) || decided.has(filing.id)) continue;
    const name = filing.functionName?.trim() ?? "";
    // A section outside the registry is not a filing — the shelves are the
    // user's, and inventing one would quietly grow a taxonomy they never chose.
    const target = name && allowed.has(name) ? name : UNFILED;
    await apply(filing.id, target);
    decided.add(filing.id);
    if (target === UNFILED) unfiled++;
    else filed++;
  }

  // Anything the model skipped still needs a resting place, or it would be
  // re-sent on every run forever.
  for (const item of items) {
    if (decided.has(item.id)) continue;
    await apply(item.id, UNFILED);
    unfiled++;
  }

  await recordModelUsage({
    accountId,
    tier: "fast",
    model,
    escalationReasons: ["filing"],
    latencyMs: Date.now() - started,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    totalTokens: result.usage.totalTokens,
  }).catch(() => {});

  return { filed, unfiled };
}

/**
 * File everything that has no section yet — matters first, then the triage
 * mail that never became one.
 */
export async function fileMatters(
  accountId: AccountId,
  options: { limit?: number; model?: string } = {},
): Promise<FilingResult> {
  const empty = { attempted: 0, filed: 0, unfiled: 0 };
  const functions = await listRegistry(accountId, "function");
  const topics = await listRegistry(accountId, "topic");
  if (functions.length === 0) return { matters: empty, conversations: empty };

  const limit = options.limit ?? 200;
  const model =
    options.model ??
    process.env.SEER_ROUTER_FAST_MODEL ??
    "google/gemini-3.1-flash-lite";

  const matters = { ...empty };
  const pendingMatters = await mattersNeedingFiling(accountId, limit);
  matters.attempted = pendingMatters.length;
  for (let i = 0; i < pendingMatters.length; i += BATCH) {
    const batch = pendingMatters.slice(i, i + BATCH).map((m) => ({
      id: m.id,
      title: m.title,
      counterparty: m.orgUnit ?? "",
    }));
    // A matter is work by definition, so it may only take a function. Offering
    // topics here would let real work be filed as "Newsletters".
    const outcome = await fileBatch(
      accountId,
      { functions, topics: [] },
      batch,
      model,
      (id, s) => fileMatter(id, s, "inferred"),
    );
    matters.filed += outcome.filed;
    matters.unfiled += outcome.unfiled;
  }

  const conversations = { ...empty };
  const pendingConversations = await conversationsNeedingFiling(accountId, limit);
  conversations.attempted = pendingConversations.length;
  for (let i = 0; i < pendingConversations.length; i += BATCH) {
    const batch = pendingConversations.slice(i, i + BATCH).map((c) => ({
      id: c.id,
      subject: c.subject,
      from: c.from,
      // The read's own summary is the best short description of the work.
      about: c.summary.slice(0, 160),
    }));
    // Loose mail may be work or may be noise, so it sees both axes.
    const outcome = await fileBatch(
      accountId,
      { functions, topics },
      batch,
      model,
      (id, s) => fileConversation(id, s, "inferred"),
    );
    conversations.filed += outcome.filed;
    conversations.unfiled += outcome.unfiled;
  }

  return { matters, conversations };
}
