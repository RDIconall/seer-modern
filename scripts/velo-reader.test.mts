import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hasRemoteImages,
  restoreRemoteImages,
  stripRemoteImages,
} from "../src/lib/v3/reader/remote-images.ts";

const original = [
  '<p>Hello<img src="https://tracker.example/pixel.gif" width="1"></p>',
  '<img src="cid:logo">',
  '<img src="data:image/png;base64,abc">',
  '<div style="background-image:url(https://tracker.example/bg.png)">x</div>',
].join("");

const blocked = stripRemoteImages(original);
assert.equal(hasRemoteImages(blocked), true);
assert.doesNotMatch(blocked, /<img[^>]*\ssrc="https:\/\/tracker/);
assert.match(blocked, /data-blocked-src="https:\/\/tracker\.example\/pixel\.gif"/);
assert.match(blocked, /src="cid:logo"/, "inline CID images stay available");
assert.match(blocked, /src="data:image/, "embedded images stay available");
assert.doesNotMatch(blocked, /background-image:url\(https:/);
assert.match(restoreRemoteImages(blocked), /src="https:\/\/tracker\.example\/pixel\.gif"/);

const component = readFileSync(
  new URL("../src/components/v2/MessageHtml.tsx", import.meta.url),
  "utf8",
);
assert.match(component, /<iframe/);
assert.match(component, /sandbox=/);
assert.match(component, /srcDoc=/);
assert.match(component, /Show remote images/);
assert.doesNotMatch(component, /dangerouslySetInnerHTML/);

const shared = readFileSync(
  new URL("../src/components/mail/MailReader.tsx", import.meta.url),
  "utf8",
);
assert.match(shared, /MessageHtml/);

for (const file of [
  "../src/components/inbox/DesktopMailApp.tsx",
  "../src/components/inbox/MobileMailApp.tsx",
]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(source, /LegacyThread/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
}

const thread = readFileSync(
  new URL("../src/components/v2/Reader.tsx", import.meta.url),
  "utf8",
);
assert.match(
  thread,
  /lane\.quotedCount === 0[\s\S]*lane\.message\.bodyHtml/,
);

console.log("velo-reader: OK");
