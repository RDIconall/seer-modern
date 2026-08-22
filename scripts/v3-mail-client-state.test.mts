import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseMailHash,
  clearSearchState,
  modalBackgroundState,
} from "../src/components/v3/mail-client-state.ts";

assert.deepEqual(parseMailHash("#section=sent&q=amendment&conversation=c1"), {
  section: "sent",
  query: "amendment",
  conversation: "c1",
  sort: undefined,
});
assert.deepEqual(parseMailHash("#q=amendment"), {
  section: undefined,
  query: "amendment",
  conversation: undefined,
  sort: undefined,
});
assert.deepEqual(parseMailHash("#section=inbox&sort=triage"), {
  section: "inbox",
  query: undefined,
  conversation: undefined,
  sort: "triage",
});
// Triage is its own section now, not a lens on the inbox.
assert.deepEqual(parseMailHash("#section=triage"), {
  section: "triage",
  query: undefined,
  conversation: undefined,
  sort: undefined,
});
// Anything that is not a section is still refused.
assert.deepEqual(parseMailHash("#section=nowhere"), {
  section: undefined,
  query: undefined,
  conversation: undefined,
  sort: undefined,
});
assert.deepEqual(clearSearchState("sent"), {
  section: "sent",
  query: "",
  conversation: null,
  rows: null,
});
assert.deepEqual(
  modalBackgroundState({ isMobile: true, conversationId: "c1", composing: false }),
  { modalOpen: true, backgroundInert: true },
);
assert.deepEqual(
  modalBackgroundState({ isMobile: false, conversationId: "c1", composing: false }),
  { modalOpen: true, backgroundInert: false },
);

console.log("v3-mail-client-state: OK");

/**
 * The URL and the client hold the same state, and the two effects that keep
 * them together each act a render behind the other: the reader applies the
 * hash, the writer writes the state it still had, and the reader applies that
 * back. That chased "inbox" and "triage" around until React ended the client
 * with "Maximum update depth exceeded" and the error boundary blanked it.
 */
{
  const clientSource = await readFile(
    new URL("../src/components/v3/MailClient.tsx", import.meta.url),
    "utf8",
  );

  // A hash the client wrote is not news.
  assert.match(clientSource, /selfWrittenHash/);
  assert.match(
    clientSource,
    /if \(hashSnapshot && hashSnapshot === selfWrittenHash\.current\) return;/,
    "the reader must ignore the client's own writing",
  );
  assert.match(
    clientSource,
    /selfWrittenHash\.current = writeHash\(/,
    "the writer must record what it wrote",
  );

  // And writing an unchanged hash must not wake the reader at all.
  assert.match(
    clientSource,
    /if \(window\.location\.hash === next\) return next;/,
    "an unchanged hash is not an event",
  );

  // No debug probe may survive into the client.
  assert.doesNotMatch(clientSource, /console\.log/);
}

console.log("v3-mail-client-hash: OK");
