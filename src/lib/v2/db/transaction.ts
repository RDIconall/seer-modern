import type { PoolClient } from "pg";
import { db } from "./pool";

/**
 * Run `work` inside one transaction. Commits on success, rolls back on any
 * thrown error, and always returns the client to the pool. Every multi-row
 * write in v2 goes through here so a half-applied change can never persist.
 */
export async function inTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // The original error is the one worth surfacing.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run read-only `work` on one pooled connection with a per-statement timeout.
 * The timeout is set on the connection that runs the reads, so Postgres
 * cancels the statement itself rather than leaving it running after the
 * caller gives up. `set local` keeps it inside this transaction, which is
 * what transaction-mode poolers require.
 */
export async function inBoundedRead<T>(
  timeoutMs: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("inBoundedRead requires a positive integer timeout");
  }
  const client = await db().connect();
  let broken: Error | undefined;
  try {
    await client.query(
      `begin read only; set local statement_timeout = ${timeoutMs}`,
    );
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch (rollbackErr) {
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
