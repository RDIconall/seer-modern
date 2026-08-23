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

/**
 * Triage on desktop is a one-line table through MobileMailboxList. The grid
 * broke when only date/meta named columns — auto-placement skipped backward,
 * subject landed in column five, and preview wrapped. Row actions also sat
 * under every row instead of at the end of the line.
 */
const compactBlockRule = css.indexOf(
  ".compact-mail-list .mobile-mail-row {\n  display: block;",
);
const desktopFlexRule = css.indexOf(
  "@media (min-width: 701px) {\n  .compact-mail-list .mobile-mail-row {\n    display: flex;",
);
assert.ok(
  compactBlockRule > -1 && desktopFlexRule > compactBlockRule,
  "desktop flex row layout must follow the unscoped display:block rule",
);

for (const [selector, column] of [
  [".compact-mail-list .mobile-mail-row-top strong", 1],
  [".compact-mail-list .mobile-mail-row-subject", 2],
  [".compact-mail-list .mobile-mail-row-preview", 3],
  [".compact-mail-list .mobile-mail-row-top time", 4],
  [".compact-mail-list .mobile-mail-row-meta", 5],
] as const) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    css,
    new RegExp(`${escaped}[\\s\\S]*?grid-column:\\s*${column}`),
    `${selector} must occupy column ${column}`,
  );
}

assert.match(
  css,
  /\.compact-mail-list \.mobile-mail-row-top strong,\s*\n\.compact-mail-list \.mobile-mail-row-subject,\s*\n\.compact-mail-list \.mobile-mail-row-preview,\s*\n\.compact-mail-list \.mobile-mail-row-top time,\s*\n\.compact-mail-list \.mobile-mail-row-meta \{\s*\n\s*grid-row: 1;/,
  "every table cell must share row 1 on desktop",
);

assert.match(
  css,
  /@media \(min-width: 701px\) and \(hover: hover\) and \(pointer: fine\) \{[\s\S]*\.compact-mail-list \.mobile-mail-row-actions \{\s*\n\s*opacity: 0;/,
  "mouse users see row actions on hover, not on every row",
);

const mobileMailStyles = css.slice(
  css.indexOf(
    "@media (max-width: 700px) {\n  .mail-client {\n    display: block;",
  ),
);
assert.match(
  mobileMailStyles,
  /\.compact-mail-list \.mobile-mail-row-top time,[\s\S]*?grid-column: auto;[\s\S]*?grid-row: auto;/,
  "phone layout must reset named grid placement",
);

/*
 * The class-coverage sweep above cannot see an element that carries no class at
 * all, which is how Settings ended up as browser-default headings, bullets and
 * grey buttons. Require the account surfaces to be named and styled.
 */
const settingsSource = readFileSync(join(componentsDir, "Settings.tsx"), "utf8");
for (const cls of [
  "mail-settings-header",
  "mail-settings-section",
  "mail-settings-heading",
  "mail-settings-list",
  "mail-settings-account",
  "mail-settings-identity",
  "mail-settings-actions",
  "mail-settings-button",
]) {
  assert.ok(
    settingsSource.includes(`"${cls}`) || settingsSource.includes(` ${cls}"`),
    `Settings must render ${cls} rather than a bare element`,
  );
  assert.ok(hasRule(cls), `${cls} needs a stylesheet rule`);
}

assert.match(
  css,
  /\.mail-settings-list \{[\s\S]*?list-style: none;/,
  "connected accounts must not fall back to browser bullets",
);

console.log(`v3-styles: OK (${used.size} classes all styled)`);
