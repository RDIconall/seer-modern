/** Lightweight sentence boundaries (legacy used LingPipe IndoEuropeanSentenceModel). */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9"'`([])/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}
