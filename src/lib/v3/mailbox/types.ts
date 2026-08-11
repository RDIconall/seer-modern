export type MailboxFolder = "inbox" | "sent" | "trash";

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
};

export type MailboxView = {
  /** Identity scope for browser caches; never reuse a view across accounts. */
  accountId: string;
  folder: MailboxFolder;
  rows: MailboxRow[];
  total: number;
  nextCursor: string | null;
};
