import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * Envelope encryption for provider secrets. OAuth refresh tokens and
 * integration passwords are encrypted at rest with AES-256-GCM and never
 * stored, logged, or returned in plaintext. The account id is bound in as
 * additional authenticated data, so ciphertext from one account cannot be
 * replayed under another.
 *
 * The key is a 32-byte value provided as `SEER_CREDENTIAL_KEY` (base64 or hex).
 * In production a missing or wrong-length key is a hard error — we never fall
 * back to storing secrets in the clear.
 */

export type EncryptedValue = {
  v: 1;
  iv: string;
  ciphertext: string;
  tag: string;
};

const VERSION = 1 as const;

function key(): Buffer {
  const raw = process.env.SEER_CREDENTIAL_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SEER_CREDENTIAL_KEY is required in production");
    }
    // Deterministic dev-only key so local tests don't need secrets. Never used
    // when NODE_ENV=production because of the guard above.
    return Buffer.alloc(32, 7);
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("SEER_CREDENTIAL_KEY must decode to exactly 32 bytes");
  }
  return buf;
}

export function encryptCredential(
  plaintext: string,
  accountId: string,
): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(accountId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    v: VERSION,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptCredential(
  value: EncryptedValue,
  accountId: string,
): string {
  if (value.v !== VERSION) {
    throw new Error(`unsupported credential version ${String(value.v)}`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(accountId, "utf8"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  // A tampered ciphertext, tag, or wrong account id throws here with an
  // authentication error — exactly what the caller must not swallow.
  return (
    decipher.update(Buffer.from(value.ciphertext, "base64")).toString("utf8") +
    decipher.final("utf8")
  );
}
