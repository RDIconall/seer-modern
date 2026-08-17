/**
 * Task 7 gate: every `mail-*` class emitted by the V3 shell has a stylesheet
 * rule. Missing rules make a valid React tree look like an unformatted list.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const componentsDir = "src/components/v3";
const css = readFileSync("src/app/globals.css", "utf8");
const used = new Set<string>();

for (const file of readdirSync(componentsDir)) {
  if (!file.endsWith(".tsx")) continue;
  const source = readFileSync(join(componentsDir, file), "utf8");
  for (const match of source.matchAll(/className="([^"]+)"/g)) {
    for (const cls of match[1].split(/\s+/)) {
      if (cls.startsWith("mail-")) used.add(cls);
    }
  }
}

assert.ok(used.size > 0, "expected V3 components to declare mail-* classes");

function hasRule(cls: string): boolean {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(css);
}

const unstyled = [...used].filter((cls) => !hasRule(cls));
assert.deepEqual(
  unstyled,
  [],
  `V3 components use classes with no stylesheet rule: ${unstyled.join(", ")}`,
);

assert.match(css, /@media\s*\(max-width:\s*700px\)/, "missing mobile shell rules");
assert.match(css, /\.mail-bottom-nav\b/, "missing mobile bottom navigation styles");
assert.match(css, /\.mail-reader-full\b/, "missing mobile full-screen reader styles");
assert.match(css, /\.mail-focus-ring\b/, "missing keyboard focus styles");
assert.match(css, /\.mail-reader-full[\s\S]*z-index:\s*50/, "reader modal must stack above navigation");
assert.match(css, /\.mail-compose[\s\S]*z-index:\s*60/, "compose modal must stack above navigation");

console.log(`v3-styles: OK (${used.size} classes all styled)`);
