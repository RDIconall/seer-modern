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

/**
 * Colors come from the Seer brand guidelines (1.4 Color Palette / 1.6 UI
 * Design): orange #ff8f2d, cyan #6bcfe1, green #96d322, purple #967ad0,
 * dim grays #778591/#99a3ad, plus the action-icon blue from the original
 * iPhone card UI. Cyan and green are darkened where white text sits on top.
 */
export const ACTION_META: Record<
  TriageAction,
  { label: string; short: string; color: string; bulkLabel: string }
> = {
  respond: {
    label: "Respond to this",
    short: "Respond",
    color: "#2e7cf6",
    bulkLabel: "Mark all read",
  },
  read_and_archive: {
    label: "Read and archive",
    short: "Archive",
    color: "#778591",
    bulkLabel: "Archive all",
  },
  read_and_delete: {
    label: "Read and delete",
    short: "Read & delete",
    color: "#cf6a4d",
    bulkLabel: "Delete all",
  },
  delete_now: {
    label: "Don't read — delete",
    short: "Delete",
    color: "#d63b2f",
    bulkLabel: "Delete all",
  },
  act_today: {
    label: "Act today",
    short: "Urgent",
    color: "#ff8f2d",
    bulkLabel: "Mark all read",
  },
  unsubscribe: {
    label: "Unsubscribe",
    short: "Unsub",
    color: "#967ad0",
    bulkLabel: "Unsubscribe all",
  },
  review_subscription: {
    label: "Review subscription",
    short: "Sub",
    color: "#76ab19",
    bulkLabel: "Review each",
  },
  glance_promo: {
    label: "Glance and archive",
    short: "Promo",
    color: "#2fa8c7",
    bulkLabel: "Archive all",
  },
  needs_review: {
    label: "Needs your call",
    short: "Review",
    color: "#99a3ad",
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

const TIME_SENSITIVE =
  /\b(2fa|two-factor|verification code|verify your|otp|password reset|boarding pass|flight|appointment|delivery|shipped|out for delivery|expires today|due today|reminder:|action required)\b/i;

const FINANCE_DOMAINS =
  /(bankofamerica|chase|wellsfargo|plaid|stripe|amex|americanexpress|paypal|venmo|capitalone|citi\.com|schwab)/i;

const MARKETING_LOCAL =
  /^(promo|deals|offers|newsletter|news|marketing|hello@|info@|team@|notifications@)/i;

const MARKETING_SUBDOMAIN = /^(mail|email|m|e|news|promo)\./i;

const NOREPLY = /^(no-?reply|donotreply|noreply|notifications|alert|updates)@/i;

const SALES = /^(reply|sales|bd|business|partnerships)@/i;

const PERSONAL_PROVIDERS =
  /@(gmail\.com|googlemail\.com|icloud\.com|me\.com|mac\.com|yahoo\.com|hotmail\.com|outlook\.com|live\.com)$/i;

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

  if (/\bunsubscribe\b/i.test(blob) && MARKETING_SUBDOMAIN.test(dom)) {
    return {
      action: "unsubscribe",
      confidence: "MED",
      reason: "Marketing sender with unsubscribe",
    };
  }

  if (
    FINANCE_DOMAINS.test(dom) ||
    /\b(statement|invoice|receipt|payment|charged|subscription renewed)\b/i.test(
      blob,
    )
  ) {
    if (/\b(failed|declined|price change|unusual|anomaly)\b/i.test(blob)) {
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
        reason: "Marketing pattern",
      };
    }
    return {
      action: "delete_now",
      confidence: "MED",
      reason: "Marketing subdomain or address",
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

  if (/\b(sale|%\s*off|limited time|shop now|free shipping)\b/i.test(blob)) {
    return {
      action: "glance_promo",
      confidence: "MED",
      reason: "Promotional content",
    };
  }

  if (/\?/.test(input.snippet) || /\b(can you|could you|please send|let me know)\b/i.test(blob)) {
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
