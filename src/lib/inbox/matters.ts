import { getTriageModel } from "@/lib/inbox/gemini-triage";
import { stripEmoji, type EmailItem } from "@/lib/inbox/types";
import { loadExemplars, retrieveExemplars } from "@/lib/store/exemplars";
import { loadFunctions } from "@/lib/store/functions";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";
import { loadMerchants } from "@/lib/store/merchants";

/**
 * Deterministic evidence, gathered BEFORE the model reasons — study
 * codes are highly structured and a resolved code is a strong
 * "work is awarded and running" (operations) signal.
 */
const STUDY_CODE =
  /\b(RCD[_-]?\d{3,5}|LMD[_-]?\d{3,5}|RD\d{6,7}|TGRP\d{1,3}|RFQ[ #-]?\d{4,6})\b/i;
import { profilePromptBlock, type UserProfile } from "@/lib/store/user-profile";
import { generateText, Output } from "ai";
import { z } from "zod";

/**
 * MATTERS — the inbox as a unit, not a pile of emails. What stays in
 * the inbox stays for a reason; matters are those reasons, tracked:
 * "RD006873 budget dispute", "CAP inspection follow-ups", "Fluxergy
 * NDA". The brief narrates the state of your work life from them, and
 * it REMEMBERS: yesterday's matters are today's starting point.
 */

export type MatterPerson = {
  name: string;
  email?: string;
  /**
   * Relationship typing, compact: role — lifecycle/closeness.
   * "client — new" · "client — senior, close" · "team" · "vendor" ·
   * "board" · "regulator" · "family" · "prospect"
   */
  relationship: string;
};

export type Matter = {
  id: string;
  title: string;
  /** "money" | "people" | "compliance" | "new-business" | "ops" | "personal" */
  category: string;
  /** Resolved against the user's function registry, verbatim */
  orgUnit: string;
  /** Below ~0.85 the org call is a SUGGESTION awaiting confirmation */
  orgConfidence?: number;
  /** The humans in this matter, with relationship typing */
  people: MatterPerson[];
  /** One-sentence state of play, present tense */
  narrative: string;
  /** The one next move, imperative, or "none — team handling" */
  nextAction: string;
  /** "you" | "team" | "them" — whose court */
  owner: string;
  /** 0-3, how loudly this should lead the brief */
  urgency: number;
  emailIds: string[];
  threadIds: string[];
  updatedAt: string;
};

export type Headline = {
  id: string;
  threadId: string;
  line: string;
};

export type Brief = {
  builtAt: string;
  summary: string;
  matters: Matter[];
  /** The read-then-delete class, collapsed to one line each */
  headlines: Headline[];
  /** Ids safe to archive once the headlines are glanced */
  headlineIds: { id: string; threadId: string }[];
};

const briefSchema = z.object({
  summary: z
    .string()
    .describe(
      "Two sentences: the state of the user's work life right now — what is urgent and theirs alone, what is merely waiting",
    ),
  matters: z.array(
    z.object({
      id: z.string().describe("stable kebab-case id, reuse existing ids"),
      title: z.string(),
      category: z.string(),
      orgUnit: z
        .string()
        .describe(
          "MUST be one of the payload's functions list, verbatim",
        ),
      orgConfidence: z
        .number()
        .min(0)
        .max(1)
        .describe(
          "confidence in the orgUnit call; cite-your-evidence honesty — direction or stage ambiguity lowers it",
        ),
      people: z.array(
        z.object({
          name: z.string(),
          email: z.string().optional(),
          relationship: z
            .string()
            .describe(
              'role — lifecycle/closeness, e.g. "client — new", "client — senior, close", "team", "vendor", "board", "regulator", "family", "prospect"',
            ),
        }),
      ),
      narrative: z.string(),
      nextAction: z.string(),
      owner: z.enum(["you", "team", "them"]),
      urgency: z.number().min(0).max(3),
      emailIds: z.array(z.string()),
    }),
  ),
});

function keyFor(accountEmail: string) {
  return `brief:${accountKey(accountEmail)}`;
}

export async function loadBrief(accountEmail: string): Promise<Brief | null> {
  return await kvGet<Brief>(keyFor(accountEmail));
}

const SYSTEM = `You are the chief of staff writing the daily state-of-play for a CEO's inbox. The emails you receive are the ones STILL IN the inbox — kept deliberately. Cluster them into MATTERS: ongoing threads of work life (a negotiation, an inspection, a deal, a dispute, a purchase). MATTERS ARE THE TOP-LEVEL UNIT; everything else is a facet on them. Reuse the previous matters' ids when the same matter continues; carry their state forward and update it with the new evidence. One matter per real-world concern, not per email.

Rules:
- narrative: one present-tense sentence of state ("Roche returned the signed SOW; the executed copy back to them gates the PO").
- nextAction: the ONE next move, imperative and specific, or "none — team handling".
- owner: "you" only when the user personally must act; "team" when a named other owns it; "them" when waiting on the counterparty.
- urgency 3 = costs money or a relationship today; 0 = dormant.
- orgUnit: MUST be one of the entries in the payload's "functions" list — the user's own org chart, verbatim. For named projects/studies under "operations — studies", append the project: "operations — studies — <project name>". The same matter keeps the same orgUnit across days.

HOW TO CLASSIFY orgUnit (the categories are function × workflow stage, NOT topics — two emails about the identical assay belong in different categories depending on whether money has changed hands):
1. DIRECTION OF COMMERCE FIRST: is money flowing TOWARD the user's company or AWAY from it? A countersigned NDA from a CUSTOMER is "sales — contracting"; the identical countersigned NDA from a SOFTWARE VENDOR is "systems (it)". Inbound revenue → the sales/operations path. Outbound spend → systems (it), office / facilities, marketing, recruiting, or hr, by what's being bought. Use the payload evidence: vendor=true means they bill the user (spend side).
2. STAGE within the revenue path:
   · "sales — leads": interest exists, no defined scope (intro calls, conference follow-ups, "exploring whether you could…")
   · "sales — new requests": specific scope, deliverable is a quote/feasibility/proposal (named assay + sample counts + a request to price)
   · "sales — contracting": scope agreed, deliverable is executed paperwork (MSA/SOW/CDA redlines, PO receipt as part of an award, signature routing)
   · "operations — studies": work is awarded and RUNNING (a resolved study code, site/IRB/protocol/enrollment/calibration language)
3. CLASSIFY BY THE PRIMARY DELIVERABLE — the action that unblocks the counterparty — not by every document mentioned. "Send CDA and feasibility response" is "sales — new requests" (the feasibility answer is the ask; the CDA is packaging). A PO arriving as part of an award is contracting; an invoice or payment chase on already-awarded work is "finance (ar/ap)".
4. labeledExamples in the payload are the user's OWN past categorizations of similar work — they are ground truth for how the user carves up their world. When an example closely matches, follow it over your own instinct.
- people: the humans IN the matter with relationship typing "role — lifecycle/closeness": "client — new" (first deal), "client — senior, close" (long history, warm), "vendor", "team" (works for the user), "board", "regulator", "prospect", "family". Use the previous matters and the user profile to keep relationship labels consistent — a person keeps the same relationship across matters unless the evidence changed.
- Emails that are pure one-line facts with no ongoing matter (newsletters worth a headline, status notices) do NOT get matters — leave them unassigned; they become headlines.
- Return AT MOST 14 matters — the most consequential; fold minor items into related matters or leave them unassigned.
- Never invent emails or matters. Every matter cites the emailIds that evidence it.`;

/**
 * Rebuild the brief from the CURRENT inbox (graded) + the previous
 * brief's matters (memory). One long-context call; runs deferred.
 */
export async function buildBrief(
  accountEmail: string,
  items: EmailItem[],
  profile?: UserProfile | null,
): Promise<Brief> {
  const prev = await loadBrief(accountEmail);

  // The read-then-delete class becomes headlines directly — the AI's
  // task line IS the headline; no model call needed for these.
  const headlineItems = items.filter(
    (i) => i.guide?.action === "read_and_delete",
  );
  const headlines: Headline[] = headlineItems.map((i) => ({
    id: i.id,
    threadId: i.threadId,
    line: stripEmoji(
      i.guide?.task && i.guide.task !== "none"
        ? i.guide.task
        : i.subject,
    ).slice(0, 90),
  }));

  // Matters get everything else that's still in the inbox — capped by
  // importance then recency so a 300-email backlog can't blow the call
  const matterCandidates = items
    .filter((i) => i.guide?.action !== "read_and_delete")
    .sort(
      (a, b) =>
        (b.guide?.importance ?? 1) - (a.guide?.importance ?? 1) ||
        (a.receivedAt < b.receivedAt ? 1 : -1),
    )
    .slice(0, 120);

  const functions = await loadFunctions(accountEmail);
  // The user's own labeled history — few-shot retrieved per candidate
  const exemplars = await loadExemplars(accountEmail).catch(() => []);
  // Spend-side evidence: senders who bill the user (merchant graph)
  const merchants = await loadMerchants(accountEmail).catch(() => ({}));
  const vendorEmails = new Set(
    Object.keys(merchants as Record<string, unknown>).map((k) =>
      k.toLowerCase(),
    ),
  );

  // Few-shot: nearest labeled examples across the candidate set
  const picked = new Map<string, string>();
  for (const i of matterCandidates) {
    for (const e of retrieveExemplars(
      `${i.subject} ${i.guide?.task ?? ""}`,
      exemplars,
      2,
    )) {
      picked.set(e.subject, e.category);
      if (picked.size >= 24) break;
    }
    if (picked.size >= 24) break;
  }

  const payload = {
    functions,
    labeledExamples: [...picked.entries()].map(([subject, category]) => ({
      subject,
      category,
    })),
    previousMatters: (prev?.matters ?? []).map((m) => ({
      id: m.id,
      title: m.title,
      narrative: m.narrative,
      owner: m.owner,
      urgency: m.urgency,
      orgUnit: m.orgUnit,
      people: m.people,
    })),
    inbox: matterCandidates.map((i) => {
      const study = `${i.subject}\n${i.snippet}`.match(STUDY_CODE)?.[0];
      const d = i.guide?.debug;
      return {
        id: i.id,
        from: stripEmoji(i.fromName || i.fromEmail),
        email: i.fromEmail,
        subject: stripEmoji(i.subject),
        gist: stripEmoji(i.guide?.task ?? i.snippet.slice(0, 160)),
        action: i.guide?.action,
        category: i.guide?.category,
        importance: i.guide?.importance,
        receivedAt: i.receivedAt.slice(0, 10),
        // Deterministic evidence: resolved before the model reasons
        ...(study ? { studyCode: study.toUpperCase() } : {}),
        ...(vendorEmails.has(i.fromEmail.toLowerCase())
          ? { vendor: true }
          : {}),
        ...(d && d.sentTo === 0 && d.receivedFrom <= 1
          ? { firstContact: true }
          : {}),
      };
    }),
  };

  const { model } = await getTriageModel();
  const profileBlock = profilePromptBlock(profile ?? null);
  const { output } = await generateText({
    model,
    temperature: 0,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(120_000),
    output: Output.object({ schema: briefSchema }),
    system: profileBlock ? `${SYSTEM}\n\n${profileBlock}` : SYSTEM,
    prompt: JSON.stringify(payload),
  });

  const byId = new Map(matterCandidates.map((i) => [i.id, i]));
  const matters: Matter[] = output.matters
    .map((m) => ({
      ...m,
      emailIds: m.emailIds.filter((id) => byId.has(id)),
      threadIds: [
        ...new Set(
          m.emailIds
            .map((id) => byId.get(id)?.threadId)
            .filter((t): t is string => Boolean(t)),
        ),
      ],
      updatedAt: new Date().toISOString(),
    }))
    .filter((m) => m.emailIds.length > 0)
    .sort((a, b) => b.urgency - a.urgency);

  const brief: Brief = {
    builtAt: new Date().toISOString(),
    summary: output.summary,
    matters,
    headlines,
    headlineIds: headlineItems.map((i) => ({
      id: i.id,
      threadId: i.threadId,
    })),
  };
  await kvSet(keyFor(accountEmail), brief);
  return brief;
}
