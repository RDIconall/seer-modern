import type { Digest, Matter } from "@/lib/inbox/matters";
import type { Understanding } from "@/lib/inbox/understanding";

export type MatterCandidate = {
  title: string;
  why: string;
  orgUnit: string;
  emailIds: string[];
};

type FiledCandidateInput = {
  emailId: string;
  threadId: string;
  orgUnit: string;
  line: string;
  messageIds?: string[];
};

/**
 * A deep read said this is ongoing work that the clustering pass did not
 * place. The read wins: this becomes a matter on the board rather than a
 * question in Triage.
 */
export function matterCandidateFor(
  row: FiledCandidateInput,
  understanding?: Understanding,
): MatterCandidate | null {
  if (
    !understanding ||
    understanding.disposition !== "matter"
  ) {
    return null;
  }
  const title =
    understanding.matterTitle?.trim() ||
    understanding.oneLine?.trim() ||
    row.line.trim();
  if (!title) return null;
  return {
    title: title.slice(0, 100),
    why:
      understanding.matterWhy?.trim() ||
      understanding.oneLine ||
      row.line,
    orgUnit: row.orgUnit,
    emailIds:
      row.messageIds?.length ? [...new Set(row.messageIds)] : [row.emailId],
  };
}

/**
 * Turn a promoted read into a real matter. One conversation, one matter —
 * the clustering pass merges it with its siblings on the next rebuild if
 * they belong together.
 */
export function matterFromRead(input: {
  matterId: string;
  candidate: MatterCandidate;
  row: {
    emailId: string;
    threadId: string;
    from: string;
    fromEmail?: string;
    subject?: string;
    line: string;
    suggestion?: string;
    subUnit?: string;
    at?: string;
    count?: number;
  };
  understanding?: Understanding;
  /** Set when this thread was closed before and new mail brought it back. */
  reopenedBecause?: string;
  at: string;
}): Matter {
  const { candidate, row, understanding: u } = input;
  const ask = u?.ask?.trim();
  return {
    id: input.matterId,
    title: candidate.title,
    category: "read",
    orgUnit: candidate.orgUnit,
    ...(row.subUnit ? { subUnit: row.subUnit } : {}),
    orgConfidence: 0.7,
    people: [],
    narrative: candidate.why,
    nextAction:
      ask && !/^nothing/i.test(ask) ? ask.slice(0, 80) : "none — yours to define",
    owner: u?.owner ?? "you",
    urgency: Math.min(3, Math.max(1, u?.importance ?? 2)),
    status: input.reopenedBecause
      ? "reopened"
      : u?.owner === "them"
        ? "waiting"
        : "active",
    ...(input.reopenedBecause ? { statusWhy: input.reopenedBecause } : {}),
    emails: [
      {
        id: row.emailId,
        threadId: row.threadId,
        from: row.from,
        ...(row.fromEmail ? { fromEmail: row.fromEmail } : {}),
        ...(row.subject ? { subject: row.subject } : {}),
        line: row.line,
        suggestion: row.suggestion ?? "Your call",
        ...(row.at ? { at: row.at } : {}),
        ...(row.count && row.count > 1 ? { count: row.count } : {}),
      },
    ],
    emailIds: candidate.emailIds,
    threadIds: [row.threadId],
    updatedAt: input.at,
  };
}

/**
 * ONE ROW, ONE HOME.
 *
 * The digest is decided per MESSAGE, but a matter owns a whole CONVERSATION.
 * A thread carrying live work plus one "FYI" reply therefore showed up in
 * Atlas as a matter and again in Triage's delete list. A thread with a home
 * in Atlas is not in Triage, whatever its individual messages say.
 */
export function digestWithoutHomedThreads(
  digest: Digest,
  homedThreads: Set<string>,
  threadOfMessage: Map<string, string>,
): Digest {
  const homed = (threadId?: string) =>
    Boolean(threadId && homedThreads.has(threadId));
  return {
    summary: digest.summary,
    themes: digest.themes
      .map((theme) => ({
        ...theme,
        emailIds: theme.emailIds.filter(
          (id) => !homed(threadOfMessage.get(id)),
        ),
        items: theme.items?.filter((item) => !homed(item.threadId)),
      }))
      .filter((theme) => theme.emailIds.length > 0),
  };
}

/** Resolve one digest category to the thread-aware rows the bulk API needs. */
export function digestThemeRows(
  theme: { emailIds: string[] },
  all: { id: string; threadId: string }[],
): { id: string; threadId: string }[] {
  const wanted = new Set(theme.emailIds);
  return all.filter((row) => wanted.has(row.id));
}
