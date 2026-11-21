/**
 * The company behind a From address, as a key that groups mail.
 *
 * The From domain is chosen by whoever sends the message, and no
 * authentication result travels with it this far. So no label is ever
 * dropped from it: "notifications.roche.com", "mybuy.roche.com" and
 * "roche.attacker.example" are each their own company, never "roche.com".
 * Anything grouped by this key — a model batch, an automated-mail matter, a
 * tie to an existing matter — therefore only joins mail from the exact same
 * domain.
 */

/** The domain of an address: everything after the last "@", lowercased. */
export function senderDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

/**
 * The company key for a sender domain, or "" when the domain is not a
 * usable hostname. A plain ".com" is left off so the common case reads as
 * the company name ("roche.com" → "roche"); every other domain is kept
 * whole, so no two domains share a key.
 */
export function companyKey(domain: string): string {
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return "";
  if (labels.length === 2 && labels[1] === "com") return labels[0];
  return labels.join(".");
}

/** How a company key reads to the user: "roche" → "Roche", "ibm" → "IBM". */
export function companyLabel(key: string): string {
  if (!key || key.includes(".")) return key;
  return key.length <= 3
    ? key.toUpperCase()
    : key.charAt(0).toUpperCase() + key.slice(1);
}
