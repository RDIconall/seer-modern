import type { Conversation } from "../providers/types";
import type { ReadResult } from "./schema";

/**
 * How loudly a conversation should raise its hand, computed from FACTS rather
 * than a model's self-assessment (a hallucinated "urgent" flag must never push
 * something up the list). It combines what the read judged about meaning
 * (owner, obligation) with two deterministic signals the read alone can't be
 * trusted on: whether the message is addressed directly to the user, and how
 * senior the sender is.
 *
 * This is what separates a generic sourcing broadcast (nobody's ball, sent to
 * every vendor, from a portal robot) from a direct demand ("please respond",
 * addressed to you, from someone senior).
 */

export type SalienceInputs = {
  read: Pick<ReadResult, "owner" | "obligation" | "ask">;
  conversation: Conversation;
  ownEmail: string;
  /** Sender tier from the relationship graph: inner | known | ... */
  senderTier: string;
  senderVip: boolean;
};

/**
 * Accept a stated due date only if it is a real, plausible calendar date. A
 * malformed or absurd value is discarded rather than trusted — a wrong date
 * must never be able to reorder the user's day.
 */
export function validDueDate(value: string | undefined, now = new Date()): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const years = (parsed.getTime() - now.getTime()) / (365.25 * 24 * 3600 * 1000);
  // More than a year past or five years out is a misread, not a deadline.
  if (years < -1 || years > 5) return null;
  return value;
}

/** Is the newest inbound message addressed directly to the user (To/Cc)? */
export function addressedDirectly(
  conversation: Conversation,
  ownEmail: string,
): boolean {
  const me = ownEmail.toLowerCase();
  const inbound = [...conversation.messages].reverse().find((m) => !m.isOutgoing);
  if (!inbound) return false;
  return [...inbound.to, ...inbound.cc].some((a) => a.email.toLowerCase() === me);
}

/** 0 (ambient) … 3 (a direct demand from someone who matters). */
export function computeSalience(input: SalienceInputs): number {
  let score = 0;

  // The read judged the user personally owes the next move.
  if (input.read.owner === "you") score += 1;

  // A signature / approval / regulatory / payment step is pending.
  if (input.read.obligation) score += 1;

  // Addressed to the user, not broadcast to a vendor list.
  if (addressedDirectly(input.conversation, input.ownEmail)) score += 1;

  // From someone senior / in the user's circle, not a portal robot.
  if (input.senderVip || input.senderTier === "inner") score += 1;

  return Math.min(3, score);
}
