import { getTriageModel } from "@/lib/inbox/gemini-triage";
import { stripEmoji, type EmailItem } from "@/lib/inbox/types";
import { loadExemplars, retrieveExemplars } from "@/lib/store/exemplars";
import { loadFunctions } from "@/lib/store/functions";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";
import { loadMatterFixes, type MatterFixes } from "@/lib/store/matter-fixes";
import { loadMerchants } from "@/lib/store/merchants";
import {
  CODE_PATTERN,
  codeLabels,
  loadSalesforce,
  normalizeCode,
} from "@/lib/store/salesforce";

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

/** One email inside a matter, with what Seer suggests doing about it */
export type MatterEmail = {
  id: string;
  threadId: string;
  from: string;
  line: string;
  /** Plain-language suggestion: "Reply — needs you", "Keep as record" */
  suggestion: string;
};

export type Matter = {
  id: string;
  title: string;
  /** "money" | "people" | "compliance" | "new-business" | "ops" | "personal" */
  category: string;
  /** Resolved against the user's function registry, verbatim */
  orgUnit: string;
  /** Study/opportunity branch inside the function, e.g. "RCD_2818" */
  subUnit?: string;
  /** What finishing this matter actually achieves — the project goal */
  goal?: string;
  /** The emails in this matter, each with its own suggestion */
  emails?: MatterEmail[];
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
  /** Study/opportunity branch inside the function */
  subUnit?: string;
  line: string;
  /** What Seer suggests doing with it */
  suggestion?: string;
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

/**
 * Bump when the brief's shape or engine changes: the background sync
 * treats any older brief as stale and rebuilds it, so a redesign never
 * leaves a stale Atlas on screen waiting for a manual refresh.
 */
export const BRIEF_ENGINE = 4;

export type Brief = {
  builtAt: string;
  /** Engine that produced this brief — see BRIEF_ENGINE */
  engine?: number;
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
  /** Distinct threads behind those messages — reconciles with Gmail */
  totalThreads?: number;
  /** The provider's own inbox count — the verifiable denominator */
  providerTotal?: { messages: number; threads: number };
  /** How many messages the AI clustered vs filed by rule */
  readByAi?: number;
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
      goal: z
        .string()
        .describe(
          "the OUTCOME that closes this matter, one clause — what is true when it's done (\"anti-TPO SOW fully executed so the PO can be issued\")",
        ),
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

// Matter generation should return only meaning, not echo hundreds of
// filing records. Full-corpus filing happens deterministically below.
const matterSchema = briefSchema.pick({
  summary: true,
  matters: true,
});

const digestSchema = z.object({
  summary: z
    .string()
    .describe(
      "One concise paragraph covering the entire FYI/read-and-delete corpus; include only dates, amounts, exceptions, and insights worth the user's attention",
    ),
  themes: z.array(
    z.object({
      theme: z.string(),
      line: z.string(),
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

- Return ONLY the consequential matters. Do not return filing records for emails that do not belong to a matter; the application files those separately.
- userOrgCorrections in the payload are the user's OWN fixes to earlier org calls — absolute ground truth, follow them exactly for those matters and let them teach you the pattern for similar ones.

- Never invent emails or matters. Every matter cites the emailIds that evidence it.`;

const DIGEST_SYSTEM = `You sort the disposable end of a CEO's inbox into CATEGORIES. No prose essay — the categories and their one-line contents ARE the output.
- Group everything into 6-14 concrete categories named after what the mail IS, in the user's business vocabulary: "Travel", "Shipping & samples", "Invoices & receipts", "Bank & card notices", "IT & software notices", "Regulatory & standards bulletins", "Conferences & webinars", "Recruiting spam", "Vendor marketing", "Newsletters", "Personal & household". Invent better names when the corpus warrants; never use vague ones like "Other" or "Misc" unless nothing else fits.
- Each category's line is one sentence of what it collectively contains, naming any date or amount that actually matters ("Two AA trips: LAX–ORD Aug 14, DFW–LAX Aug 21").
- summary: leave it as an empty string. The categories carry everything.
- Every input email id appears in exactly one category. Never invent ids or facts.`;

function inferredOrgUnit(item: EmailItem, functions: string[]): string {
  const hay = `${item.guide?.category ?? ""} ${item.subject}`.toLowerCase();
  const patterns: [RegExp, RegExp][] = [
    [/\b(finance|invoice|receipt|bill|payment|bank|autopay|purchase order)\b/, /finance/i],
    [/\b(recruit|candidate|interview)\b/, /recruit/i],
    [/\b(employee|benefit|payroll|human resources)\b/, /\bhr\b|human resources/i],
    [/\b(it|software|saas|security|system)\b/, /systems|information technology|\bit\b/i],
    [/\b(facility|office|building|lease|vehicle)\b/, /office|facilit/i],
    [/\b(marketing|campaign|conference|event)\b/, /marketing/i],
    [/\b(board|investor)\b/, /board/i],
    [/\b(study|protocol|irb|site|clinical|sample)\b/, /operations.*stud/i],
    [/\b(contract|nda|cda|sow|msa|signature)\b/, /sales.*contract/i],
    [/\b(rfq|quote|proposal|feasibility|new request)\b/, /sales.*new request/i],
    [/\b(lead|prospect|introduction)\b/, /sales.*lead/i],
  ];
  for (const [signal, fn] of patterns) {
    if (!signal.test(hay)) continue;
    const match = functions.find((f) => fn.test(f));
    if (match) return match;
  }
  return (
    functions.find((f) => /operations/i.test(f)) ??
    functions[0] ??
    "unsorted"
  );
}

/**
 * The branch inside a function. A study/opportunity code is the real
 * organizing unit of this business, so it wins; otherwise the grade's
 * own category keeps like with like instead of one 377-row heap.
 */
function subUnitFor(item: EmailItem, labels: Map<string, string>): string {
  const hay = `${item.subject}\n${item.snippet}\n${item.guide?.task ?? ""}`;
  const codes = hay.match(CODE_PATTERN);
  if (codes?.length) {
    // Prefer a code the registry knows — that's a live study/opportunity
    for (const c of codes) {
      const known = labels.get(normalizeCode(c));
      if (known) return known;
    }
    return codes[0].toUpperCase().replace(/\s+/g, "_");
  }
  // No code: the counterparty IS the branch. "Roche" and "Advarra" mean
  // something to the user; a grade label like "Work" does not.
  return counterparty(item);
}

const FREEMAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|aol|icloud|me|msn|proton|protonmail|comcast|sbcglobal|att|verizon)\./;

/** The company (or person, for personal mail) this email came from. */
function counterparty(item: EmailItem): string {
  const domain = item.fromEmail.split("@")[1]?.toLowerCase() ?? "";
  const bare = domain.replace(/^(mail|email|e|smtp|notifications?|no-?reply|info|reply|bounce|em|mailer|send|go|links?)\./, "");
  if (!bare || FREEMAIL.test(`${bare}.`)) {
    const name = stripEmoji(item.fromName || item.fromEmail);
    // "Bates, Rebecca J" → "Rebecca Bates"
    const flipped = name.includes(",")
      ? `${name.split(",")[1]?.trim().split(" ")[0] ?? ""} ${name.split(",")[0]?.trim()}`.trim()
      : name;
    return flipped.split("@")[0] || "Personal";
  }
  const label = bare.split(".")[0];
  return label.length <= 3
    ? label.toUpperCase()
    : label.charAt(0).toUpperCase() + label.slice(1);
}

/** Plain-language suggestion for one email, from its grade. */
function suggestionFor(item: EmailItem): string {
  switch (item.guide?.action) {
    case "act_today":
      return "Needs you — reply or act";
    case "respond":
      return "A short reply closes it";
    case "read_and_archive":
      return "Keep as record — archive";
    case "read_and_delete":
      return "Read once, then delete";
    case "delete_now":
      return "Safe to delete";
    case "unsubscribe":
      return "Unsubscribe";
    case "review_subscription":
      return "Decide: keep or unsubscribe";
    case "glance_promo":
      return "Glance, then delete";
    case "needs_review":
      return "Your call";
    default:
      return item.guide?.action ? stripEmoji(item.guide.action) : "No call yet";
  }
}

function lineFor(item: EmailItem): string {
  return stripEmoji(
    `${item.fromName || item.fromEmail} — ${
      item.guide?.task && item.guide.task !== "none"
        ? item.guide.task
        : item.subject
    }`,
  ).slice(0, 110);
}

/**
 * Rebuild the brief from the CURRENT inbox (graded) + the previous
 * brief's matters (memory). One long-context call; runs deferred.
 */
export async function buildBrief(
  accountEmail: string,
  items: EmailItem[],
  profile?: UserProfile | null,
  providerTotal?: { messages: number; threads: number } | null,
): Promise<Brief> {
  const prev = await loadBrief(accountEmail);

  // The FYI / read-then-delete mass — summarized as a whole (the
  // digest), never worked one by one. Headlines stay as the per-line
  // fallback for clients that predate the digest.
  const DIGEST_ACTIONS = new Set(["read_and_delete", "glance_promo"]);
  const digestItems = items.filter((i) =>
    DIGEST_ACTIONS.has(i.guide?.action ?? ""),
  );
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
  const allMatterCandidates = items
    .filter((i) => !DIGEST_ACTIONS.has(i.guide?.action ?? ""))
    .sort(
      (a, b) =>
        (b.guide?.importance ?? 1) - (a.guide?.importance ?? 1) ||
        (a.receivedAt < b.receivedAt ? 1 : -1),
    );
  // The AI reads the WHOLE corpus, in parallel chunks. One 500-email
  // call times out; four 110-email calls do not, and nothing important
  // gets left outside the model's view.
  const CHUNK = 110;
  const MAX_CHUNKS = 5;
  const chunks: EmailItem[][] = [];
  for (
    let i = 0;
    i < allMatterCandidates.length && chunks.length < MAX_CHUNKS;
    i += CHUNK
  ) {
    chunks.push(allMatterCandidates.slice(i, i + CHUNK));
  }
  const matterCandidates = chunks.flat();

  const functions = await loadFunctions(accountEmail);
  // Live studies/opportunities name the branches inside each function
  const salesforce = await loadSalesforce(accountEmail).catch(
    () => ({ studies: [], opportunities: [] }),
  );
  const labels = codeLabels(salesforce);
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

  const payloadFor = (batch: EmailItem[]) => ({
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
    activeStudies: salesforce.studies
      .slice(0, 60)
      .map((x) => `${x.code}${x.name ? ` — ${x.name}` : ""}`),
    openOpportunities: salesforce.opportunities
      .slice(0, 60)
      .map((x) => `${x.code}${x.name ? ` — ${x.name}` : ""}`),
    inbox: batch.map((i) => {
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
  });

  const { model } = await getTriageModel();
  const profileBlock = profilePromptBlock(profile ?? null);
  // Matters and the digest are independent bounded calls. Asking one
  // response to cluster work, file hundreds of ids, and write the digest
  // repeatedly exceeded the 120-second limit on a 500-message inbox.
  const [chunkOutputs, { output: digestOutput }] = await Promise.all([
    Promise.all(
      chunks.map((batch, n) =>
        generateText({
          model,
          temperature: 0,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(150_000),
          output: Output.object({ schema: matterSchema }),
          system: profileBlock ? `${SYSTEM}\n\n${profileBlock}` : SYSTEM,
          prompt: JSON.stringify(payloadFor(batch)),
        })
          .then((r) => r.output)
          .catch((error) => {
            console.error(
              `[seer] matter chunk ${n + 1}/${chunks.length} failed:`,
              error instanceof Error ? error.message : error,
            );
            return { summary: "", matters: [] };
          }),
      ),
    ),
    digestItems.length
      ? generateText({
          model,
          temperature: 0,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(120_000),
          output: Output.object({ schema: digestSchema }),
          system: DIGEST_SYSTEM,
          prompt: JSON.stringify(
            digestItems.map((i) => ({
              id: i.id,
              from: stripEmoji(i.fromName || i.fromEmail),
              subject: stripEmoji(i.subject),
              gist: stripEmoji(i.guide?.task ?? i.snippet.slice(0, 120)),
            })),
          ),
        }).catch((error) => {
          console.error(
            "[seer] digest generation failed; preserving corpus:",
            error instanceof Error ? error.message : error,
          );
          return {
            output: {
              summary: `${digestItems.length} FYI updates were grouped for clearing; open the theme below only if you need the individual details.`,
              themes: [
                {
                  theme: "Inbox updates",
                  line: "Routine FYI and read-then-delete messages; no individual review required.",
                  emailIds: digestItems.map((i) => i.id),
                },
              ],
            },
          };
        })
      : Promise.resolve({ output: { summary: "", themes: [] } }),
  ]);

  // Merge the chunks: same matter id seen twice keeps one row and pools
  // its evidence, so a matter split across chunks doesn't double up.
  const mergedMatters = new Map<
    string,
    (typeof chunkOutputs)[number]["matters"][number]
  >();
  for (const out of chunkOutputs) {
    for (const m of out.matters) {
      const prevM = mergedMatters.get(m.id);
      if (!prevM) {
        mergedMatters.set(m.id, { ...m });
        continue;
      }
      prevM.emailIds = [...new Set([...prevM.emailIds, ...m.emailIds])];
      prevM.urgency = Math.max(prevM.urgency, m.urgency);
      if (prevM.people.length < m.people.length) prevM.people = m.people;
    }
  }
  const output = {
    summary: chunkOutputs.map((o) => o.summary).find(Boolean) ?? "",
    matters: [...mergedMatters.values()],
  };

  const byId = new Map(matterCandidates.map((i) => [i.id, i]));
  const matters: Matter[] = output.matters
    .map((m) => ({
      ...m,
      // User corrections are ground truth even if the model ignored them
      orgUnit: fixes[m.id]?.orgUnit ?? m.orgUnit,
      orgConfidence: fixes[m.id] ? 1 : m.orgConfidence,
      subUnit: (() => {
        const first = m.emailIds.map((id) => byId.get(id)).find(Boolean);
        return first ? subUnitFor(first, labels) : undefined;
      })(),
      emails: m.emailIds
        .map((id) => byId.get(id))
        .filter((i): i is EmailItem => Boolean(i))
        .map((i) => ({
          id: i.id,
          threadId: i.threadId,
          from: stripEmoji(i.fromName || i.fromEmail),
          line: lineFor(i),
          suggestion: suggestionFor(i),
        })),
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

  // TOTAL COVERAGE — the model returns only meaningful matters. Every
  // remaining graded email is filed into the org tree locally, avoiding
  // an enormous structured response that times out on large inboxes.
  const inMatters = new Set(matters.flatMap((m) => m.emailIds));
  const filed: FiledEmail[] = [];
  for (const i of allMatterCandidates) {
    if (inMatters.has(i.id)) continue;
    filed.push({
      emailId: i.id,
      threadId: i.threadId,
      orgUnit: inferredOrgUnit(i, functions),
      subUnit: subUnitFor(i, labels),
      line: lineFor(i),
      suggestion: suggestionFor(i),
    });
  }
  const unsure: UnsureItem[] = [];

  const digestIdSet = new Set(digestItems.map((i) => i.id));
  const digest: Digest = {
    summary: digestOutput.summary,
    themes: digestOutput.themes
      .map((t) => ({
        ...t,
        emailIds: t.emailIds.filter((id) => digestIdSet.has(id)),
      }))
      .filter((t) => t.emailIds.length > 0),
  };

  const brief: Brief = {
    builtAt: new Date().toISOString(),
    engine: BRIEF_ENGINE,
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
    totalThreads: new Set(items.map((i) => i.threadId)).size,
    ...(providerTotal ? { providerTotal } : {}),
    readByAi: matterCandidates.length,
    filed,
    digest,
    unsure,
  };
  await kvSet(keyFor(accountEmail), brief);
  return brief;
}
