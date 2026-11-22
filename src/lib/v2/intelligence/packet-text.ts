/**
 * The context packet and the filing prompt give authority by line: a line that
 * starts with [explicit] or [system] outranks the email. Any stored text that
 * is pasted into those prompts must stay on its own line and must not carry a
 * label of its own, or it could mint authority the user never granted.
 */

const BREAKS_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
// Invisible characters would otherwise hide a label from the pattern below.
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
const AUTHORITY_LABEL =
  /[[［【〔]\s*(?:explicit|system|inference|observed|calendar)\s*[\]］】〕]/gi;

/** Collapse text onto one line with no packet authority labels. */
export function flattenPacketText(text: string): string {
  let value = text
    .normalize("NFKC")
    .replace(BREAKS_AND_CONTROLS, " ").replace(INVISIBLE, "");
  // Removing one label can join its neighbours into another ("[sys[system]tem]").
  for (let previous = ""; previous !== value; ) {
    previous = value;
    value = value.replace(AUTHORITY_LABEL, " ");
  }
  return value.replace(/\s+/g, " ").trim();
}

/** Guidance as it may be stored and pasted into filing and reading prompts. */
export function sanitizeGuidance(text: string, maxChars: number): string {
  return flattenPacketText(text).slice(0, maxChars).trim();
}
