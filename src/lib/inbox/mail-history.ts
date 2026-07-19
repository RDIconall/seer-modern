import type { MailMessageListItem } from "@/lib/mail/types";

/**
 * Seer-style relationship graph from mailbox history.
 * Sent volume ≈ people you actually engage with; inbox-only ≈ cold/bulk.
 */

export type Relationship =
  | "engaged" // you email them
  | "known" // frequent inbound, little/no outbound
  | "cold" // little history either way
  | "bulk"; // automated / never engaged

export type ContactStat = {
  email: string;
  sentTo: number;
  receivedFrom: number;
  lastSentAt?: string;
  lastReceivedAt?: string;
};

export type MailHistory = {
  accountEmail: string;
  builtAt: string;
  contacts: Record<string, ContactStat>;
  engagedCount: number;
  contactCount: number;
};

export type HistorySignals = {
  relationship: Relationship;
  sentTo: number;
  receivedFrom: number;
  daysSinceLastSent: number | null;
  /** Classic Seer: downgrade if you haven't written them in ~30 days */
  staleEngagement: boolean;
};

const STALE_DAYS = 30;

function norm(email: string) {
  return email.toLowerCase().trim();
}

function daysBetween(iso: string | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / (1000 * 60 * 60 * 24);
}

function looksBulkAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return /^(no-?reply|donotreply|noreply|notifications|alert|updates|mailer-daemon|newsletter|promo|deals|offers)/i.test(
    local,
  );
}

export function buildMailHistory(
  accountEmail: string,
  inbox: MailMessageListItem[],
  sent: MailMessageListItem[],
): MailHistory {
  const me = norm(accountEmail);
  const contacts: Record<string, ContactStat> = {};

  const touch = (email: string) => {
    const key = norm(email);
    if (!key || key === me || !key.includes("@")) return null;
    if (!contacts[key]) {
      contacts[key] = { email: key, sentTo: 0, receivedFrom: 0 };
    }
    return contacts[key];
  };

  for (const m of sent) {
    const peer = m.peerEmail || m.fromEmail;
    const c = touch(peer);
    if (!c) continue;
    c.sentTo += 1;
    if (!c.lastSentAt || m.receivedAt > c.lastSentAt) c.lastSentAt = m.receivedAt;
  }

  for (const m of inbox) {
    const c = touch(m.fromEmail);
    if (!c) continue;
    c.receivedFrom += 1;
    if (!c.lastReceivedAt || m.receivedAt > c.lastReceivedAt) {
      c.lastReceivedAt = m.receivedAt;
    }
  }

  const engagedCount = Object.values(contacts).filter((c) => c.sentTo > 0)
    .length;

  return {
    accountEmail: me,
    builtAt: new Date().toISOString(),
    contacts,
    engagedCount,
    contactCount: Object.keys(contacts).length,
  };
}

export function historySignals(
  history: MailHistory | null | undefined,
  fromEmail: string,
): HistorySignals {
  const email = norm(fromEmail);
  const c = history?.contacts[email];
  const sentTo = c?.sentTo ?? 0;
  const receivedFrom = c?.receivedFrom ?? 0;
  const daysSinceLastSent = daysBetween(c?.lastSentAt);
  const staleEngagement =
    sentTo > 0 &&
    (daysSinceLastSent == null || daysSinceLastSent > STALE_DAYS);

  let relationship: Relationship;
  if (looksBulkAddress(email) && sentTo === 0) relationship = "bulk";
  else if (sentTo > 0) relationship = "engaged";
  else if (receivedFrom >= 3) relationship = "known";
  else if (looksBulkAddress(email)) relationship = "bulk";
  else relationship = "cold";

  return {
    relationship,
    sentTo,
    receivedFrom,
    daysSinceLastSent,
    staleEngagement,
  };
}
