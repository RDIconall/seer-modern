import type { Brief, Matter } from "@/lib/inbox/matters";

type Row = {
  placement: string;
  group: string;
  category: string;
  orgUnit: string;
  subUnit: string;
  /** Native sender display name, from the provider */
  fromName: string;
  /** Native sender address, from the provider */
  fromEmail: string;
  /** Native message subject, from the provider */
  subject: string;
  /** Seer's one-line read of the conversation */
  summary: string;
  nextAction: string;
  disposition: string;
  owner: string;
  messages: number;
  lastAt: string;
  threadId: string;
  messageId: string;
};

/** "Anna Roche — pricing" → "Anna Roche". A filed line leads with the sender. */
function nameFromLine(line: string): string {
  const dash = line.indexOf(" — ");
  return (dash > -1 ? line.slice(0, dash) : "").trim();
}

/** The function a matter or record rolls up to, e.g. "sales — leads" → "sales". */
function categoryRoot(orgUnit: string, functions: string[]): string {
  const lower = (orgUnit ?? "").toLowerCase();
  let best = "";
  for (const f of functions) {
    const fl = f.toLowerCase();
    if ((lower === fl || lower.startsWith(`${fl} —`)) && fl.length > best.length) {
      best = f;
    }
  }
  return best || orgUnit || "unsorted";
}

function csvCell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Every conversation in the inbox and where the app put it — one row per
 * CONVERSATION, which is the unit Seer reasons in, with its message count so
 * the totals reconcile with the dashboard.
 *
 * Built entirely from the stored brief, so it never calls the mail provider
 * and cannot time out.
 */
export function buildExportRows(
  brief: Brief,
  understanding: Record<string, { disposition?: string; owner?: string }> = {},
): Row[] {
  const functions = brief.functions ?? [];
  const rows: Row[] = [];
  const readOf = (id: string) => understanding[id];

  const matterRows = (matter: Matter, placement: string) => {
    const category = categoryRoot(matter.orgUnit, functions);
    const conversations = matter.emails?.length
      ? matter.emails
      : matter.threadIds.map((threadId) => ({
          id: "",
          threadId,
          from: "",
          fromEmail: "" as string | undefined,
          subject: "" as string | undefined,
          line: "",
          suggestion: "",
          at: "",
          count: undefined as number | undefined,
        }));
    for (const c of conversations) {
      const u = c.id ? readOf(c.id) : undefined;
      rows.push({
        placement,
        group: matter.title,
        category,
        orgUnit: matter.orgUnit,
        subUnit: matter.subUnit ?? "",
        fromName: c.from ?? "",
        fromEmail: c.fromEmail ?? "",
        subject: c.subject ?? "",
        summary: c.line ?? "",
        nextAction: c.suggestion || matter.nextAction || "",
        disposition: u?.disposition ?? "",
        owner: matter.owner ?? "",
        messages: c.count ?? 1,
        lastAt: c.at ?? matter.updatedAt ?? "",
        threadId: c.threadId,
        messageId: c.id ?? "",
      });
    }
  };

  for (const matter of brief.pinned ?? []) matterRows(matter, "Atlas — matter");
  for (const matter of brief.matters) matterRows(matter, "Atlas — matter");

  for (const row of brief.filed ?? []) {
    const u = readOf(row.emailId);
    rows.push({
      placement: "Triage — close out",
      group: categoryRoot(row.orgUnit, functions),
      category: categoryRoot(row.orgUnit, functions),
      orgUnit: row.orgUnit,
      subUnit: row.subUnit ?? "",
      fromName: row.fromName ?? nameFromLine(row.line),
      fromEmail: row.fromEmail ?? "",
      subject: row.subject ?? "",
      summary: row.line,
      nextAction: row.suggestion ?? "",
      disposition: u?.disposition ?? "",
      owner: u?.owner ?? "",
      messages: row.count ?? 1,
      lastAt: row.at ?? "",
      threadId: row.threadId,
      messageId: row.emailId,
    });
  }

  for (const theme of brief.digest?.themes ?? []) {
    const items =
      theme.items?.length
        ? theme.items
        : theme.emailIds.map((id) => ({
            id,
            threadId: "",
            line: "",
            at: "",
            fromName: undefined as string | undefined,
            fromEmail: undefined as string | undefined,
            subject: undefined as string | undefined,
          }));
    for (const item of items) {
      const u = readOf(item.id);
      rows.push({
        placement: "Triage — delete",
        group: theme.theme,
        category: "triage",
        orgUnit: "",
        subUnit: "",
        fromName: item.fromName ?? "",
        fromEmail: item.fromEmail ?? "",
        subject: item.subject ?? "",
        summary: item.line || theme.line,
        nextAction: "Delete",
        disposition: u?.disposition ?? "",
        owner: u?.owner ?? "",
        messages: 1,
        lastAt: item.at ?? "",
        threadId: item.threadId,
        messageId: item.id,
      });
    }
  }

  return rows;
}

const HEADERS: { key: keyof Row; label: string }[] = [
  { key: "placement", label: "Placement" },
  { key: "group", label: "Matter or category" },
  { key: "category", label: "Function" },
  { key: "orgUnit", label: "Org unit" },
  { key: "subUnit", label: "Sub unit" },
  { key: "fromName", label: "From name" },
  { key: "fromEmail", label: "From email" },
  { key: "subject", label: "Subject" },
  { key: "summary", label: "What it is" },
  { key: "nextAction", label: "Next action" },
  { key: "disposition", label: "Deep read" },
  { key: "owner", label: "Owner" },
  { key: "messages", label: "Messages" },
  { key: "lastAt", label: "Last message" },
  { key: "threadId", label: "Thread id" },
  { key: "messageId", label: "Message id" },
];

export function toCsv(rows: Row[]): string {
  const lines = [HEADERS.map((h) => csvCell(h.label)).join(",")];
  for (const row of rows) {
    lines.push(HEADERS.map((h) => csvCell(row[h.key])).join(","));
  }
  return lines.join("\r\n");
}
