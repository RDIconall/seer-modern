import type { Home } from "../db/types";
import type { ReadResult } from "./schema";

/**
 * The safety constraint. It is NOT a second brain: it cannot classify a
 * conversation or choose a home. It does exactly one thing — refuse to let an
 * unsafe `delete` stand, downgrading it to `undecided` so the mail stays
 * visible. Every other decision passes through untouched.
 *
 * This is the structural fix for the original bug: a read that said "fyi/delete"
 * while its own fields showed the user owed a reply, a signature was pending, or
 * the thread belonged to a live matter used to reach "Safe to delete". Here that
 * contradiction is caught in code, deterministically, at the one choke point.
 */

export type SafetyFacts = {
  /** The user personally owes the next action. */
  ownerIsYou: boolean;
  /** Nobody has a live next move. */
  ownerIsNobody: boolean;
  /** A real ask is outstanding (not "nothing — informational"). */
  hasOpenAsk: boolean;
  /** A signature / approval / regulatory / legal / payment step remains. */
  hasPendingObligation: boolean;
  /** The conversation is evidence for a live matter. */
  liveMatterId: string | null;
  /** The sender has a real relationship (VIP / inner / known / written-to / contact). */
  senderIsKnown: boolean;
  /** The sender is inside the user's own organization. */
  senderIsInternal: boolean;
  /** Useful business meaning was detected AND durably persisted. */
  yieldPersisted: boolean;
  /** The model had the full thread and required context. */
  hadCompleteContext: boolean;
  /** A person wrote to the user by name — a letter, not a broadcast. */
  isHumanCorrespondence: boolean;
  /** The newest inbound turn names the user in To/Cc, rather than a broadcast. */
  addressedDirectly: boolean;
  /** Exact-sender Triage choices away from Atlas. */
  priorMatterRejections: number;
};

export type SafetyResult = {
  home: Home;
  vetoReasons: string[];
};

export function validateDelete(
  read: Pick<ReadResult, "home">,
  facts: SafetyFacts,
): SafetyResult {
  // Only a delete is ever vetoed. matter / record / undecided are the model's
  // to decide, and safety must not touch them.
  if (read.home !== "delete") {
    return { home: read.home, vetoReasons: [] };
  }

  const reasons: string[] = [];
  if (facts.ownerIsYou) reasons.push("owner_is_you");
  if (facts.hasOpenAsk) reasons.push("open_ask");
  if (facts.hasPendingObligation) reasons.push("pending_obligation");
  if (facts.liveMatterId) reasons.push("live_matter");
  if (facts.senderIsKnown) reasons.push("known_sender");
  if (facts.senderIsInternal) reasons.push("internal_sender");
  // Every other veto here asks about the state of the work. This one asks what
  // kind of mail it is, which is the gap a personal referral fell through: not
  // yet a known sender, asking a favour rather than raising an obligation, and
  // so deletable by every test that existed.
  if (facts.isHumanCorrespondence) reasons.push("personal_greeting");
  if (!facts.yieldPersisted) reasons.push("unpersisted_yield");
  if (!facts.hadCompleteContext) reasons.push("incomplete_context");

  if (reasons.length === 0) {
    return { home: "delete", vetoReasons: [] };
  }
  // Vetoed: keep the mail visible rather than delete it. The safety layer never
  // promotes it to a matter — that would be a classification it is not allowed
  // to make. Undecided is the honest, safe landing spot.
  return { home: "undecided", vetoReasons: reasons };
}

/**
 * Matter promotion is consequential too: it creates/extends a durable concern
 * on the executive's whiteboard. The old safety layer constrained deletion but
 * let any model `matter` pass untouched, making Atlas the easiest place for a
 * false positive to accumulate forever.
 *
 * Existing matter continuity is strong evidence. A new matter needs a named
 * unit of work plus a direct unresolved ask/obligation. Anything weaker remains
 * visible in Review; safety never guesses Archive/Delete.
 */
export function validateMatterPromotion(
  read: Pick<ReadResult, "home" | "matterRef">,
  facts: SafetyFacts,
): SafetyResult {
  if (read.home !== "matter") {
    return { home: read.home, vetoReasons: [] };
  }
  if (facts.liveMatterId) {
    return { home: "matter", vetoReasons: [] };
  }

  const reasons: string[] = [];
  if (!read.matterRef?.trim()) reasons.push("matter_ref_missing");
  if (facts.ownerIsNobody) reasons.push("matter_owner_nobody");
  if (!facts.hasOpenAsk && !facts.hasPendingObligation) {
    reasons.push("matter_no_open_work");
  }
  if (!facts.addressedDirectly) reasons.push("matter_not_direct");
  if (
    !facts.isHumanCorrespondence &&
    !facts.senderIsKnown &&
    !facts.senderIsInternal &&
    !facts.hasPendingObligation
  ) {
    reasons.push("matter_untrusted_sender");
  }
  if (
    facts.priorMatterRejections > 0 &&
    !facts.hasPendingObligation &&
    !(facts.hasOpenAsk && facts.isHumanCorrespondence)
  ) {
    reasons.push("prior_triage_rejection");
  }

  return reasons.length === 0
    ? { home: "matter", vetoReasons: [] }
    : { home: "undecided", vetoReasons: reasons };
}
