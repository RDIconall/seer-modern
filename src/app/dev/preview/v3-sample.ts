import type { Conversation, ProviderKind } from "@/lib/v2/providers/types";
import type { MailboxFolder, MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import type { MailClientPreview } from "@/components/v3/MailClient";
import { nextStepFor } from "@/lib/v3/mailbox/next-step";

type Seed = Omit<
  MailboxRow,
  "matterId" | "nextStep" | "groupKey" | "groupAt" | "matterTitle"
> & {
  matterId?: string | null;
  matterTitle?: string | null;
  ask?: string | null;
  userStep?: string | null;
  /** When the oldest conversation in this row's group arrived. */
  groupAt?: string;
};

const row = ({ matterId = null, matterTitle = null, ask = null, userStep = null, groupAt, ...rest }: Seed): MailboxRow => ({
  ...rest,
  matterId,
  matterTitle,
  nextStep: nextStepFor({
    disposition: rest.disposition,
    matterId,
    ask,
    summary: rest.decisionSummary,
    userStep,
  }),
  groupKey: matterId ? `m:${matterId}` : `c:${rest.conversationId}`,
  groupAt: groupAt ?? rest.timestamp,
});

const base = {
  isUnread: false,
  attachments: [] as string[],
  priority: null,
  dueDate: null,
  owner: "nobody" as const,
  deleteToken: null,
  vetoReasons: [] as string[],
};

const ROCHE = "preview-matter-roche";
const DASHBOARD = "preview-matter-dashboard";

const previewRows: Record<MailboxFolder, MailboxRow[]> = {
  // Oldest matter first, the way the Inbox is read.
  inbox: [
    row({
      ...base,
      conversationId: "preview-c-1",
      providerConversationId: "preview-p-1",
      senderDisplayName: "Sandra Yasavul",
      subject: "RMS Amendment #01 to SOW #003",
      timestamp: "2026-08-11T15:20:00.000Z",
      isUnread: true,
      snippet: "The countersignature is the last item before the extension starts.",
      attachments: ["amendment.pdf"],
      decisionSummary: "Countersignature needed",
      priority: 2,
      dueDate: "2026-08-14",
      matterId: ROCHE,
      matterTitle: "Roche RD007704 stability extension",
      ask: "Countersign RMS Amendment #01 and return it to Roche",
      disposition: "matter",
      owner: "you",
      deleteRank: 3,
      category: "sales — contracting",
      groupAt: "2026-08-04T09:00:00.000Z",
    }),
    row({
      ...base,
      conversationId: "preview-c-1b",
      providerConversationId: "preview-p-1b",
      senderDisplayName: "Sandra Yasavul",
      subject: "SOW #003 draft for review",
      timestamp: "2026-08-04T09:00:00.000Z",
      snippet: "Draft SOW attached.",
      attachments: ["sow-003.docx"],
      decisionSummary: "Draft SOW sent",
      matterId: ROCHE,
      matterTitle: "Roche RD007704 stability extension",
      ask: "Countersign RMS Amendment #01 and return it to Roche",
      disposition: "matter",
      deleteRank: 3,
      category: "sales — contracting",
      groupAt: "2026-08-04T09:00:00.000Z",
    }),
    row({
      ...base,
      conversationId: "preview-c-2",
      providerConversationId: "preview-p-2",
      senderDisplayName: "Amy Staedtler",
      subject: "Dashboard redesign scope",
      timestamp: "2026-08-11T11:10:00.000Z",
      snippet: "Scope agreed; estimate to follow this week.",
      decisionSummary: "Estimate to follow",
      priority: 1,
      matterId: DASHBOARD,
      matterTitle: "Dashboard redesign",
      userStep: "Send Amy the estimate by Friday",
      disposition: "matter",
      owner: "you",
      deleteRank: 3,
      category: "systems (it)",
      groupAt: "2026-08-06T14:30:00.000Z",
    }),
    row({
      ...base,
      conversationId: "preview-c-2b",
      providerConversationId: "preview-p-2b",
      senderDisplayName: "Amy Staedtler",
      subject: "Dashboard redesign kickoff",
      timestamp: "2026-08-06T14:30:00.000Z",
      snippet: "Kicking off the redesign.",
      decisionSummary: "Kickoff",
      matterId: DASHBOARD,
      matterTitle: "Dashboard redesign",
      userStep: "Send Amy the estimate by Friday",
      disposition: "matter",
      deleteRank: 3,
      category: "systems (it)",
      groupAt: "2026-08-06T14:30:00.000Z",
    }),
    row({
      // The referral the reader proposed to bin and safety refused. It is
      // proposed for Archive, and the confirmation warns if it is switched to
      // Delete.
      ...base,
      conversationId: "preview-c-held",
      providerConversationId: "preview-p-held",
      senderDisplayName: "Sadanand Palekar",
      subject: "Resume of a friend's niece",
      timestamp: "2026-08-07T10:57:00.000Z",
      isUnread: true,
      snippet: "Hi Conall, this is Rachel's Dad.",
      attachments: ["Zaina Sen Resume.pdf"],
      decisionSummary: "Referring a biostatistician. Asks if you can help.",
      priority: 2,
      disposition: "undecided",
      owner: "you",
      deleteRank: 2,
      category: "recruiting",
      vetoReasons: ["personal_greeting"],
    }),
    row({
      ...base,
      conversationId: "preview-c-delete",
      providerConversationId: "preview-p-delete",
      senderDisplayName: "Scribe Team",
      subject: "Your Monthly Scribe Activity",
      timestamp: "2026-08-08T08:00:00.000Z",
      snippet: "Automated product usage digest.",
      decisionSummary: "Routine vendor digest",
      disposition: "delete",
      deleteRank: 0,
      deleteToken: "preview-delete-token",
      category: "IT & software notices",
    }),
    row({
      ...base,
      conversationId: "preview-c-record",
      providerConversationId: "preview-p-record",
      senderDisplayName: "Billing Desk",
      subject: "Invoice received — keep for records",
      timestamp: "2026-08-09T12:00:00.000Z",
      snippet: "Paid invoice confirmation for the archive.",
      attachments: ["invoice.pdf"],
      decisionSummary: "Paid invoice, keep for the record",
      disposition: "record",
      deleteRank: 1,
      category: "finance (ar/ap)",
    }),
  ],
  sent: [
    row({
      ...base,
      conversationId: "preview-c-4",
      providerConversationId: "preview-p-4",
      senderDisplayName: "You",
      subject: "Re: Stability pull schedule Q3",
      timestamp: "2026-08-09T16:00:00.000Z",
      snippet: "Thanks — August and September pull points are confirmed.",
      decisionSummary: null,
      disposition: "pending",
      deleteRank: 4,
      category: null,
    }),
  ],
  trash: [
    row({
      ...base,
      conversationId: "preview-c-5",
      providerConversationId: "preview-p-5",
      senderDisplayName: "Scribe Team",
      subject: "Your Monthly Scribe Activity",
      timestamp: "2026-08-08T08:00:00.000Z",
      snippet: "Automated product usage digest.",
      decisionSummary: null,
      disposition: "delete",
      deleteRank: 0,
      category: null,
    }),
  ],
};

const view = (
  folder: MailboxFolder,
  sort: MailboxView["sort"] = "date",
): MailboxView => {
  const rows = previewRows[folder];
  return {
    accountId: "preview",
    folder,
    sort,
    rows,
    total: rows.length,
    needsYou: 0,
    processing: 0,
    nextCursor: null,
    ...(sort === "matter"
      ? { groups: new Set(rows.map((entry) => entry.groupKey)).size }
      : {}),
  };
};

const reader: Conversation = {
  providerConversationId: "preview-p-1",
  subject: "RMS Amendment #01 to SOW #003",
  lastMessageAt: "2026-08-11T15:20:00.000Z",
  messages: [
    {
      providerMessageId: "preview-m-1",
      from: { name: "Sandra Yasavul", email: "sandra@example.com" },
      to: [{ name: "You", email: "you@example.com" }],
      cc: [],
      sentAt: "2026-08-11T15:20:00.000Z",
      snippet: "The countersignature is the last item before the extension starts.",
      bodyHtml:
        "<p>Hi there,</p><p>The countersignature is the last item before the extension starts. Could you review the attached amendment?</p><p>Best,<br />Sandra</p>",
      bodyText:
        "Hi there,\n\nThe countersignature is the last item before the extension starts. Could you review the attached amendment?\n\nBest,\nSandra",
      isUnread: true,
      isOutgoing: false,
      attachments: [
        {
          id: "preview-attachment",
          filename: "amendment.pdf",
          mimeType: "application/pdf",
          sizeBytes: 120_000,
        },
      ],
    },
    {
      providerMessageId: "preview-m-2",
      from: { name: "You", email: "you@example.com" },
      to: [{ name: "Sandra Yasavul", email: "sandra@example.com" }],
      cc: [],
      sentAt: "2026-08-11T16:05:00.000Z",
      snippet: "I will review and sign this today.",
      bodyHtml: "<p>I will review and sign this today.</p>",
      bodyText: "I will review and sign this today.",
      isUnread: false,
      isOutgoing: true,
      attachments: [],
    },
  ],
};

const provider: ProviderKind = "microsoft";

export const v3Preview: MailClientPreview = {
  mailbox: {
    inbox: view("inbox", "matter"),
    sent: view("sent"),
    trash: view("trash"),
  },
  reader: { conversation: reader, provider },
};
