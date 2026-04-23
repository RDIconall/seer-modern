/**
 * Offline eval helpers for hybrid NLP vs exported gold labels from backup SQL.
 * Import from scripts or tests; load CSV/JSONL with { text, label } rows.
 */

export type GoldRow = { text: string; expected: "action" | "non_actionable" };

export type PredRow = { text: string; predicted: "action" | "non_actionable" };

/** Maps meeting/pleasantry/non_actionable → non_actionable for binary F1. */
export function toBinaryAction(label: string): "action" | "non_actionable" {
  return label === "action" ? "action" : "non_actionable";
}

export function confusion(
  gold: GoldRow[],
  pred: PredRow[],
): { tp: number; fp: number; tn: number; fn: number } {
  const map = new Map(gold.map((g) => [g.text, g.expected]));
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  for (const p of pred) {
    const g = map.get(p.text);
    if (!g) continue;
    const pg = toBinaryAction(p.predicted);
    const gg = toBinaryAction(g);
    if (gg === "action" && pg === "action") tp++;
    else if (gg === "non_actionable" && pg === "action") fp++;
    else if (gg === "non_actionable" && pg === "non_actionable") tn++;
    else fn++;
  }
  return { tp, fp, tn, fn };
}

export function f1({ tp, fp, fn }: { tp: number; fp: number; fn: number }): number {
  const prec = tp + fp === 0 ? 0 : tp / (tp + fp);
  const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
  return prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
}
