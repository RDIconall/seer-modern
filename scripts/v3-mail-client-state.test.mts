import assert from "node:assert/strict";
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
assert.deepEqual(parseMailHash("#section=triage"), {
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
