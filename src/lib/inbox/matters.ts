import { getTriageModel } from "@/lib/inbox/gemini-triage";
import { stripEmoji, type EmailItem } from "@/lib/inbox/types";
import { loadExemplars, retrieveExemplars } from "@/lib/store/exemplars";
import { loadFunctions } from "@/lib/store/functions";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";
import { loadMatterFixes, type MatterFixes } from "@/lib/store/matter-fixes";
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

/** An inbox email with no matter — but it still has an org home */
export type FiledEmail = {
  emailId: string;
  threadId: string;
  orgUnit: string;
  line: string;
};

/** The FYI / read-and-delete mass, summarized AS A WHOLE */
export type Digest = {
  /** One paragraph covering everything below — read this, skip the rest */
  summary: string;
  themes: { theme: string; line: string; emailIds: string[] }[];
};

/** Where the AI could not make the call — the user's actual triage work */
export type UnsureItem = {
  emailId: string;
  threadId: string;
  question: string;
};

export type Brief = {
  builtAt: string;
  summary: string;
  matters: Matter[];
  /** The read-then-delete class, collapsed to one line each */
  headlines: Headline[];
  /** Ids safe to archive once the headlines are glanced */
  headlineIds: { id: string; threadId: string }[];
  /** The org registry snapshot the brief was built against */
  functions?: string[];
  /** Total inbox size at build time — the coverage denominator */
  totalInbox?: number;
  /** Non-matter emails, each filed to an org unit — full-corpus accounting */
  filed?: FiledEmail[];
  /** Collective summary of the FYI / read-and-delete mass */
  digest?: Digest;
  /** The only rows that need a human: AI couldn't make the call */
  unsure?: UnsureItem[];
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
  filed: z
    .array(
      z.object({
        emailId: z.string(),
        orgUnit: z
          .string()
          .describe("one of the payload's functions list, verbatim"),
      }),
    )
    .optional()
    .describe(
      "EVERY inbox email that is not in a matter and not unsure gets filed to an org unit here — total coverage, no email left unaccounted",
    ),
  unsure: z
    .array(
      z.object({
        emailId: z.string(),
        question: z
          .string()
          .describe(
            'the one-line question only the user can answer, e.g. "Is the Werfen intro a lead or personal networking?"',
          ),
      }),
    )
    .optional()
    .describe(
      "ONLY where you genuinely cannot make the call — ambiguous direction of commerce, unknown person, unclear if user opted in. Aim for near-zero.",
    ),
  digestSummary: z
    .string()
    .optional()
    .describe(
      "One paragraph covering the ENTIRE digestInbox as a whole — what the noise collectively says (renewals due, shipments moving, newsletters' one real insight). The user reads this instead of the emails.",
    ),
  digestThemes: z
    .array(
      z.object({
        theme: z.string().describe('short label, e.g. "Shipments" or "SaaS renewals"'),
        line: z
          .string()
          .describe("one sentence covering every email in this theme"),
        emailIds: z.array(z.string()),
      }),
    )
    .optional()
    .describe("group ALL digestInbox emails into 3-8 themes"),
});

function keyFor(accountEmail: string) {
  return `brief:${accountKey(accountEmail)}`;
}

export async function loadBrief(accountEmail: string): Promise<Brief | null> {
  return await kvGet<Brief>(keyFor(accountEmail));
}

export async function saveBrief(
  accountEmail: string,
  brief: Brief,
): Promise<void> {
  await kvSet(keyFor(accountEmail), brief);
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
- Return AT MOST 14 matters — the most consequential; fold minor items into related matters or file the rest.

TOTAL COVERAGE — the inbox is a living corpus and every email must be accounted for:
- Every id in "inbox" appears in EXACTLY ONE of: a matter's emailIds, "filed", or "unsure". No email may be silently dropped.
- "filed" = real but not an ongoing matter: file it to its org unit (same classification doctrine as matters). This is how the whole inbox lands in the user's org format.
- "unsure" = you genuinely cannot make the call and need the user (ambiguous direction of commerce, unknown person, can't tell if opted-in). Be decisive — unsure should be nearly empty.
- userOrgCorrections in the payload are the user's OWN fixes to earlier org calls — absolute ground truth, follow them exactly for those matters and let them teach you the pattern for similar ones.

THE DIGEST — "digestInbox" is the FYI / read-then-delete mass. Do NOT make matters from it. Summarize it AS A WHOLE: digestSummary is the one paragraph the user reads INSTEAD of these emails (name the few facts that matter: amounts, dates, the single insight worth keeping); digestThemes groups every digest email into 3-8 themes with one covering sentence each. Every digestInbox id appears in exactly one theme.

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

  // The FYI / read-then-delete mass — summarized as a whole (the
  // digest), never worked one by one. Headlines stay as the per-line
  // fallback for clients that predate the digest.
  const DIGEST_ACTIONS = new Set(["read_and_delete", "glance_promo"]);
  const digestItems = items
    .filter((i) => DIGEST_ACTIONS.has(i.guide?.action ?? ""))
    .slice(0, 150);
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
    .filter((i) => !DIGEST_ACTIONS.has(i.guide?.action ?? ""))
    .sort(
      (a, b) =>
        (b.guide?.importance ?? 1) - (a.guide?.importance ?? 1) ||
        (a.receivedAt < b.receivedAt ? 1 : -1),
    )
    .slice(0, 120);

  const functions = await loadFunctions(accountEmail);
  // The user's own org corrections — absolute ground truth
  const fixes: MatterFixes = await loadMatterFixes(accountEmail).catch(
    () => ({}),
  );
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
    userOrgCorrections: Object.entries(fixes).map(([matterId, f]) => ({
      matterId,
      orgUnit: f.orgUnit,
    })),
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
    digestInbox: digestItems.map((i) => ({
      id: i.id,
      from: stripEmoji(i.fromName || i.fromEmail),
      subject: stripEmoji(i.subject),
      gist: stripEmoji(i.guide?.task ?? i.snippet.slice(0, 120)),
    })),
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
      // User corrections are ground truth even if the model ignored them
      orgUnit: fixes[m.id]?.orgUnit ?? m.orgUnit,
      orgConfidence: fixes[m.id] ? 1 : m.orgConfidence,
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

  // TOTAL COVERAGE — account for every candidate. Anything the model
  // dropped lands in unsure so nothing silently vanishes from Atlas.
  const inMatters = new Set(matters.flatMap((m) => m.emailIds));
  const filed: FiledEmail[] = (output.filed ?? [])
    .filter((f) => byId.has(f.emailId) && !inMatters.has(f.emailId))
    .map((f) => {
      const i = byId.get(f.emailId)!;
      return {
        emailId: f.emailId,
        threadId: i.threadId,
        orgUnit: f.orgUnit,
        line: stripEmoji(
          `${i.fromName || i.fromEmail} — ${i.guide?.task && i.guide.task !== "none" ? i.guide.task : i.subject}`,
        ).slice(0, 110),
      };
    });
  const inFiled = new Set(filed.map((f) => f.emailId));
  const unsure: UnsureItem[] = (output.unsure ?? [])
    .filter(
      (u) =>
        byId.has(u.emailId) &&
        !inMatters.has(u.emailId) &&
        !inFiled.has(u.emailId),
    )
    .map((u) => ({
      emailId: u.emailId,
      threadId: byId.get(u.emailId)!.threadId,
      question: stripEmoji(u.question).slice(0, 140),
    }));
  const accounted = new Set([...inMatters, ...inFiled, ...unsure.map((u) => u.emailId)]);
  for (const i of matterCandidates) {
    if (!accounted.has(i.id)) {
      unsure.push({
        emailId: i.id,
        threadId: i.threadId,
        question: `Where does "${stripEmoji(i.subject).slice(0, 60)}" from ${stripEmoji(i.fromName || i.fromEmail)} belong?`,
      });
    }
  }

  const digestIdSet = new Set(digestItems.map((i) => i.id));
  const digest: Digest = {
    summary: output.digestSummary ?? "",
    themes: (output.digestThemes ?? [])
      .map((t) => ({
        ...t,
        emailIds: t.emailIds.filter((id) => digestIdSet.has(id)),
      }))
      .filter((t) => t.emailIds.length > 0),
  };

  const brief: Brief = {
    builtAt: new Date().toISOString(),
    summary: output.summary,
    matters,
    headlines,
    // Clear-all now covers the whole digest (fyi + read-and-delete)
    headlineIds: digestItems.map((i) => ({
      id: i.id,
      threadId: i.threadId,
    })),
    functions,
    totalInbox: items.length,
    filed,
    digest,
    unsure,
  };
  await kvSet(keyFor(accountEmail), brief);
  return brief;
}
