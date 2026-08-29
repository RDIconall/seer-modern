import type { Conversation } from "../providers/types";
import {
  counterpartyOf,
  ownTokens,
  resolveMatterMatch,
} from "./matter-key";

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
};

export type CompiledContext = {
  text: string;
  refs: string[];
  /** Facts the safety layer needs, derived deterministically (not by the model). */
  senderIsKnown: boolean;
  senderIsInternal: boolean;
  candidateMatterId: string | null;
  /** The sender's tier and VIP flag, for salience. */
  senderTier: string;
  senderVip: boolean;
  /** Exact-sender corrections away from Atlas, used by the promotion gate. */
  priorMatterRejections: number;
};

const MAX_CHARS = 1200;

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

export function compileContext(
  conversation: Conversation,
  input: ContextInput,
): CompiledContext {
  const lines: string[] = [];
  const refs: string[] = [];

  const guidance = input.operatingGuidance?.trim();
  if (guidance) {
    lines.push(
      `[explicit] how this desk is organised (user): ${guidance.slice(0, 500)}`,
    );
  }

  const senderEmail = conversation.messages[0]?.from.email?.toLowerCase() ?? "";
  const senderDomain = senderEmail.split("@")[1] ?? "";
  const senderIsInternal =
    Boolean(input.ownDomain) && senderDomain === input.ownDomain.toLowerCase();

  const person = input.people.find((p) => p.email.toLowerCase() === senderEmail);
  const senderIsKnown = Boolean(
    person && (person.vip || person.tier === "inner" || person.tier === "known"),
  );

  if (person) {
    lines.push(
      `[observed] sender ${senderEmail} is tier=${person.tier}${person.vip ? " (VIP)" : ""}`,
    );
    refs.push(`person:${senderEmail}`);
  } else if (senderEmail) {
    lines.push(`[observed] sender ${senderEmail} has no prior relationship on record`);
  }
  if (senderIsInternal) {
    lines.push(`[system] sender is inside your organization (${input.ownDomain})`);
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

  // Existing-matter continuity used to mean "one shared word". That made
  // every Roche email continue the first Roche matter and then bypass matter
  // promotion safety as known work. Use the conservative resolver instead:
  // shared study/event code is proof; otherwise counterparty AND meaningful
  // request words must overlap.
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
    input.matters.map((matter) => ({
      matterId: matter.id,
      title: matter.title,
      codes: matter.codes ?? [],
      counterparty: matter.counterparty ?? "",
      userAuthored: Boolean(matter.userAuthored),
    })),
  );
  const candidateMatterId = matterMatch?.matterId ?? null;
  if (matterMatch) {
    const matter = input.matters.find((item) => item.id === matterMatch.matterId);
    if (matter) {
      lines.push(
        `[inference] may continue the live matter "${matter.title}" (conservative relation match)`,
      );
      refs.push(`matter:${matter.id}`);
    }
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
    senderTier: person?.tier ?? "unknown",
    senderVip: Boolean(person?.vip),
    priorMatterRejections,
  };
}
