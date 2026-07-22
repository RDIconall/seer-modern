import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * THE PERSONAL DATABASE — the people axis of triage.
 *
 * Every sender resolves to a tier:
 * - inner:        you write to them / they're in contacts / you're
 *                 meeting them — they matter, historically proven
 * - known:        writes to you repeatedly, human-shaped, no outbound yet
 * - new-credible: no history, but the AI read the full email and judged
 *                 a real, credible person (specific ask, real project,
 *                 mutual context — not a template blast)
 * - machine:      automated sender — notifications, marketing, robots
 *
 * Local evidence decides most senders for free; the AI judges only the
 * genuinely unknown, once, and the verdict is stored here forever
 * (self-correcting: outbound mail later promotes anyone to inner).
 */

export type PersonTier = "inner" | "known" | "new-credible" | "machine";

export type PersonRecord = {
  email: string;
  name?: string;
  tier: PersonTier;
  /** Pinned by the user: top of the hierarchy, never auto-handled down */
  vip?: boolean;
  /** Why (AI verdict for new senders, evidence tag for local calls) */
  reason?: string;
  /** Who decided: local evidence, the AI's full-text read, or the user */
  by: "evidence" | "ai" | "user";
  judgedAt: string;
};

export type PeopleDb = Record<string, PersonRecord>;

const MAX_ENTRIES = 3000;

function keyFor(accountEmail: string) {
  return `people:${accountKey(accountEmail)}`;
}

export async function loadPeople(accountEmail: string): Promise<PeopleDb> {
  return (await kvGet<PeopleDb>(keyFor(accountEmail))) ?? {};
}

export async function savePeople(
  accountEmail: string,
  db: PeopleDb,
): Promise<void> {
  const keys = Object.keys(db);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (db[a].judgedAt < db[b].judgedAt ? -1 : 1))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete db[k]);
  }
  await kvSet(keyFor(accountEmail), db);
}

/** Machine-shaped local part — the cheap half of the main filter. */
export const MACHINE_LOCALPART =
  /^(no-?reply|donotreply|noreply|notifications?|alerts?|updates?|news(letter)?|marketing|promo(tions)?|deals|offers|info|hello|hi|support|help|billing|receipts?|orders?|shipping|store|shop|sales|team|admin|system|mailer|bounce|digest|community|feedback|survey|invite|calendar-notification|drive-shares|comments)/i;

/**
 * Resolve a sender's tier from FREE local evidence. Returns null when
 * the evidence is inconclusive — those go to the AI's full-text read.
 */
export function tierFromEvidence(input: {
  fromEmail: string;
  sentTo: number;
  receivedFrom: number;
  inContacts: boolean;
  hasMeeting: boolean;
}): { tier: PersonTier; reason: string } | null {
  const local = input.fromEmail.split("@")[0] ?? "";
  if (input.sentTo > 0) {
    return { tier: "inner", reason: `You write to them (${input.sentTo}×)` };
  }
  if (input.inContacts) {
    return { tier: "inner", reason: "In your contacts" };
  }
  if (input.hasMeeting) {
    return { tier: "inner", reason: "You have a meeting with them" };
  }
  if (MACHINE_LOCALPART.test(local)) {
    return { tier: "machine", reason: "Automated address" };
  }
  if (input.receivedFrom >= 3) {
    // Repeat human-shaped inbound — probably a person, not proven
    return { tier: "known", reason: `Writes to you often (${input.receivedFrom}×)` };
  }
  return null; // unknown — the AI reads the full email and decides
}
