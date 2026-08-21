export type StoredDraft = {
  recipients: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  savedAt: string;
};

export function draftStorageKey(
  accountId: string | undefined,
  mode: string,
  conversationId?: string,
): string {
  return ["seer:draft", accountId || "active", mode, conversationId]
    .filter((part): part is string => Boolean(part))
    .map((part, index) => (index < 3 ? part : encodeURIComponent(part)))
    .join(":");
}

export function parseStoredDraft(value: string | null): StoredDraft | null {
  if (!value) return null;
  try {
    const draft = JSON.parse(value) as Partial<StoredDraft>;
    if (
      !Array.isArray(draft.recipients) ||
      !draft.recipients.every((email) => typeof email === "string") ||
      typeof draft.subject !== "string" ||
      typeof draft.bodyHtml !== "string" ||
      typeof draft.bodyText !== "string" ||
      typeof draft.savedAt !== "string"
    ) {
      return null;
    }
    return draft as StoredDraft;
  } catch {
    return null;
  }
}
