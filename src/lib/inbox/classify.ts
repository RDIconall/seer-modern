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

export type ClassifyDebug = {
  ruleId: string;
  relationship: HistorySignals["relationship"];
  sentTo: number;
  receivedFrom: number;
  daysSinceLastSent: number | null;
  staleEngagement: boolean;
  actionable: boolean;
  intel: {
    notices: number;
    schedule: number;
    request: number;
    followUp: number;
  };
};

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
  debug: ClassifyDebug;
};

/**
 * Action-oriented triage in the spirit of classic Seer.
 * Every message gets an action + ruleId so you can audit the path.
 */
const TIME_SENSITIVE =
  /\b(2fa|two-factor|verification code|verify your|otp|password reset|security alert|boarding pass|flight|appointment|delivery|shipped|out for delivery|expires today|due today|reminder:|action required|confirm your (email|account))\b/i;

const PRODUCT_NOTIFY_DOMAINS =
  /(github\.com|noreply\.github\.com|users\.noreply\.github\.com|gitlab\.com|bitbucket\.org|vercel\.com|netlify\.com|cursor\.com|cursor\.sh|slack\.com|discord\.com|notion\.so|figma\.com|linear\.app|atlassian\.net|jira\.|asana\.com|trello\.com|dropbox\.com|box\.com|zoom\.us|calendly\.com|linkedin\.com|twitter\.com|x\.com|facebookmail\.com|instagram\.com|spotify\.com|apple\.com|accounts\.google\.com|microsoft\.com|office365\.com|google\.com|amazonses\.com|sendgrid\.net|mailchimp\.com|intercom-mail\.com|stripe\.com)/i;

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

type Ctx = {
  signals: HistorySignals;
  actionable: boolean;
  intel: ReturnType<typeof intelBreakdown>;
};

function hit(
  action: TriageAction,
  confidence: Confidence,
  reason: string,
  ruleId: string,
  ctx: Ctx,
): ClassifyResult {
  return {
    action,
    confidence,
    reason,
    debug: {
      ruleId,
      relationship: ctx.signals.relationship,
      sentTo: ctx.signals.sentTo,
      receivedFrom: ctx.signals.receivedFrom,
      daysSinceLastSent: ctx.signals.daysSinceLastSent,
      staleEngagement: ctx.signals.staleEngagement,
      actionable: ctx.actionable,
      intel: ctx.intel,
    },
  };
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
  const ctx: Ctx = { signals, actionable, intel };

  if (senderOverride) {
    return hit(
      senderOverride,
      "HIGH",
      "You taught this sender",
      "override-taught-sender",
      ctx,
    );
  }

  if (TIME_SENSITIVE.test(blob) || TIME_SENSITIVE.test(input.subject)) {
    return hit(
      "act_today",
      "MED",
      "Time-sensitive keywords",
      "time-sensitive-keywords",
      ctx,
    );
  }

  const humanHit = classifyByRelationship(ctx, email, blob);
  if (humanHit) return humanHit;

  if (SHOPPING_DOMAINS.test(dom) || SHOPPING_DOMAINS.test(fromBlob)) {
    return hit(
      "glance_promo",
      "MED",
      "Shopping / deals mail",
      "shopping-domain",
      ctx,
    );
  }

  if (PRODUCT_NOTIFY_DOMAINS.test(dom) || PRODUCT_NOTIFY_DOMAINS.test(fromBlob)) {
    if (PROMO_BLOB.test(blob)) {
      return hit(
        "glance_promo",
        "MED",
        "Product promo",
        "product-notify-promo",
        ctx,
      );
    }
    return hit(
      "read_and_archive",
      "MED",
      "Product or CI notification",
      "product-notify-archive",
      ctx,
    );
  }

  if (FINANCE_DOMAINS.test(dom) || RECEIPT_BLOB.test(blob)) {
    if (ANOMALY_BLOB.test(blob)) {
      return hit(
        "review_subscription",
        "MED",
        "Billing anomaly keywords",
        "finance-anomaly",
        ctx,
      );
    }
    return hit(
      "read_and_archive",
      "MED",
      "Finance or receipt mail",
      "finance-receipt",
      ctx,
    );
  }

  if (isMarketingShape(local, dom, blob) || MARKETING_SUBDOMAIN.test(dom)) {
    if (/\bunsubscribe\b/i.test(blob) && signals.sentTo === 0) {
      return hit(
        "unsubscribe",
        "MED",
        "Marketing you never engage — unsubscribe",
        "marketing-unsubscribe",
        ctx,
      );
    }
    if (signals.relationship === "cold" || signals.relationship === "bulk") {
      return hit(
        "delete_now",
        "MED",
        "Cold marketing — don't read, delete",
        "marketing-cold-delete",
        ctx,
      );
    }
    return hit(
      "glance_promo",
      "MED",
      "Marketing pattern",
      "marketing-glance",
      ctx,
    );
  }

  if (SALES.test(local) && signals.sentTo === 0) {
    return hit(
      "read_and_delete",
      "MED",
      "Cold sales outreach",
      "sales-cold",
      ctx,
    );
  }

  if (NOREPLY.test(local)) {
    if (signals.sentTo === 0) {
      return hit(
        "delete_now",
        "MED",
        "Automated sender you never write — delete",
        "noreply-cold-delete",
        ctx,
      );
    }
    return hit(
      "read_and_archive",
      "MED",
      "Automated noreply from a known sender",
      "noreply-known-archive",
      ctx,
    );
  }

  if (dom.endsWith(".edu") || dom.endsWith(".gov")) {
    return hit(
      actionable ? "respond" : "read_and_archive",
      "MED",
      "Educational or government domain",
      actionable ? "edu-gov-respond" : "edu-gov-archive",
      ctx,
    );
  }

  if (PERSONAL_PROVIDERS.test(email)) {
    if (PROMO_BLOB.test(blob) || /\bunsubscribe\b/i.test(blob)) {
      return hit(
        "glance_promo",
        "MED",
        "Personal provider but promotional content",
        "personal-promo",
        ctx,
      );
    }
    if (actionable) {
      return hit(
        "respond",
        "MED",
        "Personal provider + actionable language",
        "personal-actionable",
        ctx,
      );
    }
    return hit(
      "read_and_delete",
      "MED",
      "Personal provider, no ask detected — skim then delete",
      "personal-default-skim",
      ctx,
    );
  }

  if (PROMO_BLOB.test(blob)) {
    return hit(
      "glance_promo",
      "MED",
      "Promotional content",
      "promo-blob",
      ctx,
    );
  }

  if (actionable) {
    return hit(
      "needs_review",
      "LOW",
      "Looks actionable but no sent history with this sender",
      "cold-actionable-review",
      ctx,
    );
  }

  // Default: still categorized (not "uncategorized")
  return hit(
    "read_and_delete",
    "MED",
    "No strong signal — default skim once then delete",
    "default-skim-delete",
    ctx,
  );
}

function classifyByRelationship(
  ctx: Ctx,
  email: string,
  blob: string,
): ClassifyResult | null {
  const { signals, actionable, intel } = ctx;
  const { relationship, sentTo, staleEngagement } = signals;

  if (relationship === "engaged") {
    if (staleEngagement && actionable) {
      return hit(
        "needs_review",
        "MED",
        "You used to email them (>30d) — confirm before treating as reply",
        "engaged-stale-review",
        ctx,
      );
    }
    if (intel.schedule > 0 || /\b(today|tomorrow|asap|eod)\b/i.test(blob)) {
      return hit(
        "act_today",
        "HIGH",
        `Schedule/urgency from someone you email (sent×${sentTo})`,
        "engaged-schedule-today",
        ctx,
      );
    }
    if (actionable) {
      return hit(
        "respond",
        "HIGH",
        `Actionable ask from someone you email (sent×${sentTo})`,
        "engaged-actionable-respond",
        ctx,
      );
    }
    return hit(
      "read_and_archive",
      "MED",
      `FYI from someone you email (sent×${sentTo})`,
      "engaged-fyi-archive",
      ctx,
    );
  }

  if (relationship === "known") {
    if (actionable) {
      return hit(
        "respond",
        "MED",
        "Repeat sender with actionable language — you haven't written them",
        "known-actionable-respond",
        ctx,
      );
    }
    return hit(
      "read_and_delete",
      "MED",
      "Frequent inbound, no outbound — read once then delete",
      "known-skim-delete",
      ctx,
    );
  }

  if (relationship === "bulk") {
    if (/\bunsubscribe\b/i.test(blob)) {
      return hit(
        "unsubscribe",
        "MED",
        "Bulk sender with unsubscribe",
        "bulk-unsubscribe",
        ctx,
      );
    }
    return hit(
      "delete_now",
      "MED",
      "Bulk/noreply pattern — don't read, delete",
      "bulk-delete",
      ctx,
    );
  }

  if (relationship === "cold" && actionable && PERSONAL_PROVIDERS.test(email)) {
    return hit(
      "needs_review",
      "LOW",
      "Possible person asking something — no sent history yet",
      "cold-personal-actionable",
      ctx,
    );
  }

  return null;
}
