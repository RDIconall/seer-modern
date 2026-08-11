export type MailboxCursor = {
  at: string;
  id: string;
};

export function encodeMailboxCursor(cursor: MailboxCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeMailboxCursor(before?: string | null): MailboxCursor | null {
  if (!before) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(before, "base64url").toString("utf8"),
    ) as Partial<MailboxCursor>;
    if (typeof parsed.at !== "string" || typeof parsed.id !== "string") return null;
    return { at: parsed.at, id: parsed.id };
  } catch {
    return null;
  }
}
