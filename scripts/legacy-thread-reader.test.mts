import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(
  new URL("../src/app/api/messages/[id]/route.ts", import.meta.url),
  "utf8",
);
assert.match(route, /getGmailThreadMessages/);
assert.match(route, /getGraphConversationMessages/);
assert.match(route, /thread:/);

for (const file of [
  "../src/components/inbox/DesktopMailApp.tsx",
  "../src/components/inbox/MobileMailApp.tsx",
]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(source, /reader\.thread/);
  assert.match(source, /LegacyThread/);
}

console.log("legacy-thread-reader: OK");
