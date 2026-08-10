import type { Conversation } from "../providers/types";
import type { ContextInput } from "../intelligence/context";
import type { Home } from "../db/types";
import type { Yield } from "../intelligence/schema";

/**
 * The executable quality bar. Each case pairs a full conversation with what a
 * correct outcome looks like, plus the business context Seer is allowed to use.
 * The suite runs the same conversation two ways — a context-free baseline read
 * and the full Seer read — and fails the release if Seer is worse.
 */

export type EvalCase = {
  id: string;
  conversation: Conversation;
  context: ContextInput;
  /** The correct home for this conversation. */
  expectedHome: Home;
  /** Matter refs Seer is ALLOWED to connect to; anything else is fabrication. */
  allowedMatterRefs?: string[];
  /** Yield kinds Seer must surface for this conversation. */
  requiredYieldKinds?: Yield["kind"][];
};

/** A naive, context-free read — the "paste into a chat" baseline. */
export type BaselineResult = {
  /** Whether the baseline would keep this email (not delete it). */
  keep: boolean;
  /** Whether the baseline detected an action the user owes. */
  hasAsk: boolean;
};

export type SeerOutcome = {
  home: Home;
  yields: Yield[];
};

export type Evaluation = {
  caseId: string;
  pass: boolean;
  failures: string[];
  improvements: string[];
};

export type ReleaseVerdict = {
  pass: boolean;
  evaluations: Evaluation[];
  falseSafeDeletes: number;
  baselineRegressions: number;
};
