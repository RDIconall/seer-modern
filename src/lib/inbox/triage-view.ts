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
 * A deep read said this is ongoing work, but the clustering pass did not
 * place it in a matter. Triage surfaces that disagreement as one decision:
 * make the suggested matter, or leave it filed.
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

/** Resolve one digest category to the thread-aware rows the bulk API needs. */
export function digestThemeRows(
  theme: { emailIds: string[] },
  all: { id: string; threadId: string }[],
): { id: string; threadId: string }[] {
  const wanted = new Set(theme.emailIds);
  return all.filter((row) => wanted.has(row.id));
}
