/**
 * The cutover is done: every signed-in RDI account gets the V3 client.
 * There is no named-user allowlist.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isV2Enabled } from "../src/lib/v2/session.ts";

assert.equal(
  isV2Enabled("claire@rditrials.com"),
  true,
  "an RDI account is on the V3 client",
);
assert.equal(
  isV2Enabled("you@gmail.com"),
  false,
  "a non-RDI account is not on the V3 client",
);
assert.equal(
  isV2Enabled(null),
  false,
  "a signed-out visitor is never on the V3 client",
);

// Installing Seer on a desktop needs a manifest that covers the whole app,
// not just the mobile route the phone install has always used.
const desktop = JSON.parse(
  readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
) as { start_url: string; scope: string; display: string; icons: { sizes: string }[] };
assert.equal(desktop.start_url, "/");
assert.equal(desktop.scope, "/");
assert.equal(desktop.display, "standalone");
for (const size of ["192x192", "512x512"]) {
  assert.ok(
    desktop.icons.some((icon) => icon.sizes === size),
    `an installable app needs a ${size} icon`,
  );
}

const mobile = JSON.parse(
  readFileSync(
    new URL("../public/manifest.mobile.webmanifest", import.meta.url),
    "utf8",
  ),
) as { start_url: string; scope: string };
assert.equal(mobile.start_url, "/m");
assert.equal(mobile.scope, "/m");

const layout = readFileSync(
  new URL("../src/app/layout.tsx", import.meta.url),
  "utf8",
);
assert.match(layout, /manifest: "\/manifest\.webmanifest"/);

const mobileLayout = readFileSync(
  new URL("../src/app/m/layout.tsx", import.meta.url),
  "utf8",
);
assert.match(mobileLayout, /manifest: "\/manifest\.mobile\.webmanifest"/);

// The worker is what makes the browser offer to install at all, so it can no
// longer be limited to the phone route.
const register = readFileSync(
  new URL("../src/components/PwaRegister.tsx", import.meta.url),
  "utf8",
);
assert.match(register, /scope: "\/"/);
assert.doesNotMatch(
  register,
  /pathname\?\.startsWith\("\/m"\)/,
  "registration must no longer be limited to /m",
);

console.log("v3-default-client: OK");
