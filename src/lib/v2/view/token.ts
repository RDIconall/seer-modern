import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A delete row carries a signed token binding the exact decision that made it
 * deletable. The command bus verifies this token, so the browser can never
 * authorize a deletion from a raw disposition or a stale decision — it can only
 * replay a decision the server itself minted and still considers current.
 */

function secret(): string {
  return (
    process.env.SEER_V2_COMMAND_SECRET ||
    process.env.AUTH_SECRET ||
    (process.env.NODE_ENV === "production"
      ? (() => {
          throw new Error("SEER_V2_COMMAND_SECRET or AUTH_SECRET required in production");
        })()
      : "dev-only-command-secret")
  );
}

export function signDecisionToken(decisionId: string, conversationId: string): string {
  const payload = `${decisionId}.${conversationId}`;
  const mac = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyDecisionToken(
  token: string,
): { decisionId: string; conversationId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [decisionId, conversationId, mac] = parts;
  const expected = createHmac("sha256", secret())
    .update(`${decisionId}.${conversationId}`)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { decisionId, conversationId };
}
