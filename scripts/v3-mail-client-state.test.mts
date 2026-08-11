import assert from "node:assert/strict";
import {
  parseMailHash,
  clearSearchState,
} from "../src/components/v3/mail-client-state.ts";

assert.deepEqual(parseMailHash("#section=sent&q=amendment&conversation=c1"), {
  section: "sent",
  query: "amendment",
  conversation: "c1",
});
assert.deepEqual(parseMailHash("#q=amendment"), {
  section: undefined,
  query: "amendment",
  conversation: undefined,
});
assert.deepEqual(clearSearchState("sent"), {
  section: "sent",
  query: "",
  conversation: null,
  rows: null,
});

console.log("v3-mail-client-state: OK");
