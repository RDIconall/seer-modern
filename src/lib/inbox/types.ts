import type { TriageAction } from "@/lib/inbox/classify";

export type Guide = {
  action: TriageAction;
  label: string;
  color: string;
  confidence: string;
  reason: string;
  instruction: string;
  detail?: string;
};

export type EmailItem = {
  id: string;
  threadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  guide?: Guide;
};

export type Section = {
  action: TriageAction;
  label: string;
  color: string;
  bulkLabel: string;
  items: EmailItem[];
};

export type TodayData = {
  accountEmail: string;
  fetchedAt: string;
  inbox?: EmailItem[];
  needsReview: EmailItem[];
  sections: Section[];
  count: number;
};

export type MailboxData = {
  accountEmail: string;
  fetchedAt: string;
  folder: string;
  items: EmailItem[];
  count: number;
};

export type ViewTab = "inbox" | "sent" | "trash" | "triage";
export type MailAction = "archive" | "trash" | "read";

export type ReaderMessage = {
  htmlBody: string;
  textBody: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  ccEmail: string;
  threadId: string;
  messageIdHeader: string;
  receivedAt?: string;
  guide?: Guide;
};

export function formatMailTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function mailInitial(name: string) {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export function ensureRe(subject: string) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function ensureFwd(subject: string) {
  return /^(fwd|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
}

export function primaryMailAction(action: TriageAction): MailAction {
  if (
    action === "delete_now" ||
    action === "unsubscribe" ||
    action === "read_and_delete"
  ) {
    return "trash";
  }
  if (action === "respond" || action === "act_today") return "read";
  return "archive";
}
