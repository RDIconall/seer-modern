/**
 * THE RELATIONSHIP FLOOR.
 *
 * The context compiler already tells the model who a sender is, but a
 * prompt is advice, not law — nothing stopped a known contact's mail from
 * landing in Triage's bulk "Safe to delete". This module is the law: a
 * deterministic set of senders with a real relationship, enforced in code
 * when the brief partitions mail, so relationship mail can never be swept
 * in bulk. It can still be deleted — one row, one deliberate tap.
 *
 * A sender is KNOWN when any of these hold:
 *   - the user pinned them (VIP) or they resolved to the inner/known tier
 *     (machines and first-contact strangers do not qualify);
 *   - the user has ever written to them (sent mail is the strongest,
 *     cheapest relationship signal there is);
 *   - they are in the user's saved address book.
 */

/** Structural inputs so callers and tests can pass partial records. */
type PersonLike = { tier?: string; vip?: boolean } & Record<string, unknown>;
type HistoryLike = {
  contacts?: Record<string, { sentTo?: number } & Record<string, unknown>>;
} & Record<string, unknown>;
type PersonalLike = { contacts?: string[] } & Record<string, unknown>;

export function knownSenders(sources: {
  people?: Record<string, PersonLike> | null;
  history?: HistoryLike | null;
  personal?: PersonalLike | null;
}): Set<string> {
  const known = new Set<string>();
  for (const [email, person] of Object.entries(sources.people ?? {})) {
    if (person.vip || person.tier === "inner" || person.tier === "known") {
      known.add(email.toLowerCase().trim());
    }
  }
  for (const [email, stat] of Object.entries(
    sources.history?.contacts ?? {},
  )) {
    if ((stat.sentTo ?? 0) > 0) known.add(email.toLowerCase().trim());
  }
  for (const email of sources.personal?.contacts ?? []) {
    if (email) known.add(email.toLowerCase().trim());
  }
  return known;
}
