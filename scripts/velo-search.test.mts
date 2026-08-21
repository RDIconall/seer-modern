import assert from "node:assert/strict";
import {
  compileGmailSearch,
  compileOutlookSearch,
  parseMailSearch,
} from "../src/lib/v3/search/parser.ts";

const parsed = parseMailSearch(
  'from:alex@example.com subject:"project alpha" has:attachment is:unread after:2026-08-01 budget',
);
assert.equal(parsed.text, "budget");
assert.equal(parsed.from, "alex@example.com");
assert.equal(parsed.subject, "project alpha");
assert.equal(parsed.hasAttachment, true);
assert.equal(parsed.isUnread, true);
assert.equal(parsed.after, "2026-08-01");

assert.equal(
  compileGmailSearch(parsed),
  'budget from:alex@example.com subject:"project alpha" has:attachment is:unread after:2026-08-01',
);
assert.equal(
  compileOutlookSearch(parsed),
  'budget from:alex@example.com subject:"project alpha" hasAttachments:true isRead:false received>=2026-08-01',
);

assert.doesNotThrow(() => parseMailSearch("invoice"));
assert.equal(parseMailSearch("from:").text, "from:");

console.log("velo-search: OK");
