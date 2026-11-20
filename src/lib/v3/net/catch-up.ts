/**
 * Ask the server to pull mail that arrived while the user was away. The kick
 * is a same-origin POST; the mailbox GETs are pure reads. A failed kick never
 * blocks the list from painting, it only means no follow-up reload.
 */
export async function requestInboxCatchUp(path: string): Promise<boolean> {
  try {
    const response = await fetch(path, { method: "POST" });
    if (!response.ok) return false;
    const json = (await response.json()) as { catchingUp?: boolean };
    return Boolean(json.catchingUp);
  } catch {
    return false;
  }
}
