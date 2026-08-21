/**
 * Gate: "Open in Outlook" opens the mail.
 *
 * Outlook's deep link resolves an ITEM. Handed a conversation id it spins, or
 * lands on "this message might have been moved or deleted" — which is what the
 * escape hatch did for every thread in the reader.
 */
import assert from "node:assert/strict";
import { nativeUrlFor } from "../src/lib/v2/providers/native-url.ts";

const conversationId = "AAQkADA4NzY1YmI1LTI4MDc=";
const messageId = "AAMkADA4NzY1YmI1LTI4MDcAAqTl99HAAA=";

// Gmail routes on the thread, and always has.
assert.match(nativeUrlFor("google", conversationId), /mail\.google\.com.*#all/);

{
  const url = nativeUrlFor("microsoft", conversationId, { messageId });
  assert.match(url, /^https:\/\/outlook\.office\.com\/mail\/deeplink\/read\//);
  assert.ok(
    url.includes(encodeURIComponent(messageId)),
    "Outlook is given the message id",
  );
  assert.ok(
    !url.includes(encodeURIComponent(conversationId)),
    "the conversation id is not what Outlook resolves",
  );
  // The id has to appear twice — path and ItemID — or OWA drops it on redirect.
  assert.match(url, /\?ItemID=/);
  assert.match(url, /&exvsurl=1$/);
  assert.equal(url.match(/AAMkADA4NzY1YmI1LTI4MDcAAqTl99HAAA/g)?.length, 2);
  // Base64 ids carry "=" and "+"; unencoded they end the query early.
  assert.ok(!/read\/[^?]*[=+]/.test(url), "the id is url-encoded in the path");
}

// With no message to point at, the thread id is better than a dead link.
assert.match(
  nativeUrlFor("microsoft", conversationId),
  /outlook\.office\.com\/mail\/deeplink\/read\//,
);

console.log("v2-native-url: OK");
