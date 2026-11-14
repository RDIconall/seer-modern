import type { Conversation } from "../providers/types";
import {
  counterpartyOf,
  ownTokens,
  resolveMatterMatch,
} from "./matter-key";
import {
  extractAmount,
  isAnomalousCharge,
  usualAmount,
  usualLabel,
  type MerchantDb,
} from "./amounts";
import {
  contextSignals,
  inviteAnswered,
  nextFreeSlot,
  type PersonalContext,
} from "./personal-context";
import {
  learnedPrior,
  type ActionMemory,
  type SenderActionStats,
} from "./history";
import { meetingLabel, type MeetingLite } from "./verdict";
import { CODE_PATTERN, normalizeCode } from "@/lib/crm/registry";

/**
 * The context packet fed alongside the full conversation. It is the smallest
 * set of sourced facts that lets the read beat a naive full-email read: who the
 * sender is to this user, which live matters the thread may touch, and what the
 * user has said they care about. Every line is labeled with its authority so
 * the model trusts facts over guesses.
 */

export type KnownPerson = {
  email: string;
  tier: string;
  vip: boolean;
};

export type LiveMatter = {
  id: string;
  title: string;
  codes: string[];
  counterparty: string;
  userAuthored: boolean;
};

export type PlacementFeedback = {
  senderEmail: string;
  home: "matter" | "record" | "delete";
  count: number;
};

export type ContextInput = {
  ownDomain: string;
  /** The account's own email, for the direct-address salience signal. */
  ownEmail?: string;
  people: KnownPerson[];
  matters: LiveMatter[];
  interests: string[];
  /** Explicit destinations this user previously chose in Triage. */
  placements?: PlacementFeedback[];
  /** How this desk is organised, in the user's own words. */
  operatingGuidance?: string;
  /** How this person clears mail and what should become a matter. */
  mailboxStyleGuidance?: string;
  /** About-me block, already labeled [explicit]. */
  profileBlock?: string | null;
  personal?: PersonalContext | null;
  writtenTo?: Set<string> | string[];
  actionMemory?: ActionMemory;
  merchants?: MerchantDb;
  /** Normalized study/opportunity code → CRM label. */
  crmLabels?: Record<string, string>;
};

export type CompiledContext = {
  text: string;
  refs: string[];
  /** Facts the safety layer needs, derived deterministically (not by the model). */
  senderIsKnown: boolean;
  senderIsInternal: boolean;
  candidateMatterId: string | null;
  candidateMatterTitle: string | null;
  /** The sender's tier and VIP flag, for salience. */
  senderTier: string;
  senderVip: boolean;
  /** Exact-sender corrections away from Atlas, used by the promotion gate. */
  priorMatterRejections: number;
  inContacts: boolean;
  writtenTo: boolean;
  meeting: MeetingLite | null;
  inviteAnswered: boolean;
  weSpokeLast: boolean;
  amount: number | null;
  usualAmount: number | null;
  usualLabel: string | null;
  anomalousAmount: boolean;
  behavior: SenderActionStats | null;
  freeSlot: string | null;
  senderEmail: string;
  senderName: string;
};

const MAX_CHARS = 1600;

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function crmLabelFor(
  hay: string,
  labels: Record<string, string> | undefined,
): string | null {
  if (!labels) return null;
  for (const raw of hay.match(CODE_PATTERN) ?? []) {
    const hit = labels[normalizeCode(raw)];
    if (hit) return hit;
  }
  return null;
}

function asSet(value: Set<string> | string[] | undefined): Set<string> {
  if (!value) return new Set();
  return value instanceof Set ? value : new Set(value.map((item) => item.toLowerCase()));
}

export function compileContext(
  conversation: Conversation,
  input: ContextInput,
): CompiledContext {
  const lines: string[] = [];
  const refs: string[] = [];

  const profile = input.profileBlock?.trim();
  if (profile) {
    lines.push(profile);
  }

  const guidance = input.operatingGuidance?.trim();
  if (guidance) {
    lines.push(
      `[explicit] how this desk is organised (user): ${guidance.slice(0, 400)}`,
    );
  }
  const mailboxStyle = input.mailboxStyleGuidance?.trim();
  if (mailboxStyle) {
    lines.push(
      `[explicit] how this person uses mail (user): ${mailboxStyle.slice(0, 300)}`,
    );
  }

  const inbound = [...conversation.messages].reverse().find((m) => !m.isOutgoing);
  const last = conversation.messages[conversation.messages.length - 1];
  const senderEmail = (
    inbound?.from.email ??
    conversation.messages[0]?.from.email ??
    ""
  ).toLowerCase();
  const senderName = inbound?.from.name ?? conversation.messages[0]?.from.name ?? "";
  const senderDomain = senderEmail.split("@")[1] ?? "";
  const senderIsInternal =
    Boolean(input.ownDomain) && senderDomain === input.ownDomain.toLowerCase();
  const weSpokeLast = Boolean(last?.isOutgoing);
  const written = asSet(input.writtenTo);
  const writtenTo = written.has(senderEmail);
  const signals = contextSignals(input.personal, senderEmail);
  const inContacts = signals.inContacts;
  const meeting = signals.meeting;
  const inviteDone = inviteAnswered(input.personal, conversation.subject);
  const freeSlot = nextFreeSlot(input.personal);

  const person = input.people.find((p) => p.email.toLowerCase() === senderEmail);
  const senderIsKnown = Boolean(
    (person && (person.vip || person.tier === "inner" || person.tier === "known")) ||
      inContacts ||
      writtenTo,
  );

  if (person) {
    lines.push(
      `[observed] sender ${senderEmail} is tier=${person.tier}${person.vip ? " (VIP)" : ""}`,
    );
    refs.push(`person:${senderEmail}`);
  } else if (inContacts) {
    lines.push(`[explicit] sender ${senderEmail} is in your saved contacts`);
    refs.push(`person:${senderEmail}`);
  } else if (writtenTo) {
    lines.push(`[observed] you have written to ${senderEmail}`);
    refs.push(`person:${senderEmail}`);
  } else if (senderEmail) {
    lines.push(`[observed] sender ${senderEmail} has no prior relationship on record`);
  }
  if (senderIsInternal) {
    lines.push(`[system] sender is inside your organization (${input.ownDomain})`);
  }
  if (weSpokeLast) {
    lines.push(`[observed] you already replied — you wrote last in this thread`);
    refs.push("thread:we-spoke-last");
  }

  const meet = meetingLabel(meeting);
  if (meet) {
    lines.push(`[calendar] MEETING: ${meet}`);
    refs.push(`calendar:${meeting?.subject ?? ""}`);
  }
  if (inviteDone) {
    lines.push(`[calendar] you already RSVP'd to this invitation`);
  }
  if (freeSlot && /time|schedul|availab|meet|call|cap\b/i.test(conversation.subject)) {
    lines.push(`[calendar] you look free ${freeSlot}`);
  }

  const placement = (input.placements ?? []).filter(
    (item) => item.senderEmail.toLowerCase() === senderEmail,
  );
  const priorMatterRejections = placement
    .filter((item) => item.home === "record" || item.home === "delete")
    .reduce((sum, item) => sum + item.count, 0);
  const priorMatters = placement
    .filter((item) => item.home === "matter")
    .reduce((sum, item) => sum + item.count, 0);
  if (priorMatterRejections > 0 || priorMatters > 0) {
    lines.push(
      `[explicit] for this exact sender you previously chose Atlas ${priorMatters} time(s), archive/delete ${priorMatterRejections} time(s). Treat this as strong placement feedback; a new direct obligation may override it.`,
    );
    refs.push(`placement:${senderEmail}`);
  }

  const matterText = `${conversation.subject} ${conversation.messages
    .map((m) => m.bodyText ?? m.snippet)
    .join(" ")}`;
  const counterparty = counterpartyOf(senderEmail, input.ownDomain);
  const matterMatch = resolveMatterMatch(
    {
      title: conversation.subject,
      text: matterText,
      counterparty,
      own: ownTokens(input.ownEmail ?? `x@${input.ownDomain}`),
    },
    input.matters.map((matterRow) => ({
      matterId: matterRow.id,
      title: matterRow.title,
      codes: matterRow.codes ?? [],
      counterparty: matterRow.counterparty ?? "",
      userAuthored: Boolean(matterRow.userAuthored),
    })),
  );
  const candidateMatter = matterMatch
    ? input.matters.find((item) => item.id === matterMatch.matterId)
    : undefined;
  const candidateMatterId = matterMatch?.matterId ?? null;
  if (candidateMatter) {
    lines.push(
      `[inference] may continue the live matter "${candidateMatter.title}" (conservative relation match)`,
    );
    refs.push(`matter:${candidateMatter.id}`);
  }

  const crmHit = crmLabelFor(matterText, input.crmLabels);
  if (crmHit) {
    lines.push(`[system] CRM: ${crmHit}`);
    refs.push("crm");
  }

  const amount = extractAmount(matterText);
  const merchants = input.merchants ?? {};
  const usual = amount != null ? usualLabel(merchants, senderEmail) : null;
  const usualAmt = amount != null ? usualAmount(merchants, senderEmail) : null;
  const anomalous =
    amount != null ? isAnomalousCharge(merchants, senderEmail, amount) : false;
  if (amount != null) {
    lines.push(
      `[observed] amount ${usual ? `$${Math.round(amount)} — ${usual}` : `$${Math.round(amount)}`}${
        anomalous ? " — UNUSUAL vs this biller's baseline" : ""
      }`,
    );
    refs.push(`amount:${amount}`);
  }

  const behavior = input.actionMemory?.[senderEmail] ?? null;
  const prior = learnedPrior(input.actionMemory, senderEmail);
  if (prior) {
    lines.push(
      `[observed] BEHAVIOR: you ${prior.dominant} their mail (${prior.count}/${prior.total})`,
    );
  }

  const interestHaystack = tokens(matterText);
  const relevantInterests = input.interests.filter((i) =>
    [...tokens(i)].some((t) => interestHaystack.has(t)),
  );
  for (const interest of relevantInterests) {
    lines.push(`[explicit] you said you care about: ${interest}`);
    refs.push(`interest:${interest}`);
  }

  return {
    text: lines.join("\n").slice(0, MAX_CHARS),
    refs,
    senderIsKnown,
    senderIsInternal,
    candidateMatterId,
    candidateMatterTitle: candidateMatter?.title ?? null,
    senderTier: person?.tier ?? (inContacts || writtenTo ? "known" : "unknown"),
    senderVip: Boolean(person?.vip),
    priorMatterRejections,
    inContacts,
    writtenTo,
    meeting,
    inviteAnswered: inviteDone,
    weSpokeLast,
    amount,
    usualAmount: usualAmt,
    usualLabel: usual,
    anomalousAmount: anomalous,
    behavior,
    freeSlot,
    senderEmail,
    senderName,
  };
}
