/**
 * Stored and mail-derived strings that are pasted into a model's context
 * packet. The packet is a list of lines, each opened by an authority label the
 * model is told to trust ([explicit], [system], ...). A value carrying its own
 * line break could open a forged line of its own, so every such value is kept
 * on one line before it is stored or interpolated.
 */

/**
 * Whitespace and line terminators, including the ones JavaScript's `\s` does
 * not cover (NEL) — every one of them collapses to a single space.
 */
const WHITESPACE = /[\s\u0085]+/g;

const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/;

/**
 * Non-whitespace control and invisible formatting characters: C0/C1 controls,
 * DEL, zero-width characters and bidi overrides.
 */
const INVISIBLE =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/g;

/** Any control character, line breaks and tabs included. */
const ANY_CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/;

/** A segment that opens the way a context line does: "[system] …". */
const AUTHORITY_LABEL =
  /^[[({<]\s*(?:explicit|system|observed|inference|calendar)\b/i;

export function hasControlCharacters(value: string): boolean {
  return ANY_CONTROL.test(value);
}

/** One line of plain text: whitespace collapsed, control characters dropped. */
export function singleLine(value: string): string {
  return value.replace(INVISIBLE, "").replace(WHITESPACE, " ").trim();
}

/**
 * A value as it may appear inside a labeled context line: one line, bounded,
 * and unable to spell an authority label of its own. Everything from the first
 * line that opens with an authority label is dropped — no stored value has a
 * legitimate reason to carry one.
 */
export function promptValue(value: string, max = 200): string {
  const segments = value.normalize("NFKC").split(LINE_BREAK);
  const forged = segments.findIndex((segment) =>
    AUTHORITY_LABEL.test(singleLine(segment)),
  );
  const kept = forged === -1 ? segments : segments.slice(0, forged);
  return singleLine(kept.join(" "))
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .slice(0, max)
    .trim();
}
