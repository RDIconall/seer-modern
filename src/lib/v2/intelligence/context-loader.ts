import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import type { ContextInput } from "./context";
import { loadGuidance } from "./operating-model";
import { guidanceFor, loadMailboxStyle } from "./mailbox-style-store";

/** People/matters/placements change slowly relative to a read tick. */
export const CONTEXT_INPUT_TTL_MS = 60_000;

type CachedContext = { expiresAt: number; value: ContextInput };
const contextInputCache = new Map<string, CachedContext>();

export function clearContextInputCache(): void {
  contextInputCache.clear();
}

/**
 * Operating-model and mailbox-style rows are additive. A lagging migration
 * used to reject the whole Promise.all and skip every conversation on the
 * desk; the core people/matters/placements packet is enough to classify.
 */
async function optionalContext<T>(
  label: string,
  load: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(
      `[seer:v2] ${label} unavailable; reading without it:`,
      error instanceof Error ? error.message : error,
    );
    return fallback;
  }
}

/**
 * Load the business context for an account from the durable store: known
 * people, live matters, and explicit interests. This is what lets a read beat
 * the naive baseline. It is assembled once per read batch and passed to each
 * conversation's context compiler.
 */
export async function loadContextInput(
  accountId: AccountId,
  ownEmail: string,
): Promise<ContextInput> {
  const cacheKey = `${accountId}:${ownEmail.toLowerCase()}`;
  const cached = contextInputCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [people, matters, interests, placements, operatingGuidance, mailboxStyle] = await Promise.all([
    db().query<{ email: string; tier: string; vip: boolean }>(
      "select email, tier, vip from seer.people where account_id = $1",
      [accountId],
    ),
    db().query<{
      id: string;
      title: string;
      counterparty: string | null;
      title_source: string;
      codes: string[] | null;
    }>(
      `select m.id,
              m.title,
              m.org_unit as counterparty,
              m.title_source,
              array_remove(array_agg(distinct mc.code), null) as codes
         from seer.matters m
         left join seer.matter_codes mc on mc.matter_id = m.id
        where m.account_id = $1 and m.status <> 'closed'
        group by m.id`,
      [accountId],
    ),
    db().query<{ topic: string }>(
      "select topic from seer.interest_signals where account_id = $1",
      [accountId],
    ),
    db().query<{
      sender_email: string;
      home: "matter" | "record" | "delete";
      count: number;
    }>(
      // Only a Triage correction is a statement about a sender, and only the
      // sender bound when the user acted. A mailbox archive/trash is about the
      // thread, and a From header that arrives later was never in front of them.
      `select d.placement_sender as sender_email,
              d.home,
              count(*)::int as count
         from seer.conversation_decisions d
        where d.account_id = $1
          and d.is_current
          and d.model_version = 'user-correction'
          and d.home in ('matter', 'record', 'delete')
          and d.placement_sender is not null
          and d.decided_at > now() - interval '180 days'
        group by d.placement_sender, d.home`,
      [accountId],
    ),
    optionalContext("operating guidance", () => loadGuidance(accountId), ""),
    optionalContext("mailbox style", () => loadMailboxStyle(accountId), null),
  ]);

  const value: ContextInput = {
    ownDomain: ownEmail.split("@")[1] ?? "",
    ownEmail,
    people: people.rows.map((p) => ({ email: p.email, tier: p.tier, vip: p.vip })),
    matters: matters.rows.map((m) => ({
      id: m.id,
      title: m.title,
      codes: m.codes ?? [],
      counterparty: m.counterparty ?? "",
      userAuthored: m.title_source === "user",
    })),
    interests: interests.rows.map((i) => i.topic),
    placements: placements.rows.map((item) => ({
      senderEmail: item.sender_email,
      home: item.home,
      count: item.count,
    })),
    operatingGuidance,
    mailboxStyleGuidance: guidanceFor(mailboxStyle),
  };
  contextInputCache.set(cacheKey, {
    expiresAt: Date.now() + CONTEXT_INPUT_TTL_MS,
    value,
  });
  return value;
}
