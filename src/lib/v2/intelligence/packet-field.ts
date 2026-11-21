/**
 * Values interpolated into a context packet are data. The packet's authority
 * comes from its line structure and labels ([explicit], [system], [calendar],
 * [observed], [inference]); a sender address, display name, subject-derived
 * matter title, or any other stored string must never be able to open a new
 * line or carry one of those labels into the prompt.
 */

// Control characters, Unicode line/paragraph separators, bidi overrides,
// zero-width and other invisible format characters.
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]+/g;

// Bracket lookalikes a model could read as a label delimiter. Fullwidth
// brackets are folded to ASCII by NFKC before this runs.
const OPEN_LOOKALIKE = /[\u2045\u2772\u27e6\u27e8\u27ea\u2983\u2985\u298b\u298d\u298f\u3008\u300a\u3010\u3014\u3016\u3018\u301a]/g;
const CLOSE_LOOKALIKE = /[\u2046\u2773\u27e7\u27e9\u27eb\u2984\u2986\u298c\u298e\u2990\u3009\u300b\u3011\u3015\u3017\u3019\u301b]/g;

const AUTHORITY_MARKER =
  /\[\s*\/?\s*(?:explicit|system|calendar|observed|inference)\b[^\]]{0,40}\]/gi;

/**
 * One packet value: a single line of plain text with no authority markers and
 * no square brackets left to forge one with.
 */
export function packetText(value: unknown, max = 200): string {
  let text = String(value ?? "").normalize("NFKC");
  text = text
    .replace(INVISIBLE, " ")
    .replace(OPEN_LOOKALIKE, "[")
    .replace(CLOSE_LOOKALIKE, "]");
  let previous: string;
  do {
    previous = text;
    text = text.replace(AUTHORITY_MARKER, "");
  } while (text !== previous);
  return text
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

const ADDRESS =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * A sender address as it may appear in a packet: only a well-formed
 * addr-spec is echoed. Anything else is withheld rather than repaired, since
 * the raw value is whatever the sender chose to put in the header.
 */
export function packetAddress(email: string | null | undefined): string | null {
  const value = (email ?? "").trim();
  return value.length <= 254 && ADDRESS.test(value) ? value.toLowerCase() : null;
}
