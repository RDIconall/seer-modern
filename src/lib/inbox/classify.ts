import { intelBreakdown, intelContainsAny } from "@/lib/nlp/intel";
import {
  historySignals,
  type HistorySignals,
  type MailHistory,
} from "@/lib/inbox/mail-history";

export type TriageAction =
  | "respond"
  | "read_and_archive"
  | "read_and_delete"
  | "delete_now"
  | "act_today"
  | "unsubscribe"
  | "review_subscription"
  | "glance_promo"
  | "needs_review";

export type Confidence = "HIGH" | "MED" | "LOW" | "NEW";

export const ACTION_META: Record<
  TriageAction,
  { label: string; short: string; color: string; bulkLabel: string }
> = {
  respond: {
    label: "Respond to this",
    short: "Respond",
    color: "#3498d9",
    bulkLabel: "Mark all read",
  },
  read_and_archive: {
    label: "Read and archive",
    short: "Archive",
    color: "#6b7280",
    bulkLabel: "Archive all",
  },
  read_and_delete: {
    label: "Read and delete",
    short: "Read & delete",
    color: "#f97316",
    bulkLabel: "Delete all",
  },
  delete_now: {
    label: "Don't read — delete",
    short: "Delete",
    color: "#dc2626",
    bulkLabel: "Delete all",
  },
  act_today: {
    label: "Act today",
    short: "Urgent",
    color: "#feb022",
    bulkLabel: "Mark all read",
  },
  unsubscribe: {
    label: "Unsubscribe",
    short: "Unsub",
    color: "#a855f7",
    bulkLabel: "Unsubscribe all",
  },
  review_subscription: {
    label: "Review subscription",
    short: "Sub",
    color: "#10b981",
    bulkLabel: "Review each",
  },
  glance_promo: {
    label: "Glance and archive",
    short: "Promo",
    color: "#ec4899",
    bulkLabel: "Archive all",
  },
  needs_review: {
    label: "Needs your call",
    short: "Review",
    color: "#64748b",
    bulkLabel: "Classify selected",
  },
};

/** Display order on Today screen — Seer reply-first, then action orientation */
export const TODAY_SECTION_ORDER: TriageAction[] = [
  "needs_review",
  "act_today",
  "respond",
  "review_subscription",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
  "unsubscribe",
  "glance_promo",
];

export type ClassifyInput = {
  fromEmail: string;
  fromName?: string;
  subject: string;
  snippet: string;
};

export type ClassifyResult = {
  action: TriageAction;
  confidence: Confidence;
  reason: string;
};

/**
 * Action-oriented triage in the spirit of classic Seer:
 * 1) Who do you email? (sent history)
 * 2) Is there an actionable phrase? (Intel.scala keywords)
 * 3) For everyone else — what action fits? (read/archive/delete/promo)
 *
 * First matching rule wins.
 */
const TIME_SENSITIVE =
  /\b(2fa|two-factor|verification code|verify your|otp|password reset|security alert|boarding pass|flight|appointment|delivery|shipped|out for delivery|expires today|due today|reminder:|action required|confirm your (email|account))\b/i;

const PRODUCT_NOTIFY_DOMAINS =
  /(github\.com|noreply\.github\.com|users\.noreply\.github\.com|gitlab\.com|bitbucket\.org|vercel\.com|netlify\.com|cursor\.com|cursor\.sh|slack\.com|discord\.com|notion\.so|figma\.com|linear\.app|atlassian\.net|jira\.|asana\.com|trello\.com|dropbox\.com|box\.com|zoom\.us|calendly\.com|linkedin\.com|twitter\.com|x\.com|facebookmail\.com|instagram\.com|spotify\.com|apple\.com|accounts\.google\.com|microsoft\.com|office365\.com)/i;

const FINANCE_DOMAINS =
  /(bankofamerica|chase\.com|wellsfargo|plaid\.com|stripe\.com|amex|americanexpress|paypal\.com|venmo\.com|citi\.com|schwab|fidelity|coinbase)/i;

const SHOPPING_DOMAINS =
  /(capitaloneshopping|retailmenot|honey\.|rakuten|slickdeals|groupon|shopify|email\.amazon\.|marketing\.amazon)/i;

const MARKETING_LOCAL =
  /^(promo|deals|offers|newsletter|news|marketing|hello@|info@|team@|notifications@|noreply@|no-reply@)/i;

const MARKETING_SUBDOMAIN = /^(mail|email|m|e|news|promo|marketing|go|em)\./i;

const NOREPLY = /^(no-?reply|donotreply|noreply|notifications|alert|updates|mailer-daemon)@/i;

const SALES = /^(sales|bd|business|partnerships|outreach)@/i;

const PERSONAL_PROVIDERS =
  /@(gmail\.com|googlemail\.com|icloud\.com|me\.com|mac\.com|yahoo\.com|hotmail\.com|outlook\.com|live\.com)$/i;

const PROMO_BLOB =
  /\b(sale|%\s*off|limited time|shop now|free shipping|just for you|exclusive offer|new arrivals|flash deal)\b/i;

const RECEIPT_BLOB =
  /\b(statement|invoice|receipt|payment|charged|order confirmation|your order|subscription renewed|billing)\b/i;

const ANOMALY_BLOB =
  /\b(failed|declined|price change|unusual|anomaly|dispute|refund required)\b/i;

function domain(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function localPart(email: string): string {
  return email.split("@")[0]?.toLowerCase() ?? "";
}

function isMarketingShape(local: string, dom: string, blob: string): boolean {
  return (
    MARKETING_LOCAL.test(local) ||
    MARKETING_SUBDOMAIN.test(dom) ||
    SHOPPING_DOMAINS.test(dom) ||
    PROMO_BLOB.test(blob)
  );
}

export function classifyMessage(
  input: ClassifyInput,
  senderOverride?: TriageAction | null,
  history?: MailHistory | null,
): ClassifyResult {
  const email = input.fromEmail.toLowerCase().trim();
  const dom = domain(email);
  const local = localPart(email);
  const blob = `${input.subject} ${input.snippet}`.toLowerCase();
  const fromBlob = `${input.fromName ?? ""} ${email}`.toLowerCase();
  const signals = historySignals(history, email);
  const intel = intelBreakdown(`${input.subject}\n${input.snippet}`);
  const actionable =
    intelContainsAny(`${input.subject}\n${input.snippet}`) ||
    intel.request > 0 ||
    intel.schedule > 0;

  if (senderOverride) {
    return {
      action: senderOverride,
      confidence: "HIGH",
      reason: "You taught this sender",
    };
  }

  if (TIME_SENSITIVE.test(blob) || TIME_SENSITIVE.test(input.subject)) {
    return {
      action: "act_today",
      confidence: "MED",
      reason: "Time-sensitive keywords",
    };
  }

  // --- Seer core: humans you engage with + actionable language ---
  const humanHit = classifyByRelationship(
    signals,
    actionable,
    intel,
    email,
    blob,
  );
  if (humanHit) return humanHit;

  // --- Non-human / low-relationship action orientation ---
  if (SHOPPING_DOMAINS.test(dom) || SHOPPING_DOMAINS.test(fromBlob)) {
    return {
      action: "glance_promo",
      confidence: "MED",
      reason: "Shopping / deals mail",
    };
  }

  if (PRODUCT_NOTIFY_DOMAINS.test(dom) || PRODUCT_NOTIFY_DOMAINS.test(fromBlob)) {
    if (PROMO_BLOB.test(blob)) {
      return {
        action: "glance_promo",
        confidence: "MED",
        reason: "Product promo",
      };
    }
    return {
      action: "read_and_archive",
      confidence: "MED",
      reason: "Product or CI notification",
    };
  }

  if (FINANCE_DOMAINS.test(dom) || RECEIPT_BLOB.test(blob)) {
    if (ANOMALY_BLOB.test(blob)) {
      return {
        action: "review_subscription",
        confidence: "MED",
        reason: "Billing anomaly keywords",
      };
    }
    return {
      action: "read_and_archive",
      confidence: "MED",
      reason: "Finance or receipt mail",
    };
  }

  if (isMarketingShape(local, dom, blob) || MARKETING_SUBDOMAIN.test(dom)) {
    if (/\bunsubscribe\b/i.test(blob) && signals.sentTo === 0) {
      return {
        action: "unsubscribe",
        confidence: "MED",
        reason: "Marketing you never engage — unsubscribe",
      };
    }
    if (signals.relationship === "cold" || signals.relationship === "bulk") {
      return {
        action: "delete_now",
        confidence: "MED",
        reason: "Cold marketing — don't read, delete",
      };
    }
    return {
      action: "glance_promo",
      confidence: "MED",
      reason: "Marketing pattern",
    };
  }

  if (SALES.test(local) && signals.sentTo === 0) {
    return {
      action: "read_and_delete",
      confidence: "MED",
      reason: "Cold sales outreach",
    };
  }

  if (NOREPLY.test(local)) {
    if (signals.sentTo === 0) {
      return {
        action: "delete_now",
        confidence: "MED",
        reason: "Automated sender you never write — delete",
      };
    }
    return {
      action: "read_and_archive",
      confidence: "MED",
      reason: "Automated noreply from a known sender",
    };
  }

  if (dom.endsWith(".edu") || dom.endsWith(".gov")) {
    return {
      action: actionable ? "respond" : "read_and_archive",
      confidence: "MED",
      reason: "Educational or government domain",
    };
  }

  if (PERSONAL_PROVIDERS.test(email)) {
    if (PROMO_BLOB.test(blob) || /\bunsubscribe\b/i.test(blob)) {
      return {
        action: "glance_promo",
        confidence: "LOW",
        reason: "Personal provider but promotional content",
      };
    }
    if (actionable) {
      return {
        action: "respond",
        confidence: "LOW",
        reason: "Personal provider + actionable language",
      };
    }
    return {
      action: "needs_review",
      confidence: "LOW",
      reason: "Personal provider — no strong history yet",
    };
  }

  if (signals.relationship === "cold" && !actionable) {
    return {
      action: "read_and_delete",
      confidence: "LOW",
      reason: "No sent history — skim once then delete",
    };
  }

  if (PROMO_BLOB.test(blob)) {
    return {
      action: "glance_promo",
      confidence: "MED",
      reason: "Promotional content",
    };
  }

  return {
    action: "needs_review",
    confidence: "LOW",
    reason: "No strong rule matched",
  };
}

function classifyByRelationship(
  signals: HistorySignals,
  actionable: boolean,
  intel: ReturnType<typeof intelBreakdown>,
  email: string,
  blob: string,
): ClassifyResult | null {
  const { relationship, sentTo, staleEngagement } = signals;

  if (relationship === "engaged") {
    if (staleEngagement && actionable) {
      return {
        action: "needs_review",
        confidence: "MED",
        reason: "You used to email them (>30d) — confirm before treating as reply",
      };
    }
    if (intel.schedule > 0 || /\b(today|tomorrow|asap|eod)\b/i.test(blob)) {
      return {
        action: "act_today",
        confidence: "HIGH",
        reason: `Schedule/urgency from someone you email (sent×${sentTo})`,
      };
    }
    if (actionable) {
      return {
        action: "respond",
        confidence: "HIGH",
        reason: `Actionable ask from someone you email (sent×${sentTo})`,
      };
    }
    // FYI from a real contact
    return {
      action: "read_and_archive",
      confidence: "MED",
      reason: `FYI from someone you email (sent×${sentTo})`,
    };
  }

  if (relationship === "known") {
    if (actionable) {
      return {
        action: "respond",
        confidence: "MED",
        reason: "Repeat sender with actionable language — you haven't written them",
      };
    }
    return {
      action: "read_and_delete",
      confidence: "MED",
      reason: "Frequent inbound, no outbound — read once then delete",
    };
  }

  if (relationship === "bulk") {
    if (/\bunsubscribe\b/i.test(blob)) {
      return {
        action: "unsubscribe",
        confidence: "MED",
        reason: "Bulk sender with unsubscribe",
      };
    }
    if (isMarketingShape(localPart(email), domain(email), blob) || PROMO_BLOB.test(blob)) {
      return {
        action: "delete_now",
        confidence: "MED",
        reason: "Bulk/automated — don't read, delete",
      };
    }
    return {
      action: "delete_now",
      confidence: "MED",
      reason: "Bulk/noreply pattern — don't read, delete",
    };
  }

  // cold: only intervene early when clearly actionable from a person-shaped address
  if (relationship === "cold" && actionable && PERSONAL_PROVIDERS.test(email)) {
    return {
      action: "needs_review",
      confidence: "LOW",
      reason: "Possible person asking something — no sent history yet",
    };
  }

  return null;
}
