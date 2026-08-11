import type {
  ConversationRow,
  DeleteRow,
  InboxView,
  MatterCard,
} from "@/lib/v2/view/types";

/**
 * A representative view, shaped like the real account: work for one
 * counterparty spread across several parts of the business, a long tail of
 * disposable mail, and a handful the safety layer refused to delete.
 */

const functions = [
  "sales — leads",
  "sales — new requests",
  "sales — contracting",
  "marketing",
  "operations — studies",
  "quality",
  "systems (it)",
  "recruiting",
  "finance (ar/ap)",
];

let n = 0;
const row = (
  subject: string,
  from: string,
  summary: string,
  category: string,
  counterparty: string,
  hoursAgo = 5,
): ConversationRow => ({
  conversationId: `c${n++}`,
  providerConversationId: `p${n}`,
  subject,
  from,
  at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  summary,
  owner: "you",
  priority: 2,
  dueDate: null,
  category,
  counterparty,
  nativeUrl: "https://outlook.office.com/mail/",
});

const deletable = (r: ConversationRow): DeleteRow => ({
  ...r,
  deleteToken: `tok-${r.conversationId}`,
  vetoReasons: [],
});

const matter = (
  title: string,
  section: string,
  orgUnit: string,
  conversations: ConversationRow[],
  yieldLine?: string,
): MatterCard => ({
  matterId: `m${n++}`,
  title,
  status: "open",
  orgUnit,
  section,
  conversations,
  yields: yieldLine
    ? [
        {
          conversationId: conversations[0]?.conversationId ?? "",
          kind: "matter_connection",
          headline: yieldLine,
          detail: null,
          matterTitle: title,
        },
      ]
    : [],
});

const atlas: MatterCard[] = [
  matter(
    "Roche RD007704 Gabapentin stability extension",
    "operations — studies",
    "roche",
    [
      row(
        "RE: RMS Amendment #01 to SOW #003",
        "Sandra Yasavul",
        "Amendment needs countersignature before the extension starts.",
        "operations — studies",
        "Roche",
        3,
      ),
      row(
        "Stability pull schedule Q3",
        "Jodi Lorenz",
        "Pull points confirmed for August and September.",
        "operations — studies",
        "Roche",
        26,
      ),
    ],
    "Amendment awaiting your countersignature",
  ),
  matter(
    "Roche RCD_2904 Anti-TPO sample collection",
    "operations — studies",
    "roche",
    [
      row(
        "Project Update: RCD_2904 Anti-TPO",
        "Sandra Yasavul",
        "CRF and database due before 14 August.",
        "operations — studies",
        "Roche",
        8,
      ),
    ],
    "Deliverables due 14 August",
  ),
  matter(
    "Roche IgG plasma sourcing event",
    "sales — new requests",
    "roche",
    [
      row(
        "ACTION: Invitation to participate in event TZC0426",
        "Roche myBuy",
        "Bid response due through the sourcing portal by 31 August.",
        "sales — new requests",
        "Roche",
        12,
      ),
      row(
        "Response time revised for event Vitamin D2",
        "Roche myBuy",
        "Deadline moved to 30 August.",
        "sales — new requests",
        "Roche",
        30,
      ),
    ],
    "Bid due 31 August",
  ),
  matter(
    "Roche RDI phase 2 pricing",
    "sales — contracting",
    "roche",
    [
      row(
        "Phase 2 pricing schedule",
        "Akhila Kode",
        "Pricing schedule returned with two open line items.",
        "sales — contracting",
        "Roche",
        50,
      ),
    ],
  ),
  matter(
    "Roche Diagnostics PO acknowledgement P002003098",
    "finance (ar/ap)",
    "roche",
    [
      row(
        "PO acknowledgement P002003098",
        "Roche Vendor Portal",
        "Purchase order acknowledged; invoice on 30-day terms.",
        "finance (ar/ap)",
        "Roche",
        70,
      ),
    ],
  ),
  matter(
    "Advarra IRB ICF review — RCD_2850 Ju Dong Yang study",
    "quality",
    "advarra",
    [
      row(
        "CIRBI: Continuing Review 10 Day Notice",
        "no-reply@advarracloud.com",
        "Continuing review due in CIRBI before 19 August.",
        "quality",
        "Advarra",
        6,
      ),
    ],
    "Continuing review due 19 August",
  ),
  matter(
    "Canadian startup CRO monitoring lead",
    "sales — leads",
    "bizdevlabs",
    [
      row(
        "Intro — monitoring capacity",
        "Phillip Haarhoff",
        "Wants a call about monitoring capacity for a phase 1 study.",
        "sales — leads",
        "Bizdevlabs",
        20,
      ),
    ],
  ),
  matter(
    "Lucianne Hill EA recruiting process",
    "recruiting",
    "internal",
    [
      row(
        "EA candidate shortlist",
        "Amy Staedtler",
        "Three candidates ready for your first-round calls.",
        "recruiting",
        "Internal",
        9,
      ),
    ],
  ),
  matter(
    "Dashboard redesign",
    "systems (it)",
    "internal",
    [
      row(
        "Dashboard redesign scope",
        "Rob Ribelin",
        "Scope agreed; estimate to follow this week.",
        "systems (it)",
        "Internal",
        40,
      ),
    ],
  ),
  matter(
    "SCORR Lumos embedded awards quote",
    "marketing",
    "scorrmarketing",
    [
      row(
        "Embedded awards quote",
        "Renae Pacha",
        "Quote returned for the awards placement.",
        "marketing",
        "Scorrmarketing",
        60,
      ),
    ],
  ),
];

const safeToDelete: DeleteRow[] = [
  deletable(
    row(
      "Your Monthly Scribe Activity",
      "Scribe Team",
      "Automated product usage digest. Nothing to act on.",
      "systems (it)",
      "Scribe",
      4,
    ),
  ),
  deletable(
    row(
      "New candidates since August 6",
      "Workable",
      "Routine recruiting platform digest.",
      "recruiting",
      "Workable",
      7,
    ),
  ),
  deletable(
    row(
      "Weekly Usage Summary for RDI",
      "Vercel",
      "Infrastructure usage summary. No action.",
      "systems (it)",
      "Vercel",
      11,
    ),
  ),
  deletable(
    row(
      "Daily News: Grail Preparing for FDA Advisory Committee",
      "360Dx",
      "Industry newsletter, nothing specific to you.",
      "marketing",
      "360dx",
      14,
    ),
  ),
  deletable(
    row(
      "ej@rditrials.com accepted your group invite",
      "Dashlane",
      "System notification confirming a completed action.",
      "systems (it)",
      "Dashlane",
      18,
    ),
  ),
];

const undecided: ConversationRow[] = [
  row(
    "Missed you — ADLM",
    "Zeke Misner",
    "Networking follow-up from a vendor; no active matter.",
    "sales — leads",
    "Medixteam",
    22,
  ),
  row(
    "Resume of a friend's niece",
    "Sadanand Palekar",
    "Personal referral for a candidate.",
    "recruiting",
    "Other",
    28,
  ),
  row(
    "Notice of Cepheid Information Security Terms",
    "Amy Staedtler",
    "Needs a decision on who leads the response.",
    "quality",
    "Internal",
    33,
  ),
];

const records: ConversationRow[] = [
  row(
    "Invoice 4471 — paid",
    "QuickBooks",
    "Payment confirmation; keep for the record.",
    "finance (ar/ap)",
    "Intuit",
    16,
  ),
  row(
    "Executed NDA — Sekisui",
    "Robert Acorn",
    "Countersigned NDA returned.",
    "sales — contracting",
    "Sekisuidiagnostics",
    44,
  ),
];

export const sampleView: InboxView = {
  asOf: new Date().toISOString(),
  coverage: { providerTotal: 439, stored: 354, read: 354, pending: 0 },
  atlas,
  sections: functions
    .map((name) => ({
      name,
      matters: atlas.filter((m) => m.section === name),
    }))
    .filter((s) => s.matters.length > 0),
  functions,
  records,
  safeToDelete,
  undecided,
  worthReading: [],
};
