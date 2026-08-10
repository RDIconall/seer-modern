import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import type { ContextInput } from "./context";

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
  const [people, matters, interests] = await Promise.all([
    db().query<{ email: string; tier: string; vip: boolean }>(
      "select email, tier, vip from seer.people where account_id = $1",
      [accountId],
    ),
    db().query<{ id: string; title: string }>(
      "select id, title from seer.matters where account_id = $1 and status <> 'closed'",
      [accountId],
    ),
    db().query<{ topic: string }>(
      "select topic from seer.interest_signals where account_id = $1",
      [accountId],
    ),
  ]);

  return {
    ownDomain: ownEmail.split("@")[1] ?? "",
    people: people.rows.map((p) => ({ email: p.email, tier: p.tier, vip: p.vip })),
    matters: matters.rows.map((m) => ({ id: m.id, title: m.title })),
    interests: interests.rows.map((i) => i.topic),
  };
}
