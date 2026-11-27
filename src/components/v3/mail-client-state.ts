import type { MailboxSort } from "@/lib/v3/mailbox/types";

export type MailSection = "inbox" | "sent" | "trash" | "settings";

const sections = new Set<MailSection>(["inbox", "sent", "trash", "settings"]);

/**
 * Places that no longer exist. Triage, Cards and Atlas were collapsed into the
 * Inbox, so a bookmark or a link from an old session lands there instead of on
 * a blank page.
 */
const retiredSections = new Set(["triage", "cards", "atlas"]);

function sectionFromHash(value: string | null): MailSection | undefined {
  if (!value) return undefined;
  if (sections.has(value as MailSection)) return value as MailSection;
  return retiredSections.has(value) ? "inbox" : undefined;
}

export type MailHash = {
  section?: MailSection;
  conversation?: string;
  query?: string;
  sort?: MailboxSort;
};

export function parseMailHash(hash: string): MailHash {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const sort = params.get("sort");
  return {
    section: sectionFromHash(params.get("section")),
    conversation: params.get("conversation") ?? undefined,
    query: params.get("q") ?? undefined,
    sort:
      sort === "date" || sort === "triage" || sort === "focus" || sort === "matter"
        ? sort
        : undefined,
  };
}

export function clearSearchState(section: MailSection) {
  return { section, query: "", conversation: null, rows: null };
}

export function modalBackgroundState({
  isMobile,
  conversationId,
  composing,
}: {
  isMobile: boolean;
  conversationId: string | null;
  composing: boolean;
}) {
  const modalOpen = Boolean(conversationId || composing);
  return { modalOpen, backgroundInert: isMobile && modalOpen };
}
