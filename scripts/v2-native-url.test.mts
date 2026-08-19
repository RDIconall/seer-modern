import assert from "node:assert/strict";
import { nativeUrlFor } from "../src/lib/v2/providers/native-url.ts";

const conv = "AAQkADOUpag6yWs=";
const msg = "AAMkADMGAAA=";

assert.match(
  nativeUrlFor("google", conv),
  /mail\.google\.com.*#all/,
  "Gmail still opens the thread",
);

const outlook = nativeUrlFor("microsoft", conv, { messageId: msg });
assert.match(outlook, /^https:\/\/outlook\.office\.com\/mail\/deeplink\/read\//);
assert.match(outlook, /ItemID=/);
assert.match(outlook, /exvsurl=1/);
assert.ok(outlook.includes(encodeURIComponent(msg)), "Outlook uses the message id, not the conversation id");

assert.equal(
  nativeUrlFor("microsoft", conv, {
    webLink: "https://outlook.office365.com/owa/?ItemID=abc&exvsurl=1&viewmodel=ReadMessageItem",
  }),
  "https://outlook.office365.com/owa/?ItemID=abc&exvsurl=1&viewmodel=ReadMessageItem",
  "Graph webLink wins when we have it",
);

console.log("v2-native-url: OK");
