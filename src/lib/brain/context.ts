import {
  contextSignals,
  meetingLabel,
  type PersonalContext,
} from "@/lib/inbox/personal-context";
import {
  historySignals,
  type MailHistory,
} from "@/lib/inbox/mail-history";
import {
  CODE_PATTERN,
  codeLabels,
  formatAmount,
  normalizeCode,
  opportunityIndex,
  type SalesforceRegistry,
} from "@/lib/crm/registry";
import type { ActionMemory } from "@/lib/store/action-memory";
import type { PeopleDb } from "@/lib/store/people";
import { latestSignalFor, type WorkSignal } from "@/lib/brain/signals";

/**
 * THE CONTEXT COMPILER — the center of the Seer brain.
 *
 * Before the model reads an email, this assembles the SMALLEST complete
 * packet of relevant, sourced evidence about the sender, the moment, and
 * the work it belongs to — "Sandy is a board member, you just had a board
 * meeting, this continues the operating-plan matter" — rather than one
 * enormous dump of everything known.
 *
 * Every line is labeled with its authority so the model can trust facts
 * over guesses:
 *   [explicit] the user said so           (strongest)
 *   [system]   an authoritative record    (CRM)
 *   [calendar] / [observed] a measured fact
 *   [inference] a scored guess            (weakest)
 *
 * Absence is evidence too: a sender with no relationship, no CRM record,
 * no calendar history and no behavior is genuinely peripheral — the
 * packet says so instead of hedging.
 */

export type Provenance =
  | "explicit"
  | "system"
  | "calendar"
  | "observed"
  | "inference";

/** A previous matter, reduced to what the compiler needs to match on. */
export type PriorMatter = {
  id: string;
  title: string;
  narrative?: string;
  people?: { email?: string }[];
};

export type BrainSources = {
  accountEmail: string;
  ownDomain: string;
  history?: MailHistory | null;
  personal?: PersonalContext | null;
  people?: PeopleDb | null;
  salesforce?: SalesforceRegistry | null;
  actionMemory?: ActionMemory | null;
  priorMatters?: PriorMatter[];
  /**
   * Recent work signals (Timeglass, Drive, notes) — what the user has
   * actually been doing. Empty until a connector is added; when present,
   * they prove a matter is alive even when its mail has gone silent.
   */
  workSignals?: WorkSignal[];
};

export type CompiledContext = { text: string; refs: string[] };

/** How much context rides along with each read — small on purpose. */
const PACKET_MAX_CHARS = 1000;

const FREEMAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|aol|icloud|me|msn|proton|protonmail|comcast|sbcglobal|att|verizon)\./;

/** The company (or person, for freemail) an address belongs to. */
function counterpartyLabel(email: string, ownDomain: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || (ownDomain && domain === ownDomain)) {
    return email.split("@")[0] ?? "";
  }
  const bare = domain.replace(
    /^(mail|email|e|smtp|notifications?|no-?reply|info|reply|bounce|em|mailer|send|go|links?)\./,
    "",
  );
  if (!bare || FREEMAIL.test(`${bare}.`)) return email.split("@")[0] ?? "";
  return bare.split(".")[0] ?? "";
}

/** Lowercase word set for loose token matching in titles/narratives. */
function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * The prior matter this email most likely continues, if any. Matches on
 * a shared study/opportunity code (strongest), the sender being a named
 * participant, or the counterparty appearing in the title.
 */
function bestPriorMatter(
  email: string,
  hay: string,
  counterparty: string,
  priorMatters: PriorMatter[],
): { matter: PriorMatter; score: number } | null {
  const codes = new Set(
    (hay.match(CODE_PATTERN) ?? []).map((c) => normalizeCode(c)),
  );
  const cp = counterparty.toLowerCase();
  let best: { matter: PriorMatter; score: number } | null = null;
  for (const m of priorMatters) {
    let score = 0;
    const titleWords = words(`${m.title} ${m.narrative ?? ""}`);
    if (codes.size) {
      const matterCodes = new Set(
        (`${m.title} ${m.narrative ?? ""}`.match(CODE_PATTERN) ?? []).map((c) =>
          normalizeCode(c),
        ),
      );
      for (const c of codes) if (matterCodes.has(c)) score += 3;
    }
    if (m.people?.some((p) => p.email?.toLowerCase() === email)) score += 2;
    if (cp.length > 2 && titleWords.has(cp)) score += 2;
    if (!best || score > best.score) best = { matter: m, score };
  }
  return best && best.score >= 2 ? best : null;
}

/** The CRM facts behind any code in the email — authoritative, never guessed. */
function crmLine(
  hay: string,
  salesforce: SalesforceRegistry,
): { text: string; ref: string } | null {
  const opps = opportunityIndex(salesforce);
  const labels = codeLabels(salesforce);
  const codes = hay.match(CODE_PATTERN) ?? [];
  for (const raw of codes) {
    const k = normalizeCode(raw);
    const opp = opps.get(k);
    if (opp) {
      const bits = [
        opp.code.toUpperCase(),
        opp.account,
        opp.stage,
        opp.amount ? formatAmount(opp.amount) : "",
        opp.closeDate ? `closes ${opp.closeDate}` : "",
      ].filter(Boolean);
      return { text: bits.join(" — "), ref: `crm:${k}` };
    }
    const label = labels.get(k);
    if (label) return { text: label, ref: `crm:${k}` };
  }
  return null;
}

/**
 * Compile the context packet for one email. Cheap and pure — safe to run
 * for every message in a read batch.
 */
export function compileEmailContext(
  input: { fromEmail: string; fromName?: string; subject: string; snippet: string },
  sources: BrainSources,
): CompiledContext {
  const email = input.fromEmail.toLowerCase().trim();
  const hay = `${input.subject}\n${input.snippet}`;
  const counterparty = counterpartyLabel(email, sources.ownDomain);
  const lines: string[] = [];
  const refs: string[] = [];

  // SENDER — who this is, from the personal database and mail graph
  const person = sources.people?.[email];
  const sig = historySignals(sources.history, email);
  const ctx = contextSignals(sources.personal, email);
  const senderBits: string[] = [];
  if (person?.vip) senderBits.push("VIP — you pinned them [explicit]");
  else if (person?.tier && person.tier !== "machine") {
    senderBits.push(`${person.tier} [${person.by === "ai" ? "inference" : "observed"}]`);
  }
  if (sig.relationship === "engaged") {
    senderBits.push(`you email them (sent ${sig.sentTo}) [observed]`);
  } else if (sig.relationship === "known") {
    senderBits.push(`writes to you (${sig.receivedFrom}), you rarely reply [observed]`);
  } else if (sig.relationship === "bulk") {
    senderBits.push("bulk/no-reply shape [observed]");
  }
  if (sig.staleEngagement) senderBits.push("but not in ~30d+ [observed]");
  if (sig.medianReplyMins != null && sig.medianReplyMins < 120) {
    senderBits.push(`you reply fast (~${sig.medianReplyMins}m) [observed]`);
  }
  if (ctx.inContacts) senderBits.push("in your saved contacts [explicit]");
  if ((sig.keptFrom ?? 0) > 0) senderBits.push(`you keep their mail (${sig.keptFrom}) [observed]`);
  const who = input.fromName || counterparty || email;
  if (senderBits.length) {
    lines.push(`SENDER: ${who} <${email}> — ${senderBits.join("; ")}`);
    refs.push(`person:${email}`);
  } else {
    // Absence is evidence: no relationship on record at all.
    lines.push(`SENDER: ${who} <${email}> — no prior relationship on record [observed]`);
  }

  // MEETING — a shared calendar event with this sender
  const meet = meetingLabel(ctx.meeting);
  if (meet) {
    lines.push(`MEETING: ${meet} [calendar]`);
    refs.push(`calendar:${ctx.meeting?.subject ?? ""}`);
  }

  // LIKELY MATTER — the prior concern this email probably continues
  if (sources.priorMatters?.length) {
    const hit = bestPriorMatter(email, hay, counterparty, sources.priorMatters);
    if (hit) {
      const conf = Math.min(0.95, 0.6 + hit.score * 0.1).toFixed(2);
      lines.push(
        `LIKELY MATTER: ${hit.matter.title}${
          hit.matter.narrative ? ` — ${hit.matter.narrative}` : ""
        } [inference ${conf}]`,
      );
      refs.push(`matter:${hit.matter.id}`);
    }
  }

  // CRM — authoritative facts for any code in the email
  if (sources.salesforce) {
    const crm = crmLine(hay, sources.salesforce);
    if (crm) {
      lines.push(`CRM: ${crm.text} [system]`);
      refs.push(crm.ref);
    }
  }

  // WORK — proof the user is actively working this concern (Timeglass,
  // Drive, notes). Joins by counterparty and any code in the email.
  if (sources.workSignals?.length) {
    const codes = (hay.match(CODE_PATTERN) ?? []).map((c) => normalizeCode(c));
    const sig = latestSignalFor(sources.workSignals, [counterparty, ...codes]);
    if (sig) {
      const when = sig.at.slice(0, 10);
      const mins = sig.minutes ? ` (${sig.minutes}m)` : "";
      lines.push(
        `WORK: you ${sig.kind} "${sig.label}"${mins} on ${when} — this concern is active [observed]`,
      );
      refs.push(`work:${sig.source}:${sig.ref ?? sig.label}`);
    }
  }

  // BEHAVIOR — what the user has done with this sender before
  const stat = sources.actionMemory?.[email];
  if (stat && stat.archive + stat.trash > 0) {
    const total = stat.archive + stat.trash;
    const verb = stat.trash >= stat.archive ? "delete" : "archive";
    const n = stat.trash >= stat.archive ? stat.trash : stat.archive;
    lines.push(`BEHAVIOR: you ${verb} their mail (${n}/${total}) [observed]`);
  }

  if (lines.length === 0) return { text: "", refs: [] };

  const header =
    "CONTEXT (evidence about this sender and the work it belongs to; " +
    "[explicit] and [system] facts OUTRANK your own read, [inference] is a hint, " +
    "and no context means the sender is genuinely peripheral):";
  let text = `${header}\n${lines.join("\n")}`;
  if (text.length > PACKET_MAX_CHARS) text = `${text.slice(0, PACKET_MAX_CHARS)}…`;
  return { text, refs };
}
