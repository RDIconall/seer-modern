/**
 * Address headers come from whoever sent the mail, so these parsers use index
 * scans only: a regex with stacked quantifiers over `[^>]` can backtrack for
 * seconds to minutes on a long, valid header.
 */

/** Every `<...>` group in order; same result as `raw.matchAll(/<([^>]+)>/g)`. */
export function angleGroups(raw: string): string[] {
  const groups: string[] = [];
  let open = raw.indexOf("<");
  while (open !== -1) {
    const close = raw.indexOf(">", open + 1);
    if (close === -1) break;
    if (close > open + 1) {
      groups.push(raw.slice(open + 1, close));
      open = raw.indexOf("<", close + 1);
    } else {
      open = raw.indexOf("<", open + 1);
    }
  }
  return groups;
}

/** Text of the first `<...>` group; same result as `raw.match(/<([^>]+)>/)?.[1]`. */
export function firstAngleGroup(raw: string): string | undefined {
  return angleGroups(raw)[0];
}

function displayName(raw: string): string {
  let name = raw.trim();
  if (name.startsWith('"')) name = name.slice(1);
  if (name.endsWith('"')) name = name.slice(0, -1);
  return name.replace(/\s+/g, " ").trim();
}

function lastWhitespace(value: string): number {
  for (let i = value.length - 1; i >= 0; i--) {
    if (/\s/.test(value[i])) return i;
  }
  return -1;
}

/**
 * One mailbox (`"Name" <a@b>`, `Name <a@b>`, `<a@b>`, `a@b`, `Name a@b`) as
 * a display name and address. The address is taken from the LAST `<`, so a
 * display name may contain angle brackets and trailing comments are ignored.
 * Anything without an `@` comes back as both name and address.
 */
export function parseMailbox(raw: string): { name: string; email: string } {
  const value = raw.trim();
  const open = value.lastIndexOf("<");
  if (open !== -1) {
    const close = value.indexOf(">", open + 1);
    const email = value
      .slice(open + 1, close === -1 ? undefined : close)
      .trim();
    if (email.includes("@")) {
      return { name: displayName(value.slice(0, open)) || email, email };
    }
  }
  const split = lastWhitespace(value);
  if (split !== -1) {
    const email = value.slice(split + 1);
    if (email.includes("@")) {
      return { name: displayName(value.slice(0, split)) || email, email };
    }
  }
  if (value.includes("@")) return { name: value, email: value };
  return { name: raw, email: raw };
}
