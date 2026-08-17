import type { Disposition } from "./triage-rank";

export type MailboxFolder = "inbox" | "sent" | "trash";

/**
 * How the list is ordered. `date` is a mail client's newest-first. `triage` is
 * the smart filter: most likely to delete first, ordered by the durable
 * decision behind each row rather than by when it arrived.
 */
export type MailboxSort = "date" | "triage";

export type MailboxRow = {
  conversationId: string;
  providerConversationId: string;
  senderDisplayName: string;
  subject: string;
  timestamp: string;
  isUnread: boolean;
  snippet: string;
  attachments: string[];
  decisionSummary: string | null;
  priority: number | null;
  dueDate: string | null;
  matterTitle: string | null;
  /** What Seer's current decision says this is. Server-set; never re-derived. */
  disposition: Disposition;
  /** 0 = most likely to delete. The number the triage sort orders by. */
  deleteRank: number;
  /**
   * Signed proof the current decision authorises deleting this conversation.
   * Present only where the decision is `delete`, so a bulk action in the inbox
   * can never destroy mail the safety layer refused.
   */
  deleteToken: string | null;
  /** The part of the business this was filed under, shown as a row label. */
  category: string | null;
  /**
   * Why a proposed delete was refused. Carried to the client so the inbox can
   * say what it pulled out of the clear pile rather than silently moving it.
   */
  vetoReasons: string[];
};

export type MailboxView = {
  /** Identity scope for browser caches; never reuse a view across accounts. */
  accountId: string;
  folder: MailboxFolder;
  sort: MailboxSort;
  rows: MailboxRow[];
  total: number;
  /**
   * How many conversations still need a decision from the user, counted over
   * the whole inbox rather than the loaded page. The ledger reports this, and a
   * page-local count read "0 need you" while seventy sat unloaded below the
   * fold — the one number the ledger exists to give, wrong.
   */
  needsYou: number;
  nextCursor: string | null;
};
