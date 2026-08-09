import {
  getFallbackModel,
  getTriageModel,
  isModelBudgetError,
} from "@/lib/inbox/gemini-triage";
import { collapseThreads } from "@/lib/inbox/thread-collapse";
import { stripEmoji, type EmailItem } from "@/lib/inbox/types";
import type {
  Understanding,
  UnderstandingMap,
} from "@/lib/inbox/understanding";
import { loadExemplars, retrieveExemplars } from "@/lib/store/exemplars";
import { loadFunctions } from "@/lib/store/functions";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";
import { loadMatterFixes, type MatterFixes } from "@/lib/store/matter-fixes";
import { loadMatterEdits } from "@/lib/store/manual-matters";
import {
  loadClosedMatters,
  matchesClosure,
  saveClosedMatters,
  type ClosedMatters,
} from "@/lib/store/closed-matters";
import {
  digestWithoutHomedThreads,
  matterCandidateFor,
  matterFromRead,
  type MatterCandidate,
} from "@/lib/inbox/triage-view";
import {
  buildInboxAccounting,
  type InboxAccounting,
} from "@/lib/inbox/inbox-accounting";
import { loadMerchants } from "@/lib/store/merchants";
import {
  CODE_PATTERN,
  codeLabels,
  loadSalesforce,
  normalizeCode,
  opportunityIndex,
  type SalesforceRegistry,
} from "@/lib/store/salesforce";

/**
 * Deterministic evidence, gathered BEFORE the model reasons — study
 * codes are highly structured and a resolved code is a strong
 * "work is awarded and running" (operations) signal.
 */
const STUDY_CODE =
  /\b(RCD[_-]?\d{3,5}|LMD[_-]?\d{3,5}|RD\d{6,7}|TGRP\d{1,3}|RFQ[ #-]?\d{4,6})\b/i;
import { profilePromptBlock, type UserProfile } from "@/lib/store/user-profile";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

/** A model error, reduced to a short human sentence for the UI. */
function cleanModelError(msg: string): string {
  // Both budgets exhausted: the direct Gemini key's prepayment credits AND
  // the Vercel AI Gateway free tier ("rate-limited — upgrade to paid").
  if (
    /prepayment|credits?\b|billing|payment required|402|free tier|upgrade to paid|GatewayRateLimit/i.test(
      msg,
    )
  ) {
    return "AI credits are out — add credits to the Gemini key or the Vercel AI Gateway to group new mail.";
  }
  if (/quota|rate.?limit|429|RESOURCE_EXHAUSTED/i.test(msg)) {
    return "AI quota hit — grouping will catch up on the next sync.";
  }
  if (/timed? ?out|abort|deadline/i.test(msg)) {
    return "AI timed out — grouping will retry on the next sync.";
  }
  return "Some grouping calls failed — grouping will retry on the next sync.";
}

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

/**
 * One CONVERSATION inside a matter. A thread is one row however many
 * messages it holds — six replies about the same request are one piece
 * of work, not six.
 */
export type MatterEmail = {
  id: string;
  threadId: string;
  from: string;
  line: string;
  /** Plain-language suggestion: "Reply — needs you", "Keep as record" */
  suggestion: string;
  /** Inbox messages collapsed into this row */
  count?: number;
  /** Newest message time in this conversation (ISO) */
  at?: string;
  /** Native provider fields for the newest message — for export/audit */
  fromEmail?: string;
  subject?: string;
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
  /** Live CRM facts for the study/opportunity behind this matter */
  crm?: {
    code?: string;
    account?: string;
    stage?: string;
    amount?: number;
    closeDate?: string;
    status?: string;
    investigators?: string[];
  };
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
  /**
   * Lifecycle, event-driven (never a timer): "active" (moving),
   * "waiting" (ball elsewhere), "looks-closed" (superseding evidence or
   * a closed CRM stage — a closure PROPOSAL, never auto-executed),
   * "dormant" (quiet but alive — an open opportunity or recent work),
   * "reopened" (new mail after it was closed).
   */
  status?: "active" | "waiting" | "looks-closed" | "dormant" | "reopened";
  /** One line explaining the status ("executed SOW went back June 3") */
  statusWhy?: string;
  emailIds: string[];
  threadIds: string[];
  updatedAt: string;
};

export type Headline = {
  id: string;
  threadId: string;
  line: string;
};

/**
 * An inbox CONVERSATION with no matter — one row per thread, with an
 * org home. `emailId` is the newest message (what opening it shows);
 * `messageIds` is everything acting on the row must sweep.
 */
export type FiledEmail = {
  emailId: string;
  threadId: string;
  orgUnit: string;
  /** Study/opportunity branch inside the function */
  subUnit?: string;
  /** Native provider fields for the newest message — for export/audit */
  fromName?: string;
  fromEmail?: string;
  subject?: string;
  /** The deep read's verdict: matter | record | fyi | disposable */
  disposition?: string;
  /** True when the sender has a real relationship (VIP / written-to /
   *  saved contact) — such rows are never bulk-deletable. */
  known?: boolean;
  line: string;
  /** What Seer suggests doing with it */
  suggestion?: string;
  /** Inbox messages in this thread */
  count?: number;
  /** Every message id behind the row — the coverage denominator */
  messageIds?: string[];
  /** Newest message time in this conversation (ISO) */
  at?: string;
  /** Deep read says this is ongoing work that clustering failed to place. */
  matterCandidate?: MatterCandidate;
};

/** The FYI / read-and-delete mass, summarized AS A WHOLE */
export type Digest = {
  /** One paragraph covering everything below — read this, skip the rest */
  summary: string;
  themes: {
    theme: string;
    line: string;
    emailIds: string[];
    /** Individual evidence, available only when the user expands a theme. */
    items?: {
      id: string;
      threadId: string;
      line: string;
      at: string;
      /** Native provider fields — for export/audit */
      fromName?: string;
      fromEmail?: string;
      subject?: string;
      /** Function the message rolls up to, for category grouping in Triage */
      orgUnit?: string;
      /** The deep read's verdict: fyi | disposable */
      disposition?: string;
    }[];
  }[];
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
export const BRIEF_ENGINE = 19;

/**
 * The forecast lens — "what matters WHEN". A temporal view over the same
 * matters (by id), not a second tree: Now (act or it costs something),
 * Next (coming up), Waiting (ball elsewhere), At risk (a closure proposal
 * or a decision needed), Quiet but alive (dormant, still open).
 */
export type Forecast = {
  now: string[];
  next: string[];
  waiting: string[];
  atRisk: string[];
  quiet: string[];
};

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
  /** Matters pinned above the org tree — the signature queue lives here */
  pinned?: Matter[];
  /** "What matters when" — matter ids bucketed by the forecast lens */
  forecast?: Forecast;
  /** Shared Atlas/Triage accounting; both dashboards render this object. */
  accounting?: InboxAccounting;
  /** Deep reads still outstanding — Atlas says so rather than pretending */
  unread?: number;
  /** Clustering calls that errored — a silent 0-matters brief is a bug */
  clusterFailures?: number;
  /** Human explanation when clustering degraded (billing, quota, timeout) */
  clusterError?: string;
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
      status: z
        .enum(["active", "waiting", "looks-closed", "dormant"])
        .optional()
        .describe(
          'lifecycle from the EVIDENCE, never a clock: "active" = moving, work is being done or owed; "waiting" = the ball is in the counterparty\'s court; "looks-closed" = later evidence says the goal is met or the deal ended (signed, paid, awarded, lost) — a PROPOSAL to archive, so cite it in statusWhy; "dormant" = no recent movement but not resolved (a long-tail deal). When unsure, "active".',
        ),
      statusWhy: z
        .string()
        .optional()
        .describe(
          'one line of evidence for the status, especially for looks-closed ("the executed SOW went back to Roche June 3; the goal is met")',
        ),
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

EACH INBOX ENTRY IS A WHOLE CONVERSATION, not a single message. Its id is the newest message; "messages" is how many replies it holds and "voices" who has spoken. Cite the entry's id once — never split a conversation across matters.

ONE MATTER PER REAL-WORLD CONCERN, and that concern is usually THE COUNTERPARTY'S PROGRAM, not the individual request. The payload groups entries by counterparty and study code precisely so you can see the whole relationship at once:
- Every conversation with the same company about the same program is ONE matter. Six sample requests from one company's scientist — different assays, different follow-ups — are one matter ("Abbott sample requests"), with each conversation cited under it. Do NOT emit one matter per request, per assay, or per follow-up.
- Split a counterparty into two matters only when the work is genuinely separate: a different study code, or a contract negotiation versus running operations.
- Never emit two matters with near-identical titles or overlapping subject matter. If you are about to, they are the same matter: emit one and cite all its conversations.

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
- Return every consequential matter supported by the evidence. Do not impose
  a numeric ceiling. Fold messages only when they are the same real-world
  concern; never file ongoing work merely to keep the list short.

- Return ONLY the consequential matters. Do not return filing records for emails that do not belong to a matter; the application files those separately.
- userOrgCorrections in the payload are the user's OWN fixes to earlier org calls — absolute ground truth, follow them exactly for those matters and let them teach you the pattern for similar ones.

- Emails whose payload carries "awaitsSignature" are already handled by a dedicated signature queue. Do NOT build a matter about signing them; if such an email is also part of a larger negotiation, cluster that negotiation on its other evidence.
- Never invent emails or matters. Every matter cites the emailIds that evidence it.`;

const DIGEST_SYSTEM = `You sort the disposable end of a CEO's inbox into CATEGORIES. No prose essay — the categories and their one-line contents ARE the output.
- Group everything into 6-14 concrete categories named after what the mail IS, in the user's business vocabulary: "Travel", "Shipping & samples", "Invoices & receipts", "Bank & card notices", "IT & software notices", "Regulatory & standards bulletins", "Conferences & webinars", "Recruiting spam", "Vendor marketing", "Newsletters", "Personal & household". Invent better names when the corpus warrants; never use vague ones like "Other" or "Misc" unless nothing else fits.
- Each category's line is one sentence of what it collectively contains, naming any date or amount that actually matters ("Two AA trips: LAX–ORD Aug 14, DFW–LAX Aug 21").
- summary: leave it as an empty string. The categories carry everything.
- Every input email id appears in exactly one category. Never invent ids or facts.`;

/**
 * Where a message lives in the org chart. The deep read decides — it has
 * seen the whole document. Rules only validate the answer against the
 * user's own registry and, failing that, pick the least-wrong home.
 */
function orgUnitFor(
  item: EmailItem,
  functions: string[],
  u?: Understanding,
): { unit: string; confidence: number } {
  const claimed = u?.org.unit?.trim();
  if (claimed) {
    const exact = functions.find(
      (f) => f.toLowerCase() === claimed.toLowerCase(),
    );
    if (exact) return { unit: exact, confidence: u?.org.confidence ?? 0.7 };
    // The model named something close to a registry entry
    const near = functions.find(
      (f) =>
        claimed.toLowerCase().startsWith(f.toLowerCase()) ||
        f.toLowerCase().startsWith(claimed.toLowerCase()),
    );
    if (near) return { unit: near, confidence: (u?.org.confidence ?? 0.7) * 0.9 };
  }
  // Never read (or the read failed): park it where it can be found, and say
  // so with a low confidence rather than inventing a category.
  const fallback =
    functions.find((f) => /operations/i.test(f)) ?? functions[0] ?? "unsorted";
  return { unit: fallback, confidence: 0 };
}

/**
 * The branch inside a function. A study/opportunity code is the real
 * organizing unit of this business, so it wins; otherwise the grade's
 * own category keeps like with like instead of one 377-row heap.
 */
function subUnitFor(
  item: EmailItem,
  labels: Map<string, string>,
  ownDomain: string,
): string {
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
  // something to the user. Internal mail branches by colleague — our own
  // company name says nothing.
  return counterparty(item, ownDomain);
}

/** Credentials trailing a name, not a first name: "Samoszuk, M.D." */
const NAME_SUFFIX =
  /^(md|phd|jr|sr|ii|iii|iv|mba|rn|np|pa|do|dds|dvm|esq|pmp|cpa)$/i;

/** "Guttormsen, Ajda" → "Ajda Guttormsen"; "Samoszuk, M.D." → "Samoszuk" */
function flipName(raw: string): string {
  const name = stripEmoji(raw).trim();
  if (!name.includes(",")) return name;
  const [last, ...rest] = name.split(",");
  const given = rest.join(" ").trim();
  if (!given || NAME_SUFFIX.test(given.replace(/[.\s]/g, ""))) {
    return last.trim();
  }
  return `${given} ${last.trim()}`.trim();
}

/** The human behind a row, in the order people say names out loud. */
function personName(item: EmailItem): string {
  return flipName(item.fromName || item.fromEmail).split("@")[0] || "Personal";
}

/**
 * The row's headline. The deep read's sentence usually names the sender
 * already ("Ajda Guttormsen from Abbott requested…"), so prefixing the
 * sender there would say it twice; prefix only when it doesn't.
 */
function headline(who: string, oneLine: string): string {
  const first = who.split(/\s+/)[0]?.toLowerCase();
  const opening = oneLine.slice(0, 60).toLowerCase();
  return first && first.length > 2 && opening.includes(first)
    ? oneLine
    : `${who} — ${oneLine}`;
}

const FREEMAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|aol|icloud|me|msn|proton|protonmail|comcast|sbcglobal|att|verizon)\./;

/** The company (or person, for personal mail) this email came from. */
function counterparty(item: EmailItem, ownDomain: string): string {
  const domain = item.fromEmail.split("@")[1]?.toLowerCase() ?? "";
  if (ownDomain && domain === ownDomain) return personName(item);
  const bare = domain.replace(/^(mail|email|e|smtp|notifications?|no-?reply|info|reply|bounce|em|mailer|send|go|links?)\./, "");
  if (!bare || FREEMAIL.test(`${bare}.`)) return personName(item);
  const label = bare.split(".")[0];
  return label.length <= 3
    ? label.toUpperCase()
    : label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * A machine, not a person: portals and notifiers that fire one message per
 * PO, alert, or approval step. A deep read can honestly call each of these
 * "a matter", but twenty myBuy purchase-order notices are ONE standing
 * relationship, not twenty matters — so promotions from these senders are
 * collapsed by company instead of each becoming its own board card.
 */
const AUTOMATED_SENDER =
  /(^|[._-])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer|automated|autonotify|mybuy|ariba|coupa|concur|workday|servicenow|zendesk|jira|confluence)([._-]|@|$)/i;
function isAutomatedSender(item: EmailItem): boolean {
  return (
    AUTOMATED_SENDER.test(item.fromEmail) ||
    AUTOMATED_SENDER.test(item.fromName ?? "")
  );
}

/**
 * The registrable company behind a sender, ignoring subdomains: both
 * no-reply@mybuy.roche.com and notifications@roche.com resolve to "Roche",
 * so one company's automated mail collapses into one place.
 */
function senderCompany(item: EmailItem, ownDomain: string): string {
  const domain = item.fromEmail.split("@")[1]?.toLowerCase() ?? "";
  const labels = domain.split(".").filter(Boolean);
  const root = labels.length >= 2 ? labels[labels.length - 2] : labels[0] ?? "";
  if (!root || FREEMAIL.test(`${root}.`)) return counterparty(item, ownDomain);
  return root.length <= 3
    ? root.toUpperCase()
    : root.charAt(0).toUpperCase() + root.slice(1);
}

/**
 * Fold several promoted reads from one automated system into a single
 * matter: one card titled for the sender, every notice a row inside it,
 * the newest actionable ask as the next move.
 */
function collapseAutomatedSeeds(
  seeds: { matter: Matter; item: EmailItem; understanding?: Understanding }[],
  ownDomain: string,
  at: string,
): Matter {
  const items = seeds.map((s) => s.item);
  const company = senderCompany(items[0], ownDomain);
  const nameCounts = new Map<string, number>();
  for (const it of items) {
    const n = stripEmoji(it.fromName || "").trim();
    if (n && n.length <= 40) nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
  }
  const display =
    [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || company;
  const owner = seeds.some((s) => s.understanding?.owner === "you")
    ? "you"
    : "them";
  const urgency = Math.max(1, ...seeds.map((s) => s.matter.urgency));
  const rows = seeds
    .map((s) => s.matter.emails?.[0])
    .filter((e): e is MatterEmail => Boolean(e))
    .sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? 1 : -1));
  const threadIds = [...new Set(seeds.flatMap((s) => s.matter.threadIds))];
  const emailIds = [...new Set(seeds.flatMap((s) => s.matter.emailIds))];
  const newest = [...seeds].sort((a, b) =>
    a.item.receivedAt < b.item.receivedAt ? 1 : -1,
  )[0];
  const ask = newest.understanding?.ask?.trim();
  return {
    id: `read:auto:${company.toLowerCase()}`,
    title: display,
    category: "read",
    orgUnit: seeds[0].matter.orgUnit,
    orgConfidence: 0.7,
    people: [],
    narrative: `${rows.length} automated ${
      rows.length === 1 ? "notice" : "notices"
    } from ${display}`,
    nextAction:
      ask && !/^nothing/i.test(ask) ? ask.slice(0, 80) : "none — review or clear",
    owner,
    urgency,
    status: owner === "them" ? "waiting" : "active",
    emails: rows.slice(0, 60),
    emailIds,
    threadIds,
    updatedAt: at,
  };
}

/**
 * The CRM record behind a matter, resolved by the codes its emails cite.
 * Amounts and stages come from Salesforce, never from the model.
 */
function crmFactsFor(
  emails: EmailItem[],
  idx: {
    opps: Map<string, { account?: string; stage?: string; amount?: number; closeDate?: string; code: string }>;
    studyIndex: Map<string, { account?: string; status?: string; name?: string; code: string }>;
    sitesByStudy: Map<string, string[]>;
  },
): Matter["crm"] {
  for (const e of emails) {
    const codes =
      `${e.subject}\n${e.snippet}\n${e.guide?.task ?? ""}`.match(CODE_PATTERN) ??
      [];
    for (const raw of codes) {
      const k = normalizeCode(raw);
      const opp = idx.opps.get(k);
      const study = idx.studyIndex.get(k);
      if (!opp && !study) continue;
      const investigators = idx.sitesByStudy.get(k);
      return {
        code: (opp?.code ?? study?.code ?? raw).toUpperCase(),
        account: opp?.account ?? study?.account,
        stage: opp?.stage,
        amount: opp?.amount,
        closeDate: opp?.closeDate,
        status: study?.status,
        ...(investigators?.length
          ? { investigators: [...new Set(investigators)].slice(0, 6) }
          : {}),
      };
    }
  }
  return undefined;
}

/**
 * The relationship a conversation belongs to: its study/opportunity
 * code when it cites one, else the counterparty. Conversations sharing
 * a key must be judged together — that is what lets the model see
 * "Abbott" as one program rather than six unrelated requests.
 */
function affinityKey(
  item: EmailItem,
  labels: Map<string, string>,
  ownDomain: string,
  u?: Understanding,
): string {
  const hay = `${item.subject}\n${item.snippet}\n${item.guide?.task ?? ""}\n${u?.oneLine ?? ""}`;
  const codes = hay.match(CODE_PATTERN);
  if (codes?.length) {
    // A KNOWN study/opportunity code is the strongest possible grouping key.
    for (const c of codes) {
      const known = labels.get(normalizeCode(c));
      if (known) return `code:${normalizeCode(c)}`;
    }
    // An UNKNOWN code — a raw PO number on a Roche myBuy notice, say — is
    // unique per message. Grouping by it fragments one vendor's mail into
    // dozens of singletons the model never sees together. Fall through to
    // the counterparty so the whole relationship is read as one.
  }
  return `party:${counterparty(item, ownDomain).toLowerCase()}`;
}

/**
 * Pack rows into chunks WITHOUT breaking an affinity group. Groups keep
 * the importance order of their strongest row, so the most consequential
 * relationships are still read first when the cap bites.
 */
function packByAffinity<T>(
  rows: T[],
  keyOf: (row: T) => string,
  chunkSize: number,
  maxChunks: number,
): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const chunks: T[][] = [];
  let current: T[] = [];
  for (const group of groups.values()) {
    // A group bigger than a chunk is its own run of chunks
    if (group.length >= chunkSize) {
      if (current.length) {
        chunks.push(current);
        current = [];
      }
      for (let i = 0; i < group.length; i += chunkSize) {
        chunks.push(group.slice(i, i + chunkSize));
      }
      continue;
    }
    if (current.length + group.length > chunkSize) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) chunks.push(current);
  return chunks.slice(0, maxChunks);
}

const TITLE_STOP = new Set([
  "the","a","an","and","or","of","for","to","re","fwd","on","in","with","from",
  "at","by","new","update","updates","follow","up","followup","email","emails",
  "thread","threads","inquiry","status","regarding","about","your","our",
]);

/**
 * A matter's identity, reduced to its meaningful words. Two chunks
 * naming the same work "Abbott sample requests" and "Sample requests
 * from Abbott" invent different ids; these tokens are what catch them.
 * Plurals are folded so "sample" and "samples" are the same word.
 */
function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !TITLE_STOP.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );
}

/**
 * Are two titles the same work? Equal word sets, or one contained in the
 * other ("Abbott sample requests" inside "Abbott K2EDTA sample request
 * 2026P-073"). Containment needs two words, so a bare counterparty name
 * cannot swallow every matter it appears in — and partial overlap is NOT
 * enough: "Roche anti-TPO SOW" and "Roche stability SOW" are two deals.
 */
function sameTitle(a: Set<string>, b: Set<string>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return false;
  for (const w of small) if (!big.has(w)) return false;
  return small.size === big.size || small.size >= 2;
}

/** Union-find, just enough of it to group matters that are one matter. */
function unionFind(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  return {
    find,
    union(a: number, b: number) {
      const [ra, rb] = [find(a), find(b)];
      if (ra !== rb) parent[rb] = ra;
    },
  };
}

type MergeableMatter = {
  id: string;
  title: string;
  urgency: number;
  people: MatterPerson[];
};

/**
 * ONE MATTER PER CONCERN, ONE CONVERSATION PER MATTER.
 *
 * Parallel model calls each invent their own ids, so the same work came
 * back as "abbott-pediatric-cft" from one call and "abbott-tbi-donors"
 * from another. Matters are therefore merged on IDENTITY — the same id,
 * the same meaningful title words, or a shared conversation (a thread
 * cannot be two matters) — and then each thread is awarded to exactly
 * one matter, the one that understands it most fully.
 */
export function mergeMatters<M extends MergeableMatter>(
  raw: { m: M; threads: string[] }[],
): (M & { threads: string[] })[] {
  const dsu = unionFind(raw.length);
  const seenId = new Map<string, number>();
  const seenThread = new Map<string, number>();
  raw.forEach((entry, n) => {
    const link = (map: Map<string, number>, key: string) => {
      const first = map.get(key);
      if (first === undefined) map.set(key, n);
      else dsu.union(first, n);
    };
    link(seenId, entry.m.id);
    for (const t of entry.threads) link(seenThread, t);
  });
  const tokens = raw.map((entry) => titleTokens(entry.m.title));
  for (let i = 0; i < raw.length; i += 1) {
    for (let j = i + 1; j < raw.length; j += 1) {
      if (sameTitle(tokens[i], tokens[j])) dsu.union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  raw.forEach((_, n) => {
    const root = dsu.find(n);
    groups.set(root, [...(groups.get(root) ?? []), n]);
  });

  const claimed = new Set<string>();
  return [...groups.values()]
    .map((members) => {
      const parts = members.map((n) => raw[n]);
      // The fullest account of the work leads; ties go to urgency
      const lead = [...parts].sort(
        (a, b) =>
          b.threads.length - a.threads.length || b.m.urgency - a.m.urgency,
      )[0];
      return {
        ...lead.m,
        urgency: Math.max(...parts.map((p) => p.m.urgency)),
        people: parts.reduce<MatterPerson[]>(
          (best, p) => (p.m.people.length > best.length ? p.m.people : best),
          [],
        ),
        threads: [...new Set(parts.flatMap((p) => p.threads))],
      };
    })
    .sort(
      (a, b) => b.threads.length - a.threads.length || b.urgency - a.urgency,
    )
    .map((m) => {
      const threads = m.threads.filter((t) => !claimed.has(t));
      for (const t of threads) claimed.add(t);
      return { ...m, threads };
    })
    .filter((m) => m.threads.length > 0);
}

/**
 * ONE BRAIN: the deep read decides an email's fate. A message is only
 * ever cleared into the digest when it has actually been READ and that
 * read says it is fyi/disposable — never on a snippet grade or a
 * sender-shape rule. Unread mail is "not triaged yet", so it stays a
 * matter candidate and remains visible rather than being guessed away.
 *
 * The protected floor is belt-and-suspenders over the read: anything the
 * user must act on, sign, or that a real person is waiting on is never
 * digestible, whatever the disposition field said.
 */
function protectedFromDigest(u: Understanding): boolean {
  if (u.owner === "you") return true;
  if (u.signature) return true;
  if (u.ask && !/^nothing/i.test(u.ask.trim())) return true;
  return false;
}

/**
 * The digest verdict for one message: "fyi" | "disposable" when the read
 * clears it, or null when it must stay in Atlas (unread, protected, or a
 * matter/record). Null is the safe default — silence keeps mail.
 */
function digestVerdict(
  u: Understanding | undefined,
): "fyi" | "disposable" | null {
  if (!u) return null; // not read = not triaged
  if (protectedFromDigest(u)) return null;
  if (u.disposition === "fyi") return "fyi";
  if (u.disposition === "disposable") return "disposable";
  return null; // matter or record — belongs in Atlas
}

/** What to do, straight from the read: the ask, or its absence. */
function askSuggestion(u: Understanding): string {
  if (u.signature) return `Sign: ${u.signature.document}`;
  if (/^nothing/i.test(u.ask)) return u.importance >= 1 ? "Worth knowing" : "Disposable";
  return u.owner === "you"
    ? u.ask.slice(0, 60)
    : u.owner === "them"
      ? "Waiting on them"
      : u.owner === "team"
        ? "Team owns it"
        : u.ask.slice(0, 60);
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
    `${personName(item)} — ${
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
  understanding: UnderstandingMap = {},
  /**
   * THE RELATIONSHIP FLOOR — senders with a real relationship (VIP, a
   * person you write to, a saved contact). Enforced in code, not in a
   * prompt: their mail can NEVER enter the bulk delete list, whatever the
   * read said. It stays visible in Triage's review bucket instead.
   */
  knownSenders: Set<string> = new Set(),
): Promise<Brief> {
  const prev = await loadBrief(accountEmail);
  const isKnown = (i: EmailItem) =>
    knownSenders.has(i.fromEmail.toLowerCase().trim());

  // The FYI / read-then-delete mass — summarized as a whole (the
  // digest), never worked one by one. THE DEEP READ DECIDES: an email is
  // only digested when it has been read and that read says fyi/disposable
  // and it is not protected. Everything else — including not-yet-read
  // mail — stays a matter candidate and remains visible. Headlines stay
  // as the per-line fallback for clients that predate the digest.
  const digestItems = items.filter(
    (i) => digestVerdict(understanding[i.id]) !== null && !isKnown(i),
  );
  const headlineItems = items.filter(
    (i) => digestVerdict(understanding[i.id]) === "fyi" && !isKnown(i),
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

  // Matters get everything else that's still in the inbox, ordered by
  // importance then recency.
  const digestIds = new Set(digestItems.map((i) => i.id));
  const allMatterCandidates = items
    .filter((i) => !digestIds.has(i.id))
    .sort(
      (a, b) =>
        (b.guide?.importance ?? 1) - (a.guide?.importance ?? 1) ||
        (a.receivedAt < b.receivedAt ? 1 : -1),
    );

  // CONVERSATIONS, NOT MESSAGES. Atlas used to work message by message,
  // so a six-reply thread became six near-identical rows — the
  // "duplicates". Everything below reasons in threads; message ids come
  // back only when an action has to sweep them.
  const threadMsgs = new Map<string, EmailItem[]>();
  for (const i of allMatterCandidates) {
    threadMsgs.set(i.threadId, [...(threadMsgs.get(i.threadId) ?? []), i]);
  }
  const threadRows = collapseThreads(allMatterCandidates);
  /** Any message id → its thread, so a cited inner id still resolves */
  const threadOfMessage = new Map(
    allMatterCandidates.map((i) => [i.id, i.threadId]),
  );
  const rowOfThread = new Map(threadRows.map((r) => [r.threadId, r]));
  const messageIdsOf = (threadId: string) =>
    (threadMsgs.get(threadId) ?? []).map((m) => m.id);
  /**
   * The deep read for a conversation: its newest READ message. The
   * newest message can be an unread reply, and a thread's meaning does
   * not change because its last line hasn't been read yet.
   */
  const readOf = (threadId: string): Understanding | undefined => {
    const msgs = [...(threadMsgs.get(threadId) ?? [])].sort((a, b) =>
      a.receivedAt < b.receivedAt ? 1 : -1,
    );
    for (const m of msgs) {
      const u = understanding[m.id];
      if (u) return u;
    }
    return undefined;
  };

  const functions = await loadFunctions(accountEmail);
  // Live studies/opportunities name the branches inside each function
  const salesforce: SalesforceRegistry = await loadSalesforce(
    accountEmail,
  ).catch(() => ({ studies: [], opportunities: [], sites: [] }));
  const labels = codeLabels(salesforce);
  const opps = opportunityIndex(salesforce);
  const studyIndex = new Map(
    salesforce.studies.map((st) => [normalizeCode(st.code), st]),
  );
  const sitesByStudy = new Map<string, string[]>();
  for (const site of salesforce.sites ?? []) {
    if (!site.studyCode || !site.investigator) continue;
    const k = normalizeCode(site.studyCode);
    sitesByStudy.set(k, [...(sitesByStudy.get(k) ?? []), site.investigator]);
  }
  const ownDomain = accountEmail.split("@")[1]?.toLowerCase() ?? "";
  // The user's own org corrections — absolute ground truth
  const fixes: MatterFixes = await loadMatterFixes(accountEmail).catch(
    () => ({}),
  );
  // Titles the user chose and matters they created — never overwritten
  const edits = await loadMatterEdits(accountEmail).catch(() => ({
    renames: {} as Record<string, { title: string; at: string }>,
    manual: [],
  }));
  // Closure records — a finished concern must not resurrect on rebuild
  const closed = await loadClosedMatters(accountEmail).catch(
    (): ClosedMatters => ({}),
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

  // AFFINITY CHUNKING. One 500-email call times out, so the corpus is
  // split across parallel calls — but splitting it by importance sent a
  // company's six conversations to six different calls, none of which
  // saw enough to recognize the matter, so all of them fell through to
  // filing. Group by relationship first: every conversation with the
  // same counterparty or study code goes to the SAME call.
  // 100 conversations per call, each carrying a deep read, routinely blew
  // the 150s budget — and every chunk failing silently produced a brief
  // with ZERO matters and 391 filed rows. Smaller calls finish.
  const CHUNK = 45;
  const MAX_CHUNKS = 16;
  /** Parallel model calls — enough to be quick, few enough to not trip limits */
  const CLUSTER_CONCURRENCY = 4;
  const chunks = packByAffinity(
    threadRows,
    (r) => affinityKey(r, labels, ownDomain, readOf(r.threadId)),
    CHUNK,
    MAX_CHUNKS,
  );
  const matterCandidates = chunks.flat();
  {
    const sizes = new Map<string, number>();
    for (const r of threadRows) {
      const k = affinityKey(r, labels, ownDomain, readOf(r.threadId));
      sizes.set(k, (sizes.get(k) ?? 0) + 1);
    }
    const top = [...sizes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, n]) => `${k}×${n}`)
      .join(" ");
    console.log(
      `[seer] matters: ${allMatterCandidates.length} messages in ${threadRows.length} conversations, ${chunks.length} chunks; biggest relationships: ${top}`,
    );
  }

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
    // Live CRM truth: what is actually running, and what it is worth
    activeStudies: salesforce.studies.slice(0, 80).map((x) =>
      [x.code, x.name, x.account, x.status].filter(Boolean).join(" · "),
    ),
    openOpportunities: salesforce.opportunities.slice(0, 80).map((x) =>
      [
        x.code,
        x.name,
        x.account,
        x.stage,
        x.amount ? `$${Math.round(x.amount).toLocaleString()}` : "",
        x.closeDate ? `closes ${x.closeDate}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    knownInvestigators: (salesforce.sites ?? [])
      .slice(0, 80)
      .map((s) =>
        [s.investigator, s.name, s.city, s.studyCode]
          .filter(Boolean)
          .join(" · "),
      ),
    inbox: batch.map((i) => {
      const study = `${i.subject}\n${i.snippet}`.match(STUDY_CODE)?.[0];
      const d = i.guide?.debug;
      const u = readOf(i.threadId);
      const msgs = threadMsgs.get(i.threadId)?.length ?? 1;
      return {
        id: i.id,
        from: stripEmoji(i.fromName || i.fromEmail),
        email: i.fromEmail,
        subject: stripEmoji(i.subject),
        // This entry is a conversation: how many replies, and who spoke
        ...(msgs > 1 ? { messages: msgs } : {}),
        ...(i.threadSenders?.length ? { voices: i.threadSenders } : {}),
        // The deep read, when we have it: what this email actually means
        ...(u
          ? {
              kind: u.kind,
              means: u.oneLine,
              ask: u.ask,
              owner: u.owner,
              ...(u.deadline ? { deadline: u.deadline } : {}),
              ...(u.amounts?.length ? { amounts: u.amounts } : {}),
              ...(u.entities.length ? { entities: u.entities } : {}),
              ...(u.signature ? { awaitsSignature: u.signature.document } : {}),
              suggestedOrg: u.org.unit,
              importance: u.importance,
            }
          : {
              gist: stripEmoji(i.guide?.task ?? i.snippet.slice(0, 160)),
              importance: i.guide?.importance,
            }),
        action: i.guide?.action,
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
  // Chunk failures must never masquerade as "no matters" — count them so
  // a total wipeout can be detected and the previous brief preserved.
  let clusterFailures = 0;
  let clusterError: string | undefined;
  const fallback = getFallbackModel();
  const callModel = (m: LanguageModel | string, batch: EmailItem[]) =>
    generateText({
      model: m,
      temperature: 0,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(150_000),
      output: Output.object({ schema: matterSchema }),
      system: profileBlock ? `${SYSTEM}\n\n${profileBlock}` : SYSTEM,
      prompt: JSON.stringify(payloadFor(batch)),
    });
  const runChunk = async (batch: EmailItem[], n: number) => {
    try {
      const r = await callModel(model, batch);
      return r.output;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // The direct key is out of quota or credits — try the gateway's
      // separate billing pool before giving up on this chunk.
      if (fallback && isModelBudgetError(msg)) {
        try {
          const r = await callModel(fallback.model, batch);
          return r.output;
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          clusterFailures += 1;
          clusterError ??= cleanModelError(m2);
          console.error(
            `[seer] matter chunk ${n + 1}/${chunks.length} failed (direct+gateway):`,
            m2,
          );
          return { summary: "", matters: [] };
        }
      }
      clusterFailures += 1;
      clusterError ??= cleanModelError(msg);
      console.error(
        `[seer] matter chunk ${n + 1}/${chunks.length} failed:`,
        msg,
      );
      return { summary: "", matters: [] };
    }
  };
  /** Bounded parallelism — 16 simultaneous calls is how you get rate-limited. */
  const runAllChunks = async () => {
    const out: Awaited<ReturnType<typeof runChunk>>[] = new Array(chunks.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const n = cursor++;
        if (n >= chunks.length) return;
        out[n] = await runChunk(chunks[n], n);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(CLUSTER_CONCURRENCY, chunks.length) },
        worker,
      ),
    );
    return out;
  };

  // THE DIGEST, CHUNKED. One call carrying 300+ ids never came back inside
  // the timeout, and the catch below then published the whole disposable
  // inbox as a single "Inbox updates" theme — 62% of the mail described by
  // a sentence that says nothing. Small calls finish, and a chunk that
  // fails only costs its own 60 messages.
  type DigestTheme = { theme: string; line: string; emailIds: string[] };
  const DIGEST_CHUNK = 60;
  const DIGEST_CONCURRENCY = 3;
  const digestChunks: EmailItem[][] = [];
  for (let i = 0; i < digestItems.length; i += DIGEST_CHUNK) {
    digestChunks.push(digestItems.slice(i, i + DIGEST_CHUNK));
  }
  const callDigest = (m: LanguageModel | string, batch: EmailItem[]) =>
    generateText({
      model: m,
      temperature: 0,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(90_000),
      output: Output.object({ schema: digestSchema }),
      system: DIGEST_SYSTEM,
      prompt: JSON.stringify(
        batch.map((i) => ({
          id: i.id,
          from: stripEmoji(i.fromName || i.fromEmail),
          subject: stripEmoji(i.subject),
          gist: stripEmoji(
            understanding[i.id]?.oneLine ||
              i.guide?.task ||
              i.snippet.slice(0, 120),
          ),
        })),
      ),
    });
  /**
   * A failed chunk still has to name its mail. Grouping by sender beats
   * "Inbox updates": the user can see it is 40 Slack notifications and
   * delete them without opening one.
   */
  const themesBySender = (batch: EmailItem[]): DigestTheme[] => {
    const groups = new Map<string, EmailItem[]>();
    for (const i of batch) {
      const key =
        stripEmoji(i.fromName).trim() ||
        i.fromEmail.split("@")[1] ||
        "Other senders";
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    return [...groups.entries()].map(([theme, rows]) => ({
      theme,
      line: `${rows.length} message${rows.length === 1 ? "" : "s"} from ${theme} — none of them ask you for anything.`,
      emailIds: rows.map((r) => r.id),
    }));
  };
  const runDigestChunk = async (batch: EmailItem[], n: number) => {
    try {
      return (await callDigest(model, batch)).output;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (fallback && isModelBudgetError(msg)) {
        try {
          return (await callDigest(fallback.model, batch)).output;
        } catch {
          /* fall through to sender grouping */
        }
      }
      console.error(
        `[seer] digest chunk ${n + 1}/${digestChunks.length} failed:`,
        msg,
      );
      return { summary: "", themes: themesBySender(batch) };
    }
  };
  const runDigest = async () => {
    const out: { summary: string; themes: DigestTheme[] }[] = new Array(
      digestChunks.length,
    );
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const n = cursor++;
        if (n >= digestChunks.length) return;
        out[n] = await runDigestChunk(digestChunks[n], n);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(DIGEST_CONCURRENCY, digestChunks.length) },
        worker,
      ),
    );
    // Chunks name categories independently; the same category from two
    // calls is one category on screen.
    const byName = new Map<string, DigestTheme>();
    for (const theme of out.flatMap((o) => o.themes)) {
      const name = theme.theme.trim();
      if (!name) continue;
      const existing = byName.get(name.toLowerCase());
      if (existing) existing.emailIds.push(...theme.emailIds);
      else
        byName.set(name.toLowerCase(), {
          theme: name,
          line: theme.line,
          emailIds: [...theme.emailIds],
        });
    }
    return {
      summary: out.map((o) => o.summary).find(Boolean) ?? "",
      themes: [...byName.values()].sort(
        (a, b) => b.emailIds.length - a.emailIds.length,
      ),
    };
  };

  const [chunkOutputs, digestOutput] = await Promise.all([
    runAllChunks(),
    runDigest(),
  ]);

  // Every chunk's matters, with their cited ids resolved to conversations
  const merged = mergeMatters(
    chunkOutputs.flatMap((out) =>
      out.matters
        .map((m) => ({
          m,
          threads: [
            ...new Set(
              m.emailIds
                .map((id) => threadOfMessage.get(id))
                .filter((t): t is string => Boolean(t)),
            ),
          ],
        }))
        .filter((entry) => entry.threads.length > 0),
    ),
  );

  const output = {
    summary: chunkOutputs.map((o) => o.summary).find(Boolean) ?? "",
    matters: merged,
  };

  const matters: Matter[] = merged
    .map((m) => {
      const rows = m.threads
        .map((t) => rowOfThread.get(t))
        .filter((r): r is (typeof threadRows)[number] => Boolean(r));
      return {
        ...m,
        // User corrections are ground truth even if the model ignored them
        orgUnit: fixes[m.id]?.orgUnit ?? m.orgUnit,
        orgConfidence: fixes[m.id] ? 1 : m.orgConfidence,
        subUnit: rows[0] ? subUnitFor(rows[0], labels, ownDomain) : undefined,
        crm: crmFactsFor(rows, { opps, studyIndex, sitesByStudy }),
        emails: rows.map((i) => {
          const u = readOf(i.threadId);
          const count = threadMsgs.get(i.threadId)?.length ?? 1;
          const who = personName(i);
          return {
            id: i.id,
            threadId: i.threadId,
            from: who,
            fromEmail: i.fromEmail,
            subject: stripEmoji(i.subject),
            line: u
              ? headline(who, stripEmoji(u.oneLine)).slice(0, 140)
              : lineFor(i),
            suggestion: u ? askSuggestion(u) : suggestionFor(i),
            at: i.receivedAt,
            ...(count > 1 ? { count } : {}),
          };
        }),
        // Acting on a matter must sweep every message in its threads
        emailIds: m.threads.flatMap(messageIdsOf),
        threadIds: m.threads,
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((m) => m.emailIds.length > 0)
    .sort(
      (a, b) =>
        b.urgency - a.urgency ||
        (b.crm?.amount ?? 0) - (a.crm?.amount ?? 0),
    );

  // TOTAL CLUSTERING FAILURE — every chunk errored, so this brief has no
  // matters for a reason that has nothing to do with the inbox. Publishing
  // it would wipe Atlas to "0 matters · 391 filed". Carry the last good
  // matters forward instead, re-pointed at the mail that's still here.
  const totalFailure = chunks.length > 0 && clusterFailures === chunks.length;
  const carried: Matter[] =
    totalFailure && (prev?.matters?.length ?? 0) > 0
      ? (prev?.matters ?? [])
          .map((m) => {
            const threadIds = (m.threadIds ?? []).filter((t) =>
              threadMsgs.has(t),
            );
            return {
              ...m,
              threadIds,
              emailIds: threadIds.flatMap(messageIdsOf),
            };
          })
          .filter((m) => m.emailIds.length > 0)
      : [];
  if (totalFailure) {
    console.error(
      `[seer] all ${chunks.length} matter chunks failed — ${
        carried.length ? `carrying ${carried.length} previous matters` : "no previous matters to carry"
      }`,
    );
  }
  const baseMatters = carried.length > 0 ? carried : matters;

  // ---- LIFECYCLE (event-driven, never a timer) ----------------------
  // A closed CRM stage PROPOSES closure (status only — never auto-acts).
  // A durable closure record SUPPRESSES a resurrected matter, unless new
  // mail arrived after it was closed — then it reopens explicitly.
  const CLOSED_STAGE = /closed won|closed lost|\bwon\b|\blost\b/i;
  const newestMailOf = (threadIds: string[]): string => {
    let newest = "";
    for (const t of threadIds)
      for (const msg of threadMsgs.get(t) ?? []) {
        if (msg.receivedAt > newest) newest = msg.receivedAt;
      }
    return newest;
  };
  let closedDirty = false;
  const livingMatters: Matter[] = [];
  for (const m of baseMatters) {
    let status = m.status;
    let statusWhy = m.statusWhy;
    if (m.crm?.stage && CLOSED_STAGE.test(m.crm.stage)) {
      status = "looks-closed";
      statusWhy = statusWhy ?? `CRM stage: ${m.crm.stage}`;
    } else if (!status) {
      status = m.owner === "them" ? "waiting" : "active";
    }
    const closure = Object.values(closed).find((c) =>
      matchesClosure({ id: m.id, title: m.title, threadIds: m.threadIds }, c),
    );
    if (closure) {
      const newest = newestMailOf(m.threadIds);
      if (newest && newest > closure.closedAt) {
        delete closed[closure.matterId];
        closedDirty = true;
        livingMatters.push({
          ...m,
          status: "reopened",
          statusWhy: `New mail after you closed this (${closure.reason})`,
        });
      }
      // else: closed and quiet — suppress; its threads fall through to filed
      continue;
    }
    livingMatters.push({ ...m, status, statusWhy });
  }

  // TOTAL COVERAGE — the model returns only meaningful matters. Every
  // remaining graded email is filed into the org tree locally, avoiding
  // an enormous structured response that times out on large inboxes.
  // Filed rows are CONVERSATIONS. Filing message by message is what put
  // the same Abbott request on screen four times.
  //
  // A READ THAT SAYS "MATTER" IS A MATTER. Triage used to park these as
  // "possible matters" waiting for a click — the app asking the user to
  // do the one job it exists to do. If the deep read named the work, it
  // goes on the board itself. What stays behind in Triage is only what
  // should be deleted or closed.
  const inMatters = new Set(livingMatters.flatMap((m) => m.threadIds));
  const filed: FiledEmail[] = [];
  const promoted: Matter[] = [];
  // Promotions from an automated system, held back so one company's many
  // notices become a single matter rather than one card per message.
  type AutoSeed = {
    matter: Matter;
    item: EmailItem;
    understanding?: Understanding;
  };
  const autoSeeds = new Map<string, AutoSeed[]>();
  const promotedAt = new Date().toISOString();
  for (const i of threadRows) {
    if (inMatters.has(i.threadId)) continue;
    const u = readOf(i.threadId);
    const ids = messageIdsOf(i.threadId);
    const who = personName(i);
    const baseFiled: FiledEmail = {
      emailId: i.id,
      threadId: i.threadId,
      orgUnit: orgUnitFor(i, functions, u).unit,
      subUnit: subUnitFor(i, labels, ownDomain),
      fromName: personName(i),
      fromEmail: i.fromEmail,
      subject: stripEmoji(i.subject),
      ...(u?.disposition ? { disposition: u.disposition } : {}),
      ...(isKnown(i) ? { known: true } : {}),
      line: u
        ? headline(who, stripEmoji(u.oneLine)).slice(0, 140)
        : lineFor(i),
      suggestion: u ? askSuggestion(u) : suggestionFor(i),
      at: i.receivedAt,
      ...(ids.length > 1 ? { count: ids.length, messageIds: ids } : {}),
    };
    const candidate = matterCandidateFor(baseFiled, u);
    const matterId = `read:${i.threadId}`;
    const closure = candidate
      ? Object.values(closed).find((c) =>
          matchesClosure(
            { id: matterId, title: candidate.title, threadIds: [i.threadId] },
            c,
          ),
        )
      : undefined;
    // Closed and quiet stays closed; new mail after the closure reopens it.
    const suppressed = Boolean(
      closure && !(newestMailOf([i.threadId]) > closure.closedAt),
    );
    if (candidate && !suppressed) {
      if (closure) {
        delete closed[closure.matterId];
        closedDirty = true;
      }
      const seed = matterFromRead({
        matterId,
        candidate: {
          ...candidate,
          title: edits.renames[matterId]?.title ?? candidate.title,
          emailIds: ids,
        },
        row: {
          emailId: i.id,
          threadId: i.threadId,
          from: who,
          fromEmail: i.fromEmail,
          subject: stripEmoji(i.subject),
          line: baseFiled.line,
          suggestion: baseFiled.suggestion,
          subUnit: baseFiled.subUnit,
          at: i.receivedAt,
          count: ids.length,
        },
        understanding: u,
        ...(closure
          ? {
              reopenedBecause: `New mail after you closed this (${closure.reason})`,
            }
          : {}),
        at: promotedAt,
      });
      // A human's promoted read stands alone. An automated sender's is held
      // for collapse — but never when the user already renamed this exact
      // thread's matter, since that is a deliberate one-off.
      if (isAutomatedSender(i) && !edits.renames[matterId]) {
        const key = senderCompany(i, ownDomain).toLowerCase();
        autoSeeds.set(key, [
          ...(autoSeeds.get(key) ?? []),
          { matter: seed, item: i, understanding: u },
        ]);
      } else {
        promoted.push(seed);
      }
      continue;
    }
    filed.push(baseFiled);
  }

  // Collapse each automated sender's promotions into one matter. A lone
  // notice from a system stays a normal matter; several become "Roche myBuy
  // — 14 purchase orders" with every thread inside it.
  for (const [, seeds] of autoSeeds) {
    if (seeds.length === 1) {
      promoted.push(seeds[0].matter);
      continue;
    }
    promoted.push(collapseAutomatedSeeds(seeds, ownDomain, promotedAt));
  }

  if (closedDirty) {
    await saveClosedMatters(accountEmail, closed).catch(() => {});
  }
  const unsure: UnsureItem[] = [];

  // ---- THE SIGNATURE QUEUE ----------------------------------------
  // Documents waiting on this person's pen, gathered from the reads. Not
  // a keyword hunt and not model-clustered: if the read says a document
  // awaits their signature, it belongs here, above everything else.
  // One row per document, so a signature thread with three reminders is
  // one line on the queue.
  const signatureItems = threadRows.filter((i) =>
    (threadMsgs.get(i.threadId) ?? []).some((m) => understanding[m.id]?.signature),
  );
  const signatureOf = (threadId: string) => {
    const msgs = [...(threadMsgs.get(threadId) ?? [])].sort((a, b) =>
      a.receivedAt < b.receivedAt ? 1 : -1,
    );
    for (const m of msgs) {
      const sig = understanding[m.id]?.signature;
      if (sig) return sig;
    }
    return undefined;
  };
  const signatureThreads = new Set(signatureItems.map((i) => i.threadId));
  const pinned: Matter[] = [];
  if (signatureItems.length > 0) {
    const now = new Date().toISOString();
    pinned.push({
      id: "signature-queue",
      title:
        edits.renames["signature-queue"]?.title ?? "Things you need to sign",
      goal: "Every document waiting on your signature is executed",
      category: "signatures",
      orgUnit: "signatures",
      orgConfidence: 1,
      people: [],
      narrative: `${signatureItems.length} document${signatureItems.length === 1 ? "" : "s"} waiting on your signature`,
      nextAction:
        signatureItems.length === 1
          ? `Sign ${signatureOf(signatureItems[0].threadId)!.document}`
          : `Sign ${signatureItems.length} documents`,
      owner: "you",
      urgency: 3,
      emails: signatureItems.map((i) => {
        const sig = signatureOf(i.threadId)!;
        return {
          id: i.id,
          threadId: i.threadId,
          from: personName(i),
          fromEmail: i.fromEmail,
          subject: stripEmoji(i.subject),
          line: [
            sig.document,
            sig.counterparty ? `for ${sig.counterparty}` : "",
            sig.platform ? `(${sig.platform})` : "",
          ]
            .filter(Boolean)
            .join(" "),
          suggestion: "Sign it",
          ...(() => {
            const n = threadMsgs.get(i.threadId)?.length ?? 1;
            return n > 1 ? { count: n } : {};
          })(),
        };
      }),
      emailIds: signatureItems.flatMap((i) => messageIdsOf(i.threadId)),
      threadIds: [...signatureThreads],
      updatedAt: now,
    });
  }

  const digestIdSet = new Set(digestItems.map((i) => i.id));
  const digestById = new Map(digestItems.map((i) => [i.id, i]));
  const digest: Digest = {
    summary: digestOutput.summary,
    themes: digestOutput.themes
      .map((t) => {
        const emailIds = t.emailIds.filter((id) => digestIdSet.has(id));
        return {
          ...t,
          emailIds,
          items: emailIds
            .map((id) => {
              const item = digestById.get(id);
              if (!item) return null;
              const u = understanding[id];
              return {
                id,
                threadId: item.threadId,
                fromName: stripEmoji(item.fromName || item.fromEmail),
                fromEmail: item.fromEmail,
                subject: stripEmoji(item.subject),
                orgUnit: orgUnitFor(item, functions, u).unit,
                disposition: String(u?.disposition ?? "disposable"),
                line: stripEmoji(
                  u?.oneLine ||
                    item.guide?.task ||
                    item.subject,
                ).slice(0, 180),
                at: item.receivedAt,
              };
            })
            .filter(
              (
                item,
              ): item is {
                id: string;
                threadId: string;
                fromName: string;
                fromEmail: string;
                subject: string;
                orgUnit: string;
                disposition: string;
                line: string;
                at: string;
              } => Boolean(item),
            ),
        };
      })
      .filter((t) => t.emailIds.length > 0),
  };

  // The user's matters survive every rebuild, and their titles win. A
  // matter built from selected rows owns those whole conversations.
  const manualMatters: Matter[] = edits.manual.map((mm) => {
    const threads = [
      ...new Set(
        mm.emailIds
          .map((id) => threadOfMessage.get(id))
          .filter((t): t is string => Boolean(t)),
      ),
    ];
    const rows = threads
      .map((t) => rowOfThread.get(t))
      .filter((r): r is (typeof threadRows)[number] => Boolean(r));
    return {
      id: mm.id,
      title: mm.title,
      category: "mine",
      orgUnit: mm.orgUnit ?? functions[0] ?? "unsorted",
      orgConfidence: 1,
      people: [],
      goal: mm.goal,
      narrative:
        rows.length > 0
          ? `${rows.length} conversation${rows.length === 1 ? "" : "s"} you grouped yourself`
          : "yours — nothing from the inbox in it right now",
      nextAction: mm.nextAction ?? "none — yours to define",
      owner: "you",
      urgency: 2,
      subUnit: rows[0] ? subUnitFor(rows[0], labels, ownDomain) : undefined,
      emails: rows.map((i) => {
        const u = readOf(i.threadId);
        const n = threadMsgs.get(i.threadId)?.length ?? 1;
        const who = personName(i);
        return {
          id: i.id,
          threadId: i.threadId,
          from: who,
          fromEmail: i.fromEmail,
          subject: stripEmoji(i.subject),
          line: u
            ? headline(who, stripEmoji(u.oneLine)).slice(0, 140)
            : lineFor(i),
          suggestion: u ? askSuggestion(u) : suggestionFor(i),
          ...(n > 1 ? { count: n } : {}),
        };
      }),
      emailIds: threads.flatMap(messageIdsOf),
      threadIds: threads,
      updatedAt: mm.updatedAt,
    };
  });
  const manualThreads = new Set(manualMatters.flatMap((m) => m.threadIds));

  // Conversations claimed by the signature queue or by a matter the user
  // built themselves are removed everywhere else — one row, one home.
  const spokenFor = (threadId: string) =>
    signatureThreads.has(threadId) || manualThreads.has(threadId);
  const cleanedMatters = [
    ...manualMatters,
    ...[...livingMatters, ...promoted].map((m) => {
      const threadIds = m.threadIds.filter((t) => !spokenFor(t));
      return {
        ...m,
        // The user's title is ground truth
        title: edits.renames[m.id]?.title ?? m.title,
        threadIds,
        emailIds: threadIds.flatMap(messageIdsOf),
        emails: m.emails?.filter((e) => !spokenFor(e.threadId)),
      };
    }),
  ].filter((m) => m.emailIds.length > 0 || m.category === "mine");
  const cleanedFiled = filed.filter((f) => !spokenFor(f.threadId));

  // THE FORECAST: bucket every matter by "what matters when".
  const forecast: Forecast = { now: [], next: [], waiting: [], atRisk: [], quiet: [] };
  const bucketOf = (m: Matter): keyof Forecast => {
    if (m.status === "looks-closed") return "atRisk";
    if (m.status === "dormant") return "quiet";
    if (m.owner === "them" || m.status === "waiting") return "waiting";
    const hasNext = Boolean(m.nextAction && !/^none/i.test(m.nextAction));
    if (m.owner === "you" && (m.urgency >= 3 || hasNext)) return "now";
    return "next";
  };
  // Signature queue always leads "now"; then the rest of the matters.
  for (const m of [...pinned, ...cleanedMatters]) {
    forecast[bucketOf(m)].push(m.id);
  }

  // ONE ROW, ONE HOME. The digest is decided per MESSAGE, so a conversation
  // carrying live work plus one FYI reply was landing in a matter AND in
  // Triage's delete list. A thread that has a home in Atlas is not in Triage,
  // whatever its individual messages say.
  const homedThreads = new Set(
    [...pinned, ...cleanedMatters].flatMap((m) => m.threadIds),
  );
  const homed = (threadId?: string) =>
    Boolean(threadId && homedThreads.has(threadId));
  const visibleDigestItems = digestItems.filter((i) => !homed(i.threadId));
  const visibleDigest = digestWithoutHomedThreads(
    digest,
    homedThreads,
    threadOfMessage,
  );
  const visibleHeadlines = headlines.filter((h) => !homed(h.threadId));

  const accounting = buildInboxAccounting({
    asOf: new Date().toISOString(),
    providerTotal: providerTotal?.messages ?? items.length,
    functions,
    matters: cleanedMatters,
    pinned,
    filed: cleanedFiled,
    digestIds: visibleDigestItems.map((item) => item.id),
  });

  const brief: Brief = {
    builtAt: new Date().toISOString(),
    engine: BRIEF_ENGINE,
    summary: output.summary,
    matters: cleanedMatters,
    pinned,
    forecast,
    accounting,
    headlines: visibleHeadlines,
    // Clear-all now covers the whole digest (fyi + read-and-delete)
    headlineIds: visibleDigestItems.map((i) => ({
      id: i.id,
      threadId: i.threadId,
    })),
    functions,
    totalInbox: items.length,
    totalThreads: new Set(items.map((i) => i.threadId)).size,
    ...(providerTotal ? { providerTotal } : {}),
    // Messages the AI actually judged — the conversations it read, in
    // message terms, so coverage reconciles with the provider's count
    readByAi: matterCandidates.reduce(
      (n, r) => n + (threadMsgs.get(r.threadId)?.length ?? 1),
      0,
    ),
    filed: cleanedFiled,
    digest: visibleDigest,
    unsure,
    unread: items.filter((i) => !understanding[i.id]).length,
    ...(clusterFailures > 0 ? { clusterFailures } : {}),
    ...(clusterError ? { clusterError } : {}),
  };
  await kvSet(keyFor(accountEmail), brief);
  return brief;
}
