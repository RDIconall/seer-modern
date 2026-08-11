/**
 * How a person's name is shown.
 *
 * Exchange hands back most corporate contacts as "Yasavul, Sandra", which is a
 * directory sort key rather than a name. Reading a board full of them is work.
 * Flip those, but only when the tail really is a given name — "Michael
 * Samoszuk, M.D." and "Smith, Jr." must be left exactly as they are.
 */

/** Tails that are credentials or generational suffixes, never given names. */
const SUFFIX =
  /^(jr|sr|ii|iii|iv|v|md|m\.d|do|d\.o|phd|ph\.d|dds|rn|np|pa|esq|cpa|mba|msc|ms|ma|bsc|bs|pmp|cfa|dvm|pharmd)\.?$/i;

export function personName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) return "";

  // Exactly one comma, and something on both sides of it.
  const parts = name.split(",");
  if (parts.length !== 2) return name;
  const last = parts[0].trim();
  const first = parts[1].trim();
  if (!last || !first) return name;

  // "Samoszuk, M.D." — a credential, not a first name.
  if (first.split(/\s+/).every((word) => SUFFIX.test(word))) return name;

  // An address or anything with @ is not a name to rearrange.
  if (name.includes("@")) return name;

  return `${first} ${last}`;
}
