import type { Conversation, ProviderKind } from "@/lib/v2/providers/types";
import type { MailboxFolder, MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import type { MailClientPreview } from "@/components/v3/MailClient";
import { sampleView } from "./sample";

const previewRows: Record<MailboxFolder, MailboxRow[]> = {
  inbox: [
    {
      conversationId: "preview-c-delete",
      providerConversationId: "preview-p-delete",
      senderDisplayName: "Scribe Team",
      subject: "Your Monthly Scribe Activity",
      timestamp: "2026-08-08T08:00:00.000Z",
      isUnread: false,
      snippet: "Automated product usage digest.",
      attachments: [],
      decisionSummary: "Routine vendor digest",
      priority: null,
      dueDate: null,
      matterTitle: null,
      disposition: "delete",
      owner: "nobody",
      deleteRank: 0,
      deleteToken: "preview-delete-token",
      category: "IT & software notices",
      vetoReasons: [],
    },
    {
      conversationId: "preview-c-record",
      providerConversationId: "preview-p-record",
      senderDisplayName: "Billing Desk",
      subject: "Invoice received — keep for records",
      timestamp: "2026-08-09T12:00:00.000Z",
      isUnread: false,
      snippet: "Paid invoice confirmation for the archive.",
      attachments: ["invoice.pdf"],
      decisionSummary: "Keep for the record",
      priority: null,
      dueDate: null,
      matterTitle: null,
      disposition: "record",
      owner: "nobody",
      deleteRank: 1,
      deleteToken: null,
      category: "finance (ar/ap)",
      vetoReasons: [],
    },
    {
      // The referral the reader proposed to bin and safety refused. It sits in
      // "Needs you" and puts the held-back note under the clear pile.
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
      dueDate: null,
      matterTitle: null,
      disposition: "undecided",
      owner: "you",
      deleteRank: 2,
      deleteToken: null,
      category: "recruiting",
      vetoReasons: ["personal_greeting"],
    },
    {
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
      matterTitle: "Roche RD007704 stability extension",
      disposition: "matter",
      owner: "you",
      deleteRank: 3,
      deleteToken: null,
      category: "sales — contracting",
      vetoReasons: [],
    },
    {
      conversationId: "preview-c-2",
      providerConversationId: "preview-p-2",
      senderDisplayName: "Amy Staedtler",
      subject: "Dashboard redesign scope",
      timestamp: "2026-08-11T11:10:00.000Z",
      isUnread: false,
      snippet: "Scope agreed; estimate to follow this week.",
      attachments: [],
      decisionSummary: "Estimate to follow",
      priority: 1,
      dueDate: null,
      matterTitle: "Dashboard redesign",
      disposition: "matter",
      owner: "you",
      deleteRank: 3,
      deleteToken: null,
      category: "systems (it)",
      vetoReasons: [],
    },
    {
      conversationId: "preview-c-3",
      providerConversationId: "preview-p-3",
      senderDisplayName: "Advarra IRB",
      subject: "CIRBI: Continuing Review 10 Day Notice",
      timestamp: "2026-08-10T09:40:00.000Z",
      isUnread: true,
      snippet: "Continuing review due in CIRBI before 19 August.",
      attachments: [],
      decisionSummary: "Review due 19 August",
      priority: 3,
      dueDate: "2026-08-19",
      matterTitle: "Advarra ICF review",
      disposition: "pending",
      owner: "nobody",
      deleteRank: 4,
      deleteToken: null,
      category: "quality",
      vetoReasons: [],
    },
  ],
  sent: [
    {
      conversationId: "preview-c-4",
      providerConversationId: "preview-p-4",
      senderDisplayName: "You",
      subject: "Re: Stability pull schedule Q3",
      timestamp: "2026-08-09T16:00:00.000Z",
      isUnread: false,
      snippet: "Thanks — August and September pull points are confirmed.",
      attachments: [],
      decisionSummary: null,
      priority: null,
      dueDate: null,
      matterTitle: null,
      disposition: "pending",
      owner: "nobody",
      deleteRank: 4,
      deleteToken: null,
      category: null,
      vetoReasons: [],
    },
  ],
  trash: [
    {
      conversationId: "preview-c-5",
      providerConversationId: "preview-p-5",
      senderDisplayName: "Scribe Team",
      subject: "Your Monthly Scribe Activity",
      timestamp: "2026-08-08T08:00:00.000Z",
      isUnread: false,
      snippet: "Automated product usage digest.",
      attachments: [],
      decisionSummary: null,
      priority: null,
      dueDate: null,
      matterTitle: null,
      disposition: "delete",
      owner: "nobody",
      deleteRank: 0,
      deleteToken: null,
      category: null,
      vetoReasons: [],
    },
  ],
};

const view = (
  folder: MailboxFolder,
  sort: MailboxView["sort"] = "date",
): MailboxView => {
  // Production removes model-confirmed matters from Triage because they are
  // already on Atlas. Keep the preview honest to that contract.
  const rows =
    sort === "triage"
      ? previewRows[folder]
          .filter((row) => row.disposition !== "matter")
          .map((row) =>
            row.disposition === "undecided" || row.disposition === "pending"
              ? {
                  ...row,
                  disposition: "record" as const,
                  deleteRank: 1,
                }
              : row,
          )
      : previewRows[folder];
  return {
    accountId: "preview",
    folder,
    sort,
    rows,
    total: rows.length,
    needsYou: 0,
    processing: 0,
    nextCursor: null,
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

/** Inbox ordered as the triage sort returns it — most likely to delete first. */
export const v3TriageInboxView: MailboxView = view("inbox", "triage");

export const v3Preview: MailClientPreview = {
  mailbox: {
    inbox: view("inbox"),
    sent: view("sent"),
    trash: view("trash"),
  },
  triageInbox: v3TriageInboxView,
  inboxView: sampleView,
  reader: { conversation: reader, provider },
};
