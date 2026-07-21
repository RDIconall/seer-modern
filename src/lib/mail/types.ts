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
  /** Every address on the message (from + to + cc, lowercase) — the
   *  recipient group that decides whether thread rows collapse */
  participants?: string[];
};

export type MailAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type MailMessageDetail = MailMessageListItem & {
  textBody: string;
  htmlBody: string;
  toEmail: string;
  ccEmail: string;
  messageIdHeader: string;
  /** UID from an embedded text/calendar part — exact invite → event link */
  icalUid?: string;
  attachments?: MailAttachment[];
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
