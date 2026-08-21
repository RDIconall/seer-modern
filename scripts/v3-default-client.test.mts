/**
 * The cutover is done: the V3 client is what every signed-in account gets.
 * The allowlist survives only as a way to hold named accounts back.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const previous = process.env.SEER_V2_ACCOUNT_ALLOWLIST;

delete process.env.SEER_V2_ACCOUNT_ALLOWLIST;
const { isV2Enabled } = await import("../src/lib/v2/session.ts");

assert.equal(
  isV2Enabled("anyone@example.com"),
  true,
  "an unset allowlist must put everyone on the V3 client",
);
assert.equal(
  isV2Enabled(null),
  false,
  "a signed-out visitor is never on the V3 client",
);

process.env.SEER_V2_ACCOUNT_ALLOWLIST = "  ,  ";
assert.equal(
  isV2Enabled("anyone@example.com"),
  true,
  "an allowlist of nothing but separators is still no allowlist",
);

process.env.SEER_V2_ACCOUNT_ALLOWLIST = "kept@example.com";
assert.equal(isV2Enabled("kept@example.com"), true);
assert.equal(
  isV2Enabled("other@example.com"),
  false,
  "a configured allowlist still holds everyone else on the legacy client",
);

if (previous === undefined) delete process.env.SEER_V2_ACCOUNT_ALLOWLIST;
else process.env.SEER_V2_ACCOUNT_ALLOWLIST = previous;

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
