import type { MatterCard } from "../view/types";
import type { StaffTask } from "../staff/types";
import type { WhiteboardCatalogEntry } from "./types";

/**
 * Conall's CEO Whiteboard headings, in the order he already uses in OneNote.
 * Due Now is a time bucket; the rest are parts of the business.
 */
export const WHITEBOARD_CATALOG: readonly WhiteboardCatalogEntry[] = [
  { slug: "due-now", title: "Due Now", subtitle: "This week", sortOrder: 10 },
  { slug: "cash-lender", title: "Cash + Lender", subtitle: null, sortOrder: 20 },
  { slug: "sales-marketing", title: "Sales + Marketing", subtitle: null, sortOrder: 30 },
  { slug: "board", title: "Board", subtitle: null, sortOrder: 40 },
  { slug: "ops", title: "Ops", subtitle: "Lara owns", sortOrder: 50 },
  { slug: "company-future", title: "Company Future", subtitle: null, sortOrder: 60 },
  { slug: "contracts", title: "Contracts", subtitle: null, sortOrder: 70 },
  { slug: "security", title: "Security", subtitle: null, sortOrder: 80 },
  { slug: "relationships", title: "Relationships", subtitle: "Monthly", sortOrder: 90 },
  { slug: "done", title: "Done", subtitle: null, sortOrder: 100 },
];

export const WHITEBOARD_SLUGS = WHITEBOARD_CATALOG.map((entry) => entry.slug);

const DUE_SOON_MS = 7 * 86_400_000;

/**
 * Map an Atlas matter section (the brain's function name) onto a CEO domain.
 * Unmapped sections (newsletters, vendor mail) stay on the Mail lens only.
 */
export function mapMatterSectionToDomain(section: string): string | null {
  const name = section.trim().toLowerCase();
  if (!name) return null;
  if (name === "unfiled") return null;
  if (/(newsletter|vendor mail|promotions?|social)/.test(name)) return null;
  if (/(board|investor)/.test(name)) return "board";
  if (/(contract|legal|msa|sow|cda|loi)/.test(name)) return "contracts";
  if (/(sales|marketing|lead|outreach|proposal|bid)/.test(name)) {
    return "sales-marketing";
  }
  if (/(finance|cash|lender|ar\/ap|accounts receivable|accounts payable)/.test(name)) {
    return "cash-lender";
  }
  if (/(recruit|hr\b|people|talent|future)/.test(name)) return "company-future";
  if (/(security|phishing|password|systems \(it\)|it & software)/.test(name)) {
    return "security";
  }
  if (/(relationship|vip)/.test(name)) return "relationships";
  if (/(ops|operation|quality|study|studies|regulatory|irb)/.test(name)) {
    return "ops";
  }
  return null;
}

/**
 * Default domain for a named bot. Chief of staff is the generalist and stays
 * unmapped unless the row itself carries `whiteboard_slug`.
 */
export function mapBotSlugToDomain(slug: string): string | null {
  switch (slug.trim().toLowerCase()) {
    case "growth":
    case "site-outreach":
    case "proposals-bids":
      return "sales-marketing";
    case "recruiter":
    case "personal-chief-of-staff":
      return "company-future";
    case "it-admin":
      return "security";
    case "snak-bot":
      return "ops";
    default:
      return null;
  }
}

export function domainForMatter(matter: MatterCard): string | null {
  return mapMatterSectionToDomain(matter.section);
}

export function domainForTask(task: Pick<StaffTask, "botSlug" | "whiteboardSlug">): string | null {
  const pinned = task.whiteboardSlug?.trim();
  if (pinned && WHITEBOARD_SLUGS.includes(pinned)) return pinned;
  return mapBotSlugToDomain(task.botSlug);
}

export function isDueSoon(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  return at <= now + DUE_SOON_MS;
}

export function catalogEntry(slug: string): WhiteboardCatalogEntry | null {
  return WHITEBOARD_CATALOG.find((entry) => entry.slug === slug) ?? null;
}
