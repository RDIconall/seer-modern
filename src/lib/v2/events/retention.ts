import { db } from "../db/pool";

/** Conservative floor. Production refuses to delete a shorter window. */
export const EVENTS_RETENTION_MIN_DAYS = 90;
export const EVENTS_RETENTION_DAYS_ENV = "SEER_EVENTS_RETENTION_DAYS";

export function eventsRetentionDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[EVENTS_RETENTION_DAYS_ENV]?.trim();
  if (!raw) return EVENTS_RETENTION_MIN_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < EVENTS_RETENTION_MIN_DAYS) {
    throw new Error(
      `${EVENTS_RETENTION_DAYS_ENV} must be an integer >= ${EVENTS_RETENTION_MIN_DAYS}`,
    );
  }
  return days;
}

/**
 * Deletes rows in seer.events whose created_at is older than the retention
 * window. Does not touch conversations, messages, decisions, yields, matters,
 * outbox, command_receipts, staff tables, or any other corpus.
 */
export async function purgeOldEvents(retentionDays: number): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < EVENTS_RETENTION_MIN_DAYS) {
    throw new Error(`retentionDays must be an integer >= ${EVENTS_RETENTION_MIN_DAYS}`);
  }
  const result = await db().query(
    "select seer.purge_old_events($1::int) as deleted",
    [retentionDays],
  );
  return Number(result.rows[0]?.deleted ?? 0);
}
