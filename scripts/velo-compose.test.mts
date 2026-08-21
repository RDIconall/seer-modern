import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  draftStorageKey,
  parseStoredDraft,
  type StoredDraft,
} from "../src/lib/v3/compose/draft.ts";

assert.equal(draftStorageKey("acct", "send"), "seer:draft:acct:send");
assert.equal(
  draftStorageKey("acct", "reply", "thread/1"),
  "seer:draft:acct:reply:thread%2F1",
);

const draft: StoredDraft = {
  recipients: ["a@example.com"],
  subject: "Hello",
  bodyHtml: "<p>Draft</p>",
  bodyText: "Draft",
  savedAt: "2026-08-21T12:00:00.000Z",
};
assert.deepEqual(parseStoredDraft(JSON.stringify(draft)), draft);
assert.equal(parseStoredDraft("not-json"), null);
assert.equal(parseStoredDraft('{"subject":3}'), null);

const pane = readFileSync(
  new URL("../src/components/v3/ComposePane.tsx", import.meta.url),
  "utf8",
);
assert.match(pane, /RichComposer/);
assert.match(pane, /localStorage/);
assert.match(pane, /Add attachment/);
assert.match(pane, /Draft with AI/);

const rich = readFileSync(
  new URL("../src/components/v3/RichComposer.tsx", import.meta.url),
  "utf8",
);
assert.match(rich, /@tiptap\/react/);
assert.match(rich, /StarterKit/);

console.log("velo-compose: OK");
