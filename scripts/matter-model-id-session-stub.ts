/** Test stand-in for requireMailSession. The mailbox archive calls stay real. */
export async function requireMailSession() {
  return (
    (globalThis as { __seerMailSession?: {
      email: string;
      provider: "google" | "microsoft-entra-id";
      accessToken: string;
    } }).__seerMailSession ?? null
  );
}
