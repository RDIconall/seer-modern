import { inTransaction } from "./transaction";
import type { AccountId } from "./types";

/**
 * Seed the relationship graph BEFORE any read. The chief-of-staff read and the
 * veto-only safety floor are only as good as what they know about the sender —
 * on a cold start with an empty `people` table, real humans (an investor, a
 * contact met at a conference) have no protection and get swept into bulk
 * delete. This function populates `seer.people` so the floor has something to
 * stand on.
 *
 * A sender is known when: the user pinned them (VIP), they resolved to the
 * inner/known tier historically, the user has written to them (sentTo > 0), or
 * they are a saved contact. Machines and first-contact strangers stay unknown.
 */

export type PersonSeed = {
  email: string;
  name?: string;
  tier: "inner" | "known" | "new-credible" | "machine" | "unknown";
  vip?: boolean;
};

export type RelationshipSources = {
  /** Legacy people DB: email -> { tier, vip, name }. */
  people?: Record<string, { tier?: string; vip?: boolean; name?: string }> | null;
  /** Mail history contacts: email -> { sentTo }. */
  history?: { contacts?: Record<string, { sentTo?: number }> } | null;
  /** Saved address-book contacts (emails). */
  contacts?: string[] | null;
};

const VALID_TIERS = new Set(["inner", "known", "new-credible", "machine", "unknown"]);

/** Merge the sources into a deduped set of person seeds. */
export function collectPeople(sources: RelationshipSources): PersonSeed[] {
  const byEmail = new Map<string, PersonSeed>();

  const put = (email: string, seed: Partial<PersonSeed>) => {
    const key = email.toLowerCase().trim();
    if (!key || !key.includes("@")) return;
    const existing = byEmail.get(key) ?? { email: key, tier: "unknown" as const };
    byEmail.set(key, {
      email: key,
      name: seed.name ?? existing.name,
      tier: rankTier(existing.tier, seed.tier),
      vip: seed.vip || existing.vip,
    });
  };

  for (const [email, p] of Object.entries(sources.people ?? {})) {
    const tier = p.tier && VALID_TIERS.has(p.tier) ? (p.tier as PersonSeed["tier"]) : "unknown";
    put(email, { tier, vip: p.vip, name: p.name });
  }
  for (const [email, stat] of Object.entries(sources.history?.contacts ?? {})) {
    if ((stat.sentTo ?? 0) > 0) put(email, { tier: "known" });
  }
  for (const email of sources.contacts ?? []) {
    put(email, { tier: "known" });
  }
  return [...byEmail.values()];
}

/** Higher relationship wins when merging two observations of the same person. */
function rankTier(
  a: PersonSeed["tier"],
  b: PersonSeed["tier"] | undefined,
): PersonSeed["tier"] {
  const order = ["unknown", "machine", "new-credible", "known", "inner"];
  const ai = order.indexOf(a);
  const bi = b ? order.indexOf(b) : -1;
  return bi > ai ? (b as PersonSeed["tier"]) : a;
}

export async function seedPeople(
  accountId: AccountId,
  people: PersonSeed[],
): Promise<number> {
  if (people.length === 0) return 0;
  await inTransaction(async (client) => {
    for (const p of people) {
      await client.query(
        `insert into seer.people (account_id, email, display_name, tier, vip, vip_source)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (account_id, email) do update
             set tier = excluded.tier,
                 vip = seer.people.vip or excluded.vip,
                 display_name = coalesce(excluded.display_name, seer.people.display_name)`,
        [
          accountId,
          p.email,
          p.name ?? null,
          p.tier,
          Boolean(p.vip),
          p.vip ? "user" : "inferred",
        ],
      );
    }
  });
  return people.length;
}
