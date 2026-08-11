import {
  decryptCredential,
  encryptCredential,
  type EncryptedValue,
} from "@/lib/v2/crypto/credentials";

/**
 * Secrets stored in the KV documents, encrypted at rest.
 *
 * The v2 corpus encrypts its OAuth tokens, but the legacy account and CRM
 * documents kept a second copy of the same secrets in the clear — which
 * defeats the encryption entirely, since either copy opens the mailbox. These
 * helpers seal a value on the way to storage and open it on the way back, so
 * call sites keep handling plaintext and nothing plaintext is ever persisted.
 *
 * Reads accept a bare string so documents written before this existed still
 * load; every write re-seals them, and a migration pass converts the rest.
 */

/** A secret as it may appear on disk: sealed, or legacy plaintext. */
export type StoredSecret = string | EncryptedValue;

export function isSealed(value: unknown): value is EncryptedValue {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<EncryptedValue>;
  return v.v === 1 && typeof v.iv === "string" && typeof v.ciphertext === "string";
}

/** Encrypt for storage. `scope` binds the ciphertext to its owner. */
export function seal(
  plaintext: string | undefined,
  scope: string,
): EncryptedValue | undefined {
  if (plaintext === undefined || plaintext === "") return undefined;
  return encryptCredential(plaintext, scope);
}

/**
 * Decrypt a stored secret. A legacy plaintext value passes through unchanged.
 *
 * A sealed value that will not open is returned as undefined rather than
 * thrown: a key rotation or a corrupt record should log the user out and force
 * a reconnect, not crash every request that touches their account.
 */
export function open(
  value: StoredSecret | undefined,
  scope: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value || undefined;
  if (!isSealed(value)) return undefined;
  try {
    return decryptCredential(value, scope);
  } catch {
    return undefined;
  }
}
