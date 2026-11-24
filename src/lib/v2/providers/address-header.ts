/**
 * Address-header scanning without backtracking regular expressions.
 *
 * Header values come from whoever sent the message. Patterns such as
 * /<([^>]+)>/ or /^(.*)<([^>]+)>$/ retry the inner wildcard from every '<',
 * so a long run of '<' with no '>' costs time quadratic in the header length
 * and blocks the event loop. Every scan here uses indexOf/lastIndexOf and is
 * linear in the input.
 */

/** Upper bound on addresses taken from one header; Gmail caps recipients far below this. */
export const MAX_ADDRESSES_PER_HEADER = 1_000;

export type AngleAddress = { display: string; address: string };

/**
 * Splits a `Display <address>` value that ends in '>'. Matches what
 * /^(.*)<([^>]+)>$/ captures ("last") or /^(.*?)<([^>]+)>$/ ("first").
 */
export function angleAddress(
  value: string,
  pick: "last" | "first" = "last",
): AngleAddress | null {
  const end = value.length - 1;
  if (end < 2 || value.charCodeAt(end) !== 62 /* > */) return null;
  const innerClose = value.lastIndexOf(">", end - 1);
  const open =
    pick === "last"
      ? value.lastIndexOf("<", end - 2)
      : value.indexOf("<", innerClose + 1);
  if (open < 0 || open <= innerClose || open > end - 2) return null;
  return { display: value.slice(0, open), address: value.slice(open + 1, end) };
}

/** Every non-empty `<...>` span, scanned left to right like /<([^>]+)>/g. */
export function angleBracketed(value: string, limit = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  let from = 0;
  while (out.length < limit) {
    const open = value.indexOf("<", from);
    if (open < 0) break;
    const close = value.indexOf(">", open + 1);
    if (close < 0) break;
    if (close > open + 1) {
      out.push(value.slice(open + 1, close));
      from = close + 1;
    } else {
      from = open + 1;
    }
  }
  return out;
}

/** The first non-empty `<...>` span, like value.match(/<([^>]+)>/)?.[1]. */
export function firstAngleBracketed(value: string): string | undefined {
  return angleBracketed(value, 1)[0];
}
