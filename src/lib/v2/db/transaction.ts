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
