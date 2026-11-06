import type { MailboxSort } from "@/lib/v3/mailbox/types";

export type MailSection =
  | "inbox"
  | "triage"
  | "cards"
  | "sent"
  | "trash"
  | "atlas"
  | "settings";

const sections = new Set<MailSection>([
  "inbox",
  "triage",
  "cards",
  "sent",
  "trash",
  "atlas",
  "settings",
]);

export type AtlasHashLens = "board" | "mail" | "bots";

export type MailHash = {
  section?: MailSection;
  conversation?: string;
  query?: string;
  sort?: MailboxSort;
  atlas?: AtlasHashLens;
};

export function parseMailHash(hash: string): MailHash {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const section = params.get("section") as MailSection | null;
  const sort = params.get("sort");
  const atlas = params.get("atlas");
  return {
    section: section && sections.has(section) ? section : undefined,
    conversation: params.get("conversation") ?? undefined,
    query: params.get("q") ?? undefined,
    sort: sort === "date" || sort === "triage" || sort === "focus" ? sort : undefined,
    atlas:
      atlas === "board" || atlas === "mail" || atlas === "bots" ? atlas : undefined,
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
