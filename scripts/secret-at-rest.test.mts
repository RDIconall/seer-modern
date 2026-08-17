/**
 * Gate: no secret is ever persisted in the clear.
 *
 * The v2 corpus encrypted its OAuth tokens while the legacy documents kept a
 * second copy of the same tokens in plaintext — a live mailbox key sitting in
 * the database, which made the encryption beside the point. These tests pin
 * the sealing boundary: what goes to storage is unreadable, what comes back is
 * usable, and a wrong owner cannot open someone else's secret.
 */
import assert from "node:assert/strict";
import { isSealed, open, seal } from "../src/lib/store/secret-at-rest.ts";

const TOKEN = "1//0gRefreshTokenLooksLikeThis-abcdef123456";

// Round trip: sealed on the way out, identical on the way back.
{
  const sealed = seal(TOKEN, "google:conall@example.com");
  assert.ok(sealed && isSealed(sealed), "a secret must be sealed for storage");
  assert.ok(
    !JSON.stringify(sealed).includes(TOKEN),
    "THE POINT: the stored form must not contain the plaintext",
  );
  assert.equal(open(sealed, "google:conall@example.com"), TOKEN);
}

// A secret cannot be replayed under another account.
{
  const sealed = seal(TOKEN, "google:conall@example.com");
  assert.equal(
    open(sealed, "google:someone-else@example.com"),
    undefined,
    "a different owner must not be able to open the secret",
  );
}

// Tampering is detected rather than silently returning garbage.
{
  const sealed = seal(TOKEN, "acct")!;
  const tampered = { ...sealed, ciphertext: sealed.ciphertext.slice(0, -4) + "AAAA" };
  assert.equal(open(tampered, "acct"), undefined);
}

// Documents written before sealing existed still load, so nobody is logged out
// by the upgrade; the next write seals them.
{
  assert.equal(open(TOKEN, "acct"), TOKEN, "legacy plaintext must still read");
}

// Absent and empty values stay absent rather than becoming "".
{
  assert.equal(seal(undefined, "acct"), undefined);
  assert.equal(seal("", "acct"), undefined);
  assert.equal(open(undefined, "acct"), undefined);
  assert.equal(open("", "acct"), undefined);
}

// A malformed record fails closed instead of throwing on every request.
{
  assert.equal(open({ nonsense: true } as never, "acct"), undefined);
  assert.equal(isSealed({ v: 2, iv: "x", ciphertext: "y" }), false);
}

// Two seals of the same value differ — a fresh IV each time, so identical
// tokens across accounts are not correlatable in a dump.
{
  const a = JSON.stringify(seal(TOKEN, "acct"));
  const b = JSON.stringify(seal(TOKEN, "acct"));
  assert.notEqual(a, b, "each seal must use a fresh IV");
}

console.log("secret-at-rest: ok");
