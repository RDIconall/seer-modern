import type { Conversation } from "../providers/types";

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
};

export type ContextInput = {
  ownDomain: string;
  /** The account's own email, for the direct-address salience signal. */
  ownEmail?: string;
  people: KnownPerson[];
  matters: LiveMatter[];
  interests: string[];
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

  // Match the thread against live matters by shared vocabulary.
  const haystack = tokens(
    `${conversation.subject} ${conversation.messages
      .map((m) => m.bodyText ?? m.snippet)
      .join(" ")}`,
  );
  let candidateMatterId: string | null = null;
  for (const matter of input.matters) {
    const overlap = [...tokens(matter.title)].filter((t) => haystack.has(t));
    if (overlap.length > 0) {
      lines.push(
        `[inference] may continue the live matter "${matter.title}" (shared: ${overlap.join(", ")})`,
      );
      refs.push(`matter:${matter.id}`);
      candidateMatterId ??= matter.id;
    }
  }

  const relevantInterests = input.interests.filter((i) =>
    [...tokens(i)].some((t) => haystack.has(t)),
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
  };
}
