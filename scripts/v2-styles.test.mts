/**
 * Gate: every class the v2 components render must have a stylesheet rule.
 *
 * The v2 app shipped once with markup referencing 28 seer-* classes and a
 * stylesheet defining none of them — the product rendered as a wall of raw
 * text. Nothing failed: markup is valid, the build is green, and no runtime
 * error fires for a missing CSS rule. This makes that class of shipwreck a
 * test failure instead.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const componentsDir = "src/components/v2";
const css = readFileSync("src/app/globals.css", "utf8");

const used = new Set<string>();
for (const file of readdirSync(componentsDir)) {
  if (!file.endsWith(".tsx")) continue;
  const source = readFileSync(join(componentsDir, file), "utf8");
  for (const match of source.matchAll(/className="([^"]+)"/g)) {
    for (const cls of match[1].split(/\s+/)) {
      if (cls.startsWith("seer-")) used.add(cls);
    }
  }
}

assert.ok(used.size > 0, "expected the v2 components to declare seer-* classes");

// Selector match, not substring match: ".seer-topbar-other" must not satisfy
// ".seer-topbar". The class must end at a selector boundary.
function hasRule(cls: string): boolean {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(css);
}

const unstyled = [...used].filter((cls) => !hasRule(cls));
assert.deepEqual(
  unstyled,
  [],
  `v2 components use classes with no stylesheet rule — the UI would render ` +
    `as raw text. Add rules to src/app/globals.css for: ${unstyled.join(", ")}`,
);

console.log(`v2-styles: ok (${used.size} classes all styled)`);
