import { db } from "@/lib/v2/db/pool";
import type { AccountId } from "@/lib/v2/db/types";
import { asAccountId } from "@/lib/v2/db/types";
import type { ProviderKind } from "@/lib/v2/providers/types";
import { WAKE_DEDUPE_MS } from "./security";

export type PushSubscription = {
  accountId: AccountId;
  provider: ProviderKind;
  gmailHistoryId: string | null;
  gmailWatchExpiresAt: Date | null;
  graphSubscriptionId: string | null;
  graphClientStateHash: string | null;
  graphExpiresAt: Date | null;
  lastNotificationAt: Date | null;
  lastWakeAt: Date | null;
  lastError: string | null;
};

function mapRow(row: {
  account_id: string;
  provider: string;
  gmail_history_id: string | null;
  gmail_watch_expires_at: Date | null;
  graph_subscription_id: string | null;
  graph_client_state_hash: string | null;
  graph_expires_at: Date | null;
  last_notification_at: Date | null;
  last_wake_at: Date | null;
  last_error: string | null;
}): PushSubscription {
  return {
    accountId: asAccountId(row.account_id),
    provider: row.provider as ProviderKind,
    gmailHistoryId: row.gmail_history_id,
    gmailWatchExpiresAt: row.gmail_watch_expires_at,
    graphSubscriptionId: row.graph_subscription_id,
    graphClientStateHash: row.graph_client_state_hash,
    graphExpiresAt: row.graph_expires_at,
    lastNotificationAt: row.last_notification_at,
    lastWakeAt: row.last_wake_at,
    lastError: row.last_error,
  };
}

export async function upsertPushSubscription(
  accountId: AccountId,
  provider: ProviderKind,
  patch: {
    gmailHistoryId?: string | null;
    gmailWatchExpiresAt?: Date | null;
    graphSubscriptionId?: string | null;
    graphClientStateHash?: string | null;
    graphExpiresAt?: Date | null;
    lastError?: string | null;
  },
): Promise<void> {
  await db().query(
    `insert into seer.mail_push_subscriptions
       (account_id, provider, gmail_history_id, gmail_watch_expires_at,
        graph_subscription_id, graph_client_state_hash, graph_expires_at,
        last_error, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (account_id) do update
       set provider = excluded.provider,
           gmail_history_id = coalesce(excluded.gmail_history_id, seer.mail_push_subscriptions.gmail_history_id),
           gmail_watch_expires_at = coalesce(excluded.gmail_watch_expires_at, seer.mail_push_subscriptions.gmail_watch_expires_at),
           graph_subscription_id = coalesce(excluded.graph_subscription_id, seer.mail_push_subscriptions.graph_subscription_id),
           graph_client_state_hash = coalesce(excluded.graph_client_state_hash, seer.mail_push_subscriptions.graph_client_state_hash),
           graph_expires_at = coalesce(excluded.graph_expires_at, seer.mail_push_subscriptions.graph_expires_at),
           last_error = excluded.last_error,
           updated_at = now()`,
    [
      accountId,
      provider,
      patch.gmailHistoryId ?? null,
      patch.gmailWatchExpiresAt ?? null,
      patch.graphSubscriptionId ?? null,
      patch.graphClientStateHash ?? null,
      patch.graphExpiresAt ?? null,
      patch.lastError ?? null,
    ],
  );
}

export async function getPushSubscription(
  accountId: AccountId,
): Promise<PushSubscription | null> {
  const r = await db().query(
    `select * from seer.mail_push_subscriptions where account_id = $1`,
    [accountId],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function getPushByGraphSubscriptionId(
  subscriptionId: string,
): Promise<PushSubscription | null> {
  const r = await db().query(
    `select * from seer.mail_push_subscriptions where graph_subscription_id = $1`,
    [subscriptionId],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function listPushNeedingRenewal(
  withinMs: number,
): Promise<PushSubscription[]> {
  const r = await db().query(
    `select *
       from seer.mail_push_subscriptions
      where (
              provider = 'google'
              and (
                gmail_watch_expires_at is null
                or gmail_watch_expires_at < now() + ($1::int * interval '1 millisecond')
              )
            )
         or (
              provider = 'microsoft'
              and (
                graph_expires_at is null
                or graph_expires_at < now() + ($1::int * interval '1 millisecond')
              )
            )`,
    [withinMs],
  );
  return r.rows.map(mapRow);
}

/**
 * Record a notification and decide whether a wake should run. Returns false
 * when another wake landed inside the dedupe window.
 */
export async function claimWake(
  accountId: AccountId,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const r = await db().query<{ ok: boolean }>(
    `update seer.mail_push_subscriptions
        set last_notification_at = to_timestamp($2::double precision / 1000.0),
            last_wake_at = case
              when last_wake_at is null
                or last_wake_at < to_timestamp(($2::double precision - $3::double precision) / 1000.0)
              then to_timestamp($2::double precision / 1000.0)
              else last_wake_at
            end,
            last_error = null,
            updated_at = now()
      where account_id = $1
      returning (
        last_wake_at is not distinct from to_timestamp($2::double precision / 1000.0)
      ) as ok`,
    [accountId, nowMs, WAKE_DEDUPE_MS],
  );
  if (r.rowCount === 0) {
    // No push row yet — still wake (notification proved the account exists).
    return true;
  }
  return Boolean(r.rows[0]?.ok);
}

export async function recordPushError(
  accountId: AccountId,
  error: string,
): Promise<void> {
  await db().query(
    `update seer.mail_push_subscriptions
        set last_error = $2, updated_at = now()
      where account_id = $1`,
    [accountId, error.slice(0, 500)],
  );
}
