import type { Owner } from "../db/types";

/**
 * The one server-produced inbox model. Atlas, Triage, records, undecided, and
 * "worth reading" are all projections of the same durable decisions. The client
 * renders these rows directly and computes no placement of its own.
 */

export type ConversationRow = {
  conversationId: string;
  providerConversationId: string;
  subject: string;
  from: string;
  at: string;
  summary: string;
  owner: Owner;
  /** 0-3 salience: how loudly this raises its hand (see salience.ts). */
  priority: number;
  /** A date the email stated, if any — orders within a priority bucket. */
  dueDate: string | null;
  /**
   * The part of the user's world this belongs to — the sender's counterparty,
   * derived server-side the same way matters get their org unit ("Roche",
   * "Advarra", "Internal", "Other"). Triage groups by it; the client never
   * recomputes it.
   */
  category: string;
  nativeUrl: string;
};

export type DeleteRow = ConversationRow & {
  /** Signed proof that the current decision authorizes deletion. */
  deleteToken: string;
  vetoReasons: string[];
};

export type YieldRow = {
  conversationId: string;
  kind: string;
  headline: string;
  detail: string | null;
  matterTitle: string | null;
};

export type MatterCard = {
  matterId: string;
  title: string;
  status: string;
  orgUnit: string | null;
  conversations: ConversationRow[];
  yields: YieldRow[];
};

export type Coverage = {
  providerTotal: number;
  stored: number;
  read: number;
  pending: number;
};

export type InboxView = {
  asOf: string;
  coverage: Coverage;
  atlas: MatterCard[];
  records: ConversationRow[];
  safeToDelete: DeleteRow[];
  undecided: ConversationRow[];
  worthReading: YieldRow[];
};
