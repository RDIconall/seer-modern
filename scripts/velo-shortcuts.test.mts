import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(
  new URL("../src/components/v3/MailClient.tsx", import.meta.url),
  "utf8",
);
const palette = readFileSync(
  new URL("../src/components/v3/CommandPalette.tsx", import.meta.url),
  "utf8",
);

for (const key of ['"j"', '"k"', '"c"', '"e"', '"r"', '"f"', '"g"']) {
  assert.match(client, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.match(client, /CommandPalette/);
assert.match(client, /mail-search-input/);
assert.match(palette, /role="dialog"/);
assert.match(client, /Go to inbox/);
assert.match(client, /Compose/);

console.log("velo-shortcuts: OK");
