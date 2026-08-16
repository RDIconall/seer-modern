/**
 * Recipient-field rules, kept out of the React tree so they can be unit-tested
 * without a DOM. Selection and commit logic that lived inline recently shipped
 * broken for exactly that reason.
 */

export type Recipient = {
  email: string;
  displayName: string | null;
};

/** Loose shape check — enough to catch "nonsense", not an RFC parser. */
export function isValidAddress(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
}

/**
 * Split a pasted or typed list on commas, semicolons, or newlines. Angle-bracket
 * forms (`Name <a@b.co>`) keep only the address.
 */
export function parseRecipientTokens(raw: string): string[] {
  return raw
    .split(/[,;\n\r]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((token) => {
      const angled = /<([^<>@\s]+@[^<>@\s]+)>/.exec(token);
      return (angled ? angled[1] : token).trim();
    });
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Add one recipient; an address already present is a no-op. */
export function addRecipient(
  recipients: readonly Recipient[],
  next: Recipient,
): Recipient[] {
  const email = next.email.trim();
  if (!email) return [...recipients];
  if (recipients.some((r) => sameAddress(r.email, email))) {
    return [...recipients];
  }
  return [
    ...recipients,
    {
      email,
      displayName: next.displayName?.trim() || null,
    },
  ];
}

export function removeRecipient(
  recipients: readonly Recipient[],
  email: string,
): Recipient[] {
  return recipients.filter((r) => !sameAddress(r.email, email));
}

/** Backspace on an empty input removes the last pill. */
export function removeLastRecipient(
  recipients: readonly Recipient[],
): Recipient[] {
  if (recipients.length === 0) return [...recipients];
  return recipients.slice(0, -1);
}

/**
 * Commit a raw typed address. Invalid input leaves the list unchanged and
 * returns an error string the field can show inline.
 */
export function commitRawAddress(
  recipients: readonly Recipient[],
  raw: string,
): { recipients: Recipient[]; error: string | null } {
  const email = raw.trim();
  if (!email) {
    return { recipients: [...recipients], error: null };
  }
  if (!isValidAddress(email)) {
    return {
      recipients: [...recipients],
      error: `"${email}" does not look like an email address`,
    };
  }
  return {
    recipients: addRecipient(recipients, { email, displayName: null }),
    error: null,
  };
}

/** Commit every token from a paste; first invalid token wins the error. */
export function commitAddressList(
  recipients: readonly Recipient[],
  raw: string,
): { recipients: Recipient[]; error: string | null } {
  let next = [...recipients];
  for (const token of parseRecipientTokens(raw)) {
    const result = commitRawAddress(next, token);
    if (result.error) return result;
    next = result.recipients;
  }
  return { recipients: next, error: null };
}

/**
 * Move the active suggestion index, wrapping at both ends. With an empty list
 * there is no active option (−1).
 */
export function moveActiveIndex(
  active: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) return -1;
  if (active < 0) return delta > 0 ? 0 : count - 1;
  return (active + delta + count) % count;
}

export function pillLabel(recipient: Recipient): string {
  const name = recipient.displayName?.trim();
  return name || recipient.email;
}
