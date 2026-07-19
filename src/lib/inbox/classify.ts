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

/** Display order on Today screen */
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
 * Heuristic triage (not ML). First matching rule wins:
 * 1. Per-sender override you taught in the UI
 * 2. Time-sensitive / security keywords → act_today
 * 3. Known product/CI bots → read_and_archive
 * 4. Billing anomalies → review_subscription; normal receipts → read_and_archive
 * 5. Clear promo / marketing → glance_promo or unsubscribe (not hard-delete)
 * 6. Sales cold-outreach addresses → read_and_delete
 * 7. Noreply automation → read_and_archive
 * 8. .edu / .gov / personal providers / request language → respond
 * 9. Else → needs_review
 */
const TIME_SENSITIVE =
  /\b(2fa|two-factor|verification code|verify your|otp|password reset|security alert|boarding pass|flight|appointment|delivery|shipped|out for delivery|expires today|due today|reminder:|action required|confirm your (email|account))\b/i;

/** Product / CI / social notifications — glance once, then archive */
const PRODUCT_NOTIFY_DOMAINS =
  /(github\.com|noreply\.github\.com|users\.noreply\.github\.com|gitlab\.com|bitbucket\.org|vercel\.com|netlify\.com|cursor\.com|cursor\.sh|slack\.com|discord\.com|notion\.so|figma\.com|linear\.app|atlassian\.net|jira\.|asana\.com|trello\.com|dropbox\.com|box\.com|zoom\.us|calendly\.com|linkedin\.com|twitter\.com|x\.com|facebookmail\.com|instagram\.com|spotify\.com|apple\.com|google\.com|accounts\.google\.com|microsoft\.com|office365\.com|amazonses\.com|sendgrid\.net)/i;

const FINANCE_DOMAINS =
  /(bankofamerica|chase\.com|wellsfargo|plaid\.com|stripe\.com|amex|americanexpress|paypal\.com|venmo\.com|citi\.com|schwab|fidelity|coinbase)/i;

/** Shopping / deals brands that are not “open your bank statement” */
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

const REQUEST_BLOB =
  /\b(can you|could you|please send|let me know|when are you|are you free|quick question)\b/i;

function domain(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function localPart(email: string): string {
  return email.split("@")[0]?.toLowerCase() ?? "";
}

export function classifyMessage(
  input: ClassifyInput,
  senderOverride?: TriageAction | null,
): ClassifyResult {
  const email = input.fromEmail.toLowerCase().trim();
  const dom = domain(email);
  const local = localPart(email);
  const blob = `${input.subject} ${input.snippet}`.toLowerCase();
  const fromBlob = `${input.fromName ?? ""} ${email}`.toLowerCase();

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

  if (MARKETING_LOCAL.test(local) || MARKETING_SUBDOMAIN.test(dom)) {
    if (/\b(unsubscribe|opt out)\b/i.test(blob)) {
      return {
        action: "unsubscribe",
        confidence: "MED",
        reason: "Marketing pattern with unsubscribe",
      };
    }
    return {
      action: "glance_promo",
      confidence: "MED",
      reason: "Marketing subdomain or address",
    };
  }

  if (PROMO_BLOB.test(blob) && /\bunsubscribe\b/i.test(blob)) {
    return {
      action: "glance_promo",
      confidence: "MED",
      reason: "Promotional content",
    };
  }

  if (SALES.test(local)) {
    return {
      action: "read_and_delete",
      confidence: "MED",
      reason: "Sales outreach address",
    };
  }

  if (NOREPLY.test(local)) {
    return {
      action: "read_and_archive",
      confidence: "MED",
      reason: "Automated noreply sender",
    };
  }

  if (dom.endsWith(".edu") || dom.endsWith(".gov")) {
    return {
      action: "respond",
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
    return {
      action: "respond",
      confidence: "LOW",
      reason: "Personal email provider — likely a person",
    };
  }

  if (/^(info|hello|contact|support)@/.test(local) && dom) {
    return {
      action: "needs_review",
      confidence: "LOW",
      reason: "Generic address on unknown domain",
    };
  }

  if (PROMO_BLOB.test(blob)) {
    return {
      action: "glance_promo",
      confidence: "MED",
      reason: "Promotional content",
    };
  }

  if (/\?/.test(input.snippet) || REQUEST_BLOB.test(blob)) {
    return {
      action: "respond",
      confidence: "MED",
      reason: "Message looks like a request",
    };
  }

  return {
    action: "needs_review",
    confidence: "LOW",
    reason: "No strong rule matched",
  };
}
