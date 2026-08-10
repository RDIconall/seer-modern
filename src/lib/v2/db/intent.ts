import { inTransaction } from "./transaction";
import type { AccountId } from "./types";

/**
 * Option B reset: preserve explicit user INTENT, regenerate everything the
 * machine inferred. This module takes only the deliberate choices a person
 * made — VIP pins, message corrections, sender/topic teachings, hand-named
 * matters and their manual links, and explicit closures — and writes them into
 * the v2 model. It never accepts inferred tiers, relationships, dispositions,
 * briefs, or auto-clustered matters; those are rebuilt by reading the mailbox.
 */

export type PreservedIntent = {
  /** Senders the user pinned as VIP. */
  vips: { email: string; name?: string }[];
  /** "This one message is actionable" — per-message, not per-sender. */
  corrections: { messageId: string; action: string }[];
  /** "Always treat this sender this way" — deliberate sender teachings. */
  senderTeachings: { email: string; action: string }[];
  /** Topics the user explicitly said they care about. */
  interests: { topic: string }[];
  /** Matters the user named or created by hand, with any manual links. */
  manualMatters: {
    title: string;
    orgUnit?: string;
    conversationProviderIds: string[];
  }[];
  /** Matters the user explicitly closed/reopened. */
  closures: { title: string; reason?: string; reopened?: boolean }[];
};

export type PreservedCounts = {
  vips: number;
  corrections: number;
  senderTeachings: number;
  interests: number;
  manualMatters: number;
  manualLinks: number;
  closures: number;
};

/** Count what would be preserved without writing anything (for --dry-run). */
export function countPreservedIntent(intent: PreservedIntent): PreservedCounts {
  return {
    vips: intent.vips.length,
    corrections: intent.corrections.length,
    senderTeachings: intent.senderTeachings.length,
    interests: intent.interests.length,
    manualMatters: intent.manualMatters.length,
    manualLinks: intent.manualMatters.reduce(
      (n, m) => n + m.conversationProviderIds.length,
      0,
    ),
    closures: intent.closures.length,
  };
}

/**
 * Persist preserved intent for one account in a single transaction. Idempotent:
 * re-running upserts the same rows rather than duplicating them.
 */
export async function applyPreservedIntent(
  accountId: AccountId,
  intent: PreservedIntent,
): Promise<PreservedCounts> {
  await inTransaction(async (client) => {
    for (const vip of intent.vips) {
      await client.query(
        `insert into seer.people (account_id, email, display_name, tier, vip, vip_source)
           values ($1, $2, $3, 'inner', true, 'user')
           on conflict (account_id, email) do update
             set vip = true, vip_source = 'user',
                 display_name = coalesce(excluded.display_name, seer.people.display_name)`,
        [accountId, vip.email.toLowerCase(), vip.name ?? null],
      );
    }

    for (const c of intent.corrections) {
      await client.query(
        `insert into seer.events (account_id, kind, idempotency_key, payload)
           values ($1, 'user_correction', $2, $3::jsonb)
           on conflict (account_id, idempotency_key) do nothing`,
        [
          accountId,
          `correction:${c.messageId}`,
          JSON.stringify({ messageId: c.messageId, action: c.action }),
        ],
      );
    }

    for (const t of intent.senderTeachings) {
      await client.query(
        `insert into seer.events (account_id, kind, idempotency_key, payload)
           values ($1, 'user_teach_sender', $2, $3::jsonb)
           on conflict (account_id, idempotency_key) do nothing`,
        [
          accountId,
          `teach:${t.email.toLowerCase()}`,
          JSON.stringify({ email: t.email.toLowerCase(), action: t.action }),
        ],
      );
    }

    for (const i of intent.interests) {
      await client.query(
        `insert into seer.interest_signals (account_id, topic, source, weight)
           values ($1, $2, 'explicit', 1)
           on conflict (account_id, topic, source) do nothing`,
        [accountId, i.topic],
      );
    }

    for (const m of intent.manualMatters) {
      const inserted = await client.query<{ id: string }>(
        `insert into seer.matters (account_id, title, org_unit, title_source)
           values ($1, $2, $3, 'user')
           returning id`,
        [accountId, m.title, m.orgUnit ?? null],
      );
      const matterId = inserted.rows[0].id;
      for (const provId of m.conversationProviderIds) {
        await client.query(
          `insert into seer.matter_conversations (matter_id, conversation_id, link_source)
             select $1, c.id, 'user'
               from seer.conversations c
              where c.account_id = $2 and c.provider_conversation_id = $3
             on conflict do nothing`,
          [matterId, accountId, provId],
        );
      }
    }

    for (const cl of intent.closures) {
      await client.query(
        `insert into seer.events (account_id, kind, idempotency_key, payload)
           values ($1, $2, $3, $4::jsonb)
           on conflict (account_id, idempotency_key) do nothing`,
        [
          accountId,
          cl.reopened ? "user_reopen" : "user_closure",
          `${cl.reopened ? "reopen" : "closure"}:${cl.title}`,
          JSON.stringify({ title: cl.title, reason: cl.reason ?? null }),
        ],
      );
    }
  });

  return countPreservedIntent(intent);
}
