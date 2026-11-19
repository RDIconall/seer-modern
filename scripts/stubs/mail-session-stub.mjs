/**
 * Stand-in for a signed-in mailbox session. The tests set
 * globalThis.__seerMailSession before each call. This does not decide how
 * an HTML body is decoded or scanned.
 */
export async function requireMailSession() {
  const session = globalThis.__seerMailSession;
  if (!session) return null;
  return session;
}
