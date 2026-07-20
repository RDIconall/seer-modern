import type { ClassifyDebug, TriageAction } from "@/lib/inbox/classify";

export type Guide = {
  action: TriageAction;
  label: string;
  color: string;
  confidence: string;
  reason: string;
  instruction: string;
  detail?: string;
  /** Audit trail — which rule + history signals fired */
  debug?: ClassifyDebug;
  /** Who decided: Gemini, rules fallback, taught override, or learned from your actions */
  source?: "gemini" | "rules" | "override" | "learned";
  /** Who is this sender to you? */
  who?: string;
  /** Harm in deleting / when you actually need it */
  harm?: string;
  /** The actionable sentence pulled from the email — old Seer style */
  ask?: string;
  /** The implied action — imperative ("Fix the autopay payment") or "Be aware: …" */
  task?: string;
  /** Life bucket ("Old trip", "Groceries — delivered", "Money & bills") */
  category?: string;
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
  history?: {
    builtAt: string;
    contactCount: number;
    engagedCount: number;
  };
  assistant?: {
    engine: string;
    gemini: number;
    rules: number;
    override: number;
    learned?: number;
    cached?: number;
    needsReview: number;
    /** Model that served this load, e.g. "google:gemini-flash-latest" */
    model?: string | null;
    /** Set when the last Gemini call failed — decisions fell back to rules */
    error?: string | null;
  };
  context?: {
    contacts: number;
    events: number;
    /** True when an "about you" memory is loaded into every Gemini call */
    profile?: boolean;
  };
};

export type MailboxData = {
  accountEmail: string;
  fetchedAt: string;
  folder: string;
  items: EmailItem[];
  count: number;
};

export type ViewTab = "inbox" | "sent" | "trash" | "triage" | "cards";
export type MailAction = "archive" | "trash" | "read";

/** Flatten triage payload into a Seer-style card deck (priority order). */
export function buildCardDeck(triage: TodayData | null): EmailItem[] {
  if (!triage) return [];
  const seen = new Set<string>();
  const deck: EmailItem[] = [];
  const push = (items: EmailItem[]) => {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      deck.push(item);
    }
  };
  push(triage.needsReview);
  for (const section of triage.sections) push(section.items);
  if (triage.inbox) push(triage.inbox);
  return deck;
}

/** A card in the deck: one email, or a whole-section bulk action. */
export type DeckCard =
  | { kind: "email"; key: string; item: EmailItem }
  | { kind: "bulk"; key: string; section: Section };

/** How many emails a section needs before it earns a one-tap bulk card. */
const BULK_CARD_MIN = 3;

/**
 * Card deck with triage superpowers: sections whose call is "trash"
 * (delete now, read & delete, unsubscribe, promos) get a single
 * "delete all of these" card in front of their emails. Acting on it
 * clears the whole section at once; skipping it falls through to the
 * usual one-by-one cards.
 */
export function buildDeckCards(triage: TodayData | null): DeckCard[] {
  if (!triage) return [];
  const seen = new Set<string>();
  const deck: DeckCard[] = [];
  const pushEmails = (items: EmailItem[]) => {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      deck.push({ kind: "email", key: item.id, item });
    }
  };
  pushEmails(triage.needsReview);
  for (const section of triage.sections) {
    if (
      primaryMailAction(section.action) === "trash" &&
      section.items.length >= BULK_CARD_MIN
    ) {
      deck.push({
        kind: "bulk",
        key: `bulk:${section.action}`,
        section,
      });
    }
    pushEmails(section.items);
  }
  if (triage.inbox) pushEmails(triage.inbox);
  return deck;
}

/** Category buckets within a section — "Groceries", "Old trip", … */
export type CategoryBucket = { category: string; items: EmailItem[] };

/**
 * Bucket a section's mail by AI life-category, preserving first-seen
 * order. Buckets only earn a sub-header when a section actually spans
 * multiple categories.
 */
export function groupByCategory(items: EmailItem[]): CategoryBucket[] {
  const map = new Map<string, EmailItem[]>();
  for (const item of items) {
    const c = item.guide?.category?.trim() || "Everything else";
    const list = map.get(c) ?? [];
    list.push(item);
    map.set(c, list);
  }
  const buckets = [...map.entries()].map(([category, list]) => ({
    category,
    items: list,
  }));
  // Big buckets first; "Everything else" always last
  return buckets.sort((a, b) => {
    if (a.category === "Everything else") return 1;
    if (b.category === "Everything else") return -1;
    return b.items.length - a.items.length;
  });
}

/** A triage section rendered as singles + same-sender groups. */
export type SenderGroup =
  | { kind: "single"; key: string; item: EmailItem }
  | {
      kind: "group";
      key: string;
      fromEmail: string;
      fromName: string;
      items: EmailItem[];
    };

/**
 * Intelligent grouping: within a section, mail from the same sender
 * collapses into one row ("RetailMeNot · 12") that can be acted on as
 * a unit or expanded. Order follows each sender's first appearance.
 */
export function groupBySender(items: EmailItem[], min = 2): SenderGroup[] {
  const bySender = new Map<string, EmailItem[]>();
  for (const item of items) {
    const k = item.fromEmail.toLowerCase();
    const list = bySender.get(k) ?? [];
    list.push(item);
    bySender.set(k, list);
  }
  const out: SenderGroup[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    const k = item.fromEmail.toLowerCase();
    if (emitted.has(k)) continue;
    emitted.add(k);
    const list = bySender.get(k) ?? [item];
    if (list.length >= min) {
      out.push({
        kind: "group",
        key: `g:${k}`,
        fromEmail: item.fromEmail,
        fromName: item.fromName,
        items: list,
      });
    } else {
      for (const single of list) {
        out.push({ kind: "single", key: single.id, item: single });
      }
    }
  }
  return out;
}

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
  /** The one-tap actions pulled out of the body (track / RSVP / pay …) */
  keyActions?: { label: string; url: string }[];
  /** Set when this email is a calendar invite matched to a real event */
  calendarEvent?: {
    id: string;
    subject: string;
    startsAt: string;
    myStatus?: string;
  };
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
  const daysAgo = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (daysAgo < 7) {
    return d.toLocaleDateString([], { weekday: "long" });
  }
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
    action === "read_and_delete" ||
    // Deals mail has zero lookup value — glancing done, it's trash
    action === "glance_promo"
  ) {
    return "trash";
  }
  if (action === "respond" || action === "act_today") return "read";
  return "archive";
}
