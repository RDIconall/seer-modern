/**
 * Pure recipient-field rules: paste parsing, loose address validation, dedupe,
 * backspace-removes-last, and suggestion-index wrapping.
 */
import assert from "node:assert/strict";
import {
  addRecipient,
  commitAddressList,
  commitRawAddress,
  isValidAddress,
  moveActiveIndex,
  parseRecipientTokens,
  removeLastRecipient,
  removeRecipient,
  type Recipient,
} from "../src/components/v3/recipient-state.ts";

assert.equal(isValidAddress("a@b.co"), true);
assert.equal(isValidAddress("nonsense"), false);
assert.equal(isValidAddress(""), false);
assert.equal(isValidAddress("missing-at.domain"), false);

assert.deepEqual(parseRecipientTokens("a@b.co, c@d.co; e@f.co\ng@h.co"), [
  "a@b.co",
  "c@d.co",
  "e@f.co",
  "g@h.co",
]);
assert.deepEqual(parseRecipientTokens("Sandra <sandra@example.com>, other@x.com"), [
  "sandra@example.com",
  "other@x.com",
]);

const empty: Recipient[] = [];
const first = addRecipient(empty, { email: "a@b.co", displayName: "A" });
assert.deepEqual(first, [{ email: "a@b.co", displayName: "A" }]);
assert.deepEqual(
  addRecipient(first, { email: "A@b.co", displayName: "Dup" }),
  first,
  "committing an address already present is a no-op",
);

const pasted = commitAddressList(empty, "a@b.co; c@d.co, e@f.co");
assert.deepEqual(
  pasted.recipients.map((r) => r.email),
  ["a@b.co", "c@d.co", "e@f.co"],
);
assert.equal(pasted.error, null);

const badPaste = commitAddressList(empty, "a@b.co, nonsense");
assert.deepEqual(
  badPaste.recipients.map((r) => r.email),
  ["a@b.co"],
);
assert.match(badPaste.error ?? "", /nonsense/);

const typed = commitRawAddress(empty, "  friend@example.com ");
assert.deepEqual(typed.recipients, [
  { email: "friend@example.com", displayName: null },
]);
assert.equal(typed.error, null);

const badTyped = commitRawAddress(empty, "not-an-address");
assert.deepEqual(badTyped.recipients, []);
assert.match(badTyped.error ?? "", /not-an-address/);

const three: Recipient[] = [
  { email: "a@b.co", displayName: null },
  { email: "c@d.co", displayName: null },
  { email: "e@f.co", displayName: null },
];
assert.deepEqual(removeLastRecipient(three).map((r) => r.email), [
  "a@b.co",
  "c@d.co",
]);
assert.deepEqual(removeLastRecipient([]), []);
assert.deepEqual(
  removeRecipient(three, "C@d.co").map((r) => r.email),
  ["a@b.co", "e@f.co"],
);

assert.equal(moveActiveIndex(-1, 1, 3), 0);
assert.equal(moveActiveIndex(-1, -1, 3), 2);
assert.equal(moveActiveIndex(0, -1, 3), 2, "Up from the first wraps to the last");
assert.equal(moveActiveIndex(2, 1, 3), 0, "Down from the last wraps to the first");
assert.equal(moveActiveIndex(1, 1, 3), 2);
assert.equal(moveActiveIndex(0, 1, 0), -1);
assert.equal(moveActiveIndex(5, 1, 0), -1);

console.log("v3-recipient-state: OK");

// --- Send gating -----------------------------------------------------------
// A forward with no comment is an ordinary forward; a forward with no
// recipient is not a forward at all.
const { canSendCompose } = await import("../src/components/v3/compose-command.ts");

assert.equal(
  canSendCompose({ mode: "forward", recipientCount: 1, body: "", sending: false }),
  true,
  "a forward must send with no comment typed",
);
assert.equal(
  canSendCompose({ mode: "forward", recipientCount: 0, body: "hello", sending: false }),
  false,
  "a forward must not send without a recipient",
);
assert.equal(
  canSendCompose({ mode: "send", recipientCount: 0, body: "hi", sending: false }),
  false,
);
assert.equal(
  canSendCompose({ mode: "reply", recipientCount: 0, body: "   ", sending: false }),
  false,
  "an empty reply says nothing",
);
assert.equal(
  canSendCompose({ mode: "reply", recipientCount: 0, body: "thanks", sending: false }),
  true,
  "a reply derives its own recipients",
);
assert.equal(
  canSendCompose({ mode: "forward", recipientCount: 1, body: "x", sending: true }),
  false,
  "an in-flight send must not double-fire",
);

console.log("v3-compose-gating: OK");
