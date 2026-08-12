/**
 * Browser fetch helpers that never set the `cache` init option.
 *
 * iOS Safari — through several shipping versions — throws
 * `TypeError: The string did not match the expected pattern.` the instant
 * `fetch()` is handed `{ cache: "no-store" }` (and the other explicit cache
 * modes). Because the mailbox refresh that runs after every command used that
 * option, a single archive or delete could surface as "Provider action failed"
 * on an affected phone, and the whole inbox failed to load. Recent WebKit has
 * fixed the bug, but the devices in the wild have not.
 *
 * Freshness is forced instead with a unique query parameter: a URL the browser
 * has never seen cannot be answered from its HTTP cache, which is exactly what
 * `no-store` was buying. This works on every engine and cannot throw.
 */

function cacheBust(input: string): string {
  const separator = input.includes("?") ? "&" : "?";
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${input}${separator}_=${nonce}`;
}

/** Always hits the network for a fresh response. Replaces `cache: "no-store"`. */
export function fetchFresh(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(cacheBust(input), init);
}

/**
 * A plain fetch with no `cache` option, safe on the affected devices. Replaces
 * `cache: "force-cache"`; the browser's default HTTP caching still applies, so
 * a prefetched body is reused when the response allows it.
 */
export function fetchDefault(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, init);
}
