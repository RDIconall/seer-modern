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
  /** Threads the user STARTED with this person — the strongest VIP vote */
  initiated?: number;
  /** Median minutes the user takes to reply to them — revealed priority */
  medianReplyMins?: number;
};

export type MailHistory = {
  accountEmail: string;
  builtAt: string;
  contacts: Record<string, ContactStat>;
  engagedCount: number;
  contactCount: number;
  /** Threads the user has replied to (threadId → last sent time). */
  repliedThreads?: Record<string, string>;
};

export type HistorySignals = {
  relationship: Relationship;
  sentTo: number;
  receivedFrom: number;
  daysSinceLastSent: number | null;
  /** Classic Seer: downgrade if you haven't written them in ~30 days */
  staleEngagement: boolean;
  /** Median minutes the user takes to reply to this sender */
  medianReplyMins?: number;
  /** Threads the user started with them */
  initiated?: number;
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

  // Earliest inbound per thread — the message the user was replying to
  const inboundByThread = new Map<string, { from: string; at: number }>();
  for (const m of inbox) {
    const t = new Date(m.receivedAt).getTime();
    const prev = inboundByThread.get(m.threadId);
    if (!prev || t < prev.at) {
      inboundByThread.set(m.threadId, {
        from: norm(m.fromEmail),
        at: t,
      });
    }
  }

  const replySamples = new Map<string, number[]>();
  const repliedThreads: Record<string, string> = {};
  for (const m of sent) {
    if (m.threadId) {
      const prev = repliedThreads[m.threadId];
      if (!prev || m.receivedAt > prev) repliedThreads[m.threadId] = m.receivedAt;
    }
    const peer = m.peerEmail || m.fromEmail;
    const c = touch(peer);
    if (!c) continue;
    c.sentTo += 1;
    if (!c.lastSentAt || m.receivedAt > c.lastSentAt) c.lastSentAt = m.receivedAt;

    // Reply telemetry: how fast does the user answer this person?
    const inbound = inboundByThread.get(m.threadId);
    const sentAt = new Date(m.receivedAt).getTime();
    if (inbound && inbound.from === norm(peer) && sentAt > inbound.at) {
      const mins = (sentAt - inbound.at) / 60_000;
      if (mins < 14 * 24 * 60) {
        const list = replySamples.get(norm(peer)) ?? [];
        list.push(mins);
        replySamples.set(norm(peer), list);
      }
    } else if (!inbound) {
      // No inbound in this thread — the user STARTED the conversation
      c.initiated = (c.initiated ?? 0) + 1;
    }
  }

  for (const [email, samples] of replySamples) {
    const c = contacts[email];
    if (!c) continue;
    samples.sort((a, b) => a - b);
    c.medianReplyMins = Math.round(samples[Math.floor(samples.length / 2)]);
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
    repliedThreads,
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
    medianReplyMins: c?.medianReplyMins,
    initiated: c?.initiated,
  };
}
