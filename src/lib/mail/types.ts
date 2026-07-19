export type MailFolder = "inbox" | "sent" | "trash";

export type MailMessageListItem = {
  id: string;
  threadId: string;
  fromEmail: string;
  fromName: string;
  /** Primary To: address — used for sent-folder relationship graph */
  peerEmail?: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  /** Provider label ids (Gmail) — carries saved Seer decisions */
  labelIds?: string[];
};

export type MailMessageDetail = MailMessageListItem & {
  textBody: string;
  htmlBody: string;
  toEmail: string;
  ccEmail: string;
  messageIdHeader: string;
};

export type SendMailInput = {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Reply / forward threading */
  threadId?: string;
  inReplyTo?: string;
  references?: string;
};
