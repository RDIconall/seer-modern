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
