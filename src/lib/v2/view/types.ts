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
   * The whiteboard section this is filed under — the part of the BUSINESS
   * ("sales — new requests", "hr", "recruiting"), never the sender's company.
   * Triage groups by it; the client never recomputes it.
   */
  category: string;
  /** Who the work is with, shown alongside the section but never grouping it. */
  counterparty: string;
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
  /** The counterparty this work is with ("roche", "internal"). */
  orgUnit: string | null;
  /**
   * The whiteboard section this is filed under — the part of the business, not
   * the counterparty. Two Roche matters can be "software" and "sales — leads".
   */
  section: string;
  conversations: ConversationRow[];
  yields: YieldRow[];
};

/** A whiteboard section with the matters filed under it, in registry order. */
export type AtlasSection = {
  name: string;
  matters: MatterCard[];
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
  /** The same matters as `atlas`, grouped into whiteboard sections. */
  sections: AtlasSection[];
  /** The user's function registry, in their order — how sections are sorted. */
  functions: string[];
  records: ConversationRow[];
  safeToDelete: DeleteRow[];
  undecided: ConversationRow[];
  worthReading: YieldRow[];
};
