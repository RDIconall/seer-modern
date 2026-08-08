import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * THE USER'S OWN LABELS — Salesforce tasks they hand-categorized are
 * ground truth for how THEY carve up their world. Retrieved few-shot
 * at classification time; adapts as they re-import, no rule upkeep.
 */

export type Exemplar = {
  subject: string;
  category: string;
  hint?: string;
};

function keyFor(accountEmail: string) {
  return `sf-exemplars:${accountKey(accountEmail)}`;
}

export async function loadExemplars(
  accountEmail: string,
): Promise<Exemplar[]> {
  return (await kvGet<Exemplar[]>(keyFor(accountEmail))) ?? [];
}

export async function saveExemplars(
  accountEmail: string,
  exemplars: Exemplar[],
): Promise<void> {
  await kvSet(keyFor(accountEmail), exemplars.slice(0, 2000));
}

const STOP = new Set(
  "the a an and or of for to with on in at from re fwd fw is are was be this that your our my you we they it as by".split(
    " ",
  ),
);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/**
 * Cheap lexical retrieval (rare-token weighted overlap) — good enough
 * until embeddings land with the Postgres move.
 */
export function retrieveExemplars(
  query: string,
  exemplars: Exemplar[],
  k = 3,
): Exemplar[] {
  if (exemplars.length === 0) return [];
  const df = new Map<string, number>();
  const exTokens = exemplars.map((e) => tokens(`${e.subject} ${e.hint ?? ""}`));
  for (const set of exTokens) {
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const q = tokens(query);
  return exemplars
    .map((e, i) => {
      let score = 0;
      for (const t of exTokens[i]) {
        if (q.has(t)) score += 1 / (1 + (df.get(t) ?? 0));
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.e);
}
