export type MailSection =
  | "inbox"
  | "sent"
  | "trash"
  | "atlas"
  | "triage"
  | "settings";

const sections = new Set<MailSection>([
  "inbox",
  "sent",
  "trash",
  "atlas",
  "triage",
  "settings",
]);

export type MailHash = {
  section?: MailSection;
  conversation?: string;
  query?: string;
};

export function parseMailHash(hash: string): MailHash {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const section = params.get("section") as MailSection | null;
  return {
    section: section && sections.has(section) ? section : undefined,
    conversation: params.get("conversation") ?? undefined,
    query: params.get("q") ?? undefined,
  };
}

export function clearSearchState(section: MailSection) {
  return { section, query: "", conversation: null, rows: null };
}
