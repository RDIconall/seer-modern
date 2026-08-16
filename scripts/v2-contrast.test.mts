/**
 * Gate: every colour that carries text stays readable.
 *
 * The interface is deliberately near-monochrome and borderless, which puts the
 * whole burden of legibility on the text colours. A grey chosen for calm rather
 * than contrast is easy to ship and hard to notice: the first pass used #8f8f8f
 * for section headings and senders, which measures 3.5:1 and fails at 13px.
 *
 * Ratios are read from the stylesheets in the order layout.tsx imports them, so
 * what is measured is what actually renders. seer-skin.css restates the palette
 * after globals.css and therefore wins; checking globals.css alone would grade a
 * set of colours no one ever sees.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Imported in this order by src/app/layout.tsx; later files override earlier. */
const SHEETS = ["src/app/globals.css", "src/app/seer-skin.css"].map((path) =>
  readFileSync(path, "utf8"),
);

/** Tokens from a `:root { ... }` block; the second one is the dark theme. */
function tokensIn(css: string, index: number): Record<string, string> {
  const blocks = [...css.matchAll(/:root\s*\{([\s\S]*?)\}/g)];
  const block = blocks[index]?.[1] ?? "";
  const map: Record<string, string> = {};
  for (const match of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    map[match[1]] = match[2];
  }
  return map;
}

/** The cascade: a later sheet's token replaces an earlier one's. */
function tokens(index: number): Record<string, string> {
  return SHEETS.reduce<Record<string, string>>(
    (acc, css) => ({ ...acc, ...tokensIn(css, index) }),
    {},
  );
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal-size text. Most of this UI is 12-15px. */
const AA = 4.5;

for (const [label, index] of [
  ["light", 0],
  ["dark", 1],
] as const) {
  const t = tokens(index);
  assert.ok(t["--bg"], `${label}: expected a background token`);

  // Every foreground token is used for text somewhere, on paper or on a card.
  for (const fg of ["--fg", "--fg-strong", "--muted", "--nav-muted"]) {
    for (const bg of ["--bg", "--card"]) {
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(
        ratio >= AA,
        `${label}: ${fg} (${t[fg]}) on ${bg} (${t[bg]}) is ${ratio.toFixed(2)}:1, below ${AA}:1`,
      );
    }
  }

  // Accent carries the delete action; brand carries extracted meaning.
  for (const fg of ["--accent", "--brand-strong"]) {
    const ratio = contrast(t[fg], t["--bg"]);
    assert.ok(
      ratio >= AA,
      `${label}: ${fg} (${t[fg]}) on background is ${ratio.toFixed(2)}:1, below ${AA}:1`,
    );
  }

  // A selected row must not wash out the text sitting on it.
  const onSelection = contrast(t["--fg-strong"], t["--selection"]);
  assert.ok(
    onSelection >= AA,
    `${label}: text on a selected row is ${onSelection.toFixed(2)}:1`,
  );

  // The brand is spent on the primary action, so its label sits on teal. The
  // mid teal misses AA against white, which is why the CTA uses the deep one;
  // this is the check that keeps someone from "brightening" it later.
  const onBrand = contrast(t["--on-brand"], t["--brand-cta"]);
  assert.ok(
    onBrand >= AA,
    `${label}: --on-brand (${t["--on-brand"]}) on --brand-cta (${t["--brand-cta"]}) is ${onBrand.toFixed(2)}:1, below ${AA}:1`,
  );

  // The active folder sits on a brand tint; its label stays ink.
  const onBrandSoft = contrast(t["--fg-strong"], t["--brand-soft"]);
  assert.ok(
    onBrandSoft >= AA,
    `${label}: text on the active nav tint is ${onBrandSoft.toFixed(2)}:1`,
  );
}

console.log("v2-contrast: ok (light and dark pass AA)");
