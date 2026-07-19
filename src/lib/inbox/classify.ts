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
  /** Address-book / calendar signals when available */
  inContacts?: boolean;
  meeting?: string | null;
};

/** Contact + calendar context, threaded in from personal-context. */
export type ClassifyExtras = {
  inContacts?: boolean;
  /** Human label of an upcoming meeting with this sender, e.g. "Standup · in 2d" */
  meeting?: string | null;
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
/**
 * Genuinely transactional urgency — real even from a noreply robot:
 * codes, security, travel, deliveries, appointments.
 */
/**
 * Urgent only when the user must DO something: codes, security, travel,
 * appointments. Passive status updates ("delivered", "arriving") are NOT
 * actions — packages arrive whether you read the email or not.
 */
const TRANSACTIONAL_URGENT =
  /\b(2fa|two-factor|verification code|one-time (code|passcode)|otp|password reset|security alert|suspicious sign-?in|boarding pass|check-in (open|now)|flight (confirmation|reminder|change|cancell)|appointment (confirm|remind))\b/i;

/** Package carriers — world knowledge the rules engine should have. */
const SHIPPER_DOMAINS =
  /(^|\.)(ups|fedex|usps|dhl|ontrac|lasership|royalmail|canadapost|purolator|aftership|shippo|narvar)\.(com|net|ca|co\.uk|org)$/i;

/** Carrier mail that actually needs the user to act. */
const DELIVERY_NEEDS_YOU =
  /\b(attempted delivery|delivery (failed|attempt|exception)|signature required|ready for pick ?up|pick ?up (required|by)|customs|duty (owed|payment)|held at|address (issue|problem|confirm)|reschedule|action (needed|required) to receive)\b/i;

/**
 * Product/service mail that needs the user's hands — as opposed to
 * passive "it happened" notifications that need nothing.
 */
const PRODUCT_NEEDS_YOU =
  /\b(build (failed|broken)|failing|deploy(ment)? failed|pipeline failed|tests? failed|review requested|requested changes|changes requested|mentioned you|assigned (to )?you|awaiting your (review|approval|response)|approval (needed|required)|security (alert|vulnerability)|vulnerability|new sign-?in|sign-?in attempt|invited you|invitation to|rsvp|sent you a message|direct message)\b/i;

/** Money actually at risk — act, don't just file it. */
const FINANCE_RISK =
  /\b(payment (failed|declined|overdue|past due)|card (was )?declined|insufficient funds|overdraft|fraud|unusual activity|suspicious (charge|transaction)|dispute|due (today|tomorrow)|final notice|account (suspended|locked|on hold))\b/i;

/**
 * Urgency bait — marketing's favorite trick. Only counts as urgent when
 * the sender is trusted (contact / engaged / known); from bulk or cold
 * senders it's just a promo wearing a costume.
 */
const URGENCY_BAIT =
  /\b(expires? (today|tonight|soon|at midnight)|ends (today|tonight|soon)|last (chance|day|hours)|final (notice|hours|day|reminder)|act now|action required|due today|hurry|don'?t miss|limited time|selling (out|fast)|only \d+ (left|remaining)|reminder:|confirm your (email|account))\b/i;

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
  extras?: ClassifyExtras;
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
      inContacts: ctx.extras?.inContacts,
      meeting: ctx.extras?.meeting ?? null,
    },
  };
}

export function classifyMessage(
  input: ClassifyInput,
  senderOverride?: TriageAction | null,
  history?: MailHistory | null,
  extras?: ClassifyExtras,
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
  const ctx: Ctx = { signals, actionable, intel, extras };

  const result = classifyCore(input, senderOverride, ctx, {
    email,
    dom,
    local,
    blob,
    fromBlob,
  });

  // Contact protection: someone in your address book is never
  // auto-deleted or unsubscribed, whatever their mail looks like.
  if (
    extras?.inContacts &&
    (result.action === "delete_now" || result.action === "unsubscribe")
  ) {
    return hit(
      "read_and_archive",
      "MED",
      "In your contacts — protected from auto-delete",
      "contact-protect",
      ctx,
    );
  }

  return result;
}

function classifyCore(
  input: ClassifyInput,
  senderOverride: TriageAction | null | undefined,
  ctx: Ctx,
  parts: {
    email: string;
    dom: string;
    local: string;
    blob: string;
    fromBlob: string;
  },
): ClassifyResult {
  const { email, dom, local, blob, fromBlob } = parts;
  const { signals, actionable, extras } = ctx;

  if (senderOverride) {
    return hit(
      senderOverride,
      "HIGH",
      "You taught this sender",
      "override-taught-sender",
      ctx,
    );
  }

  // Calendar beats everything: you're about to meet this person
  if (extras?.meeting) {
    return hit(
      actionable ? "act_today" : "respond",
      "HIGH",
      `Upcoming meeting with them (${extras.meeting})`,
      "meeting-upcoming",
      ctx,
    );
  }

  // A contact with an ask is a person waiting on you
  if (extras?.inContacts && actionable) {
    return hit(
      "respond",
      "HIGH",
      "In your contacts with an actionable ask",
      "contact-actionable-respond",
      ctx,
    );
  }

  // Package carriers: status updates need nothing from you — the package
  // arrives either way. Only act when the delivery needs YOU.
  if (SHIPPER_DOMAINS.test(dom)) {
    if (
      DELIVERY_NEEDS_YOU.test(blob) ||
      DELIVERY_NEEDS_YOU.test(input.subject)
    ) {
      return hit(
        "act_today",
        "HIGH",
        "Carrier needs something from you (signature / pickup / failed delivery)",
        "shipper-needs-you",
        ctx,
      );
    }
    return hit(
      "delete_now",
      "HIGH",
      "Package status update — it arrives whether you read this or not",
      "shipper-status-delete",
      ctx,
    );
  }

  // Real transactional urgency — genuine even from noreply robots
  if (
    TRANSACTIONAL_URGENT.test(blob) ||
    TRANSACTIONAL_URGENT.test(input.subject)
  ) {
    return hit(
      "act_today",
      "MED",
      "Transactional time-sensitive (code / security / travel / delivery)",
      "transactional-urgent",
      ctx,
    );
  }

  // Urgency bait: only trusted senders get credit for "expires today"
  if (URGENCY_BAIT.test(blob) || URGENCY_BAIT.test(input.subject)) {
    const trusted =
      extras?.inContacts ||
      signals.relationship === "engaged" ||
      signals.relationship === "known";
    if (trusted) {
      return hit(
        "act_today",
        "MED",
        "Deadline language from a sender you know",
        "trusted-urgency",
        ctx,
      );
    }
    // Untrusted urgency = marketing costume. Bulk/noreply shape → bin it.
    if (
      signals.relationship === "bulk" ||
      NOREPLY.test(local) ||
      isMarketingShape(local, dom, blob)
    ) {
      return hit(
        "delete_now",
        "MED",
        "Fake urgency from a bulk sender — classic promo bait",
        "urgency-bait-delete",
        ctx,
      );
    }
    // Cold but not obviously bulk: fall through to the normal rules below
  }

  // Known product / finance / shopping before bulk-noreply relationship,
  // so GitHub/Vercel/etc. aren't hard-deleted just because local is noreply.
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
    // Receipts/invoices from product senders are records, not noise
    if (RECEIPT_BLOB.test(blob)) {
      return hit(
        "read_and_archive",
        "MED",
        "Receipt/statement — nothing to do, but worth keeping for search",
        "finance-record-archive",
        ctx,
      );
    }
    // Needs your hands: failed CI, review requested, mentioned, security
    if (PRODUCT_NEEDS_YOU.test(blob) || PRODUCT_NEEDS_YOU.test(input.subject)) {
      return hit(
        "act_today",
        "MED",
        "Product notification that needs you (failure / review / mention / security)",
        "product-needs-you",
        ctx,
      );
    }
    // Passive "it happened" noise: builds passed, stars, digests, likes
    return hit(
      "read_and_delete",
      "MED",
      "Passive product notification — it happened whether you read it or not",
      "product-passive-delete",
      ctx,
    );
  }

  if (FINANCE_DOMAINS.test(dom) || RECEIPT_BLOB.test(blob)) {
    // Money at risk needs you today — declined, fraud, overdue, locked
    if (FINANCE_RISK.test(blob) || FINANCE_RISK.test(input.subject)) {
      return hit(
        "act_today",
        "HIGH",
        "Money at risk — declined / fraud / overdue needs you now",
        "finance-needs-you",
        ctx,
      );
    }
    if (ANOMALY_BLOB.test(blob)) {
      return hit(
        "review_subscription",
        "MED",
        "Billing anomaly keywords",
        "finance-anomaly",
        ctx,
      );
    }
    // Receipts/statements are records: no action, but future value — archive
    return hit(
      "read_and_archive",
      "MED",
      "Receipt/statement — nothing to do, but worth keeping for search",
      "finance-record-archive",
      ctx,
    );
  }

  const humanHit = classifyByRelationship(ctx, email, blob);
  if (humanHit) return humanHit;

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
