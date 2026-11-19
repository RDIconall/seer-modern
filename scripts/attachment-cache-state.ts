import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Shared by the test and the stubs. globalThis keeps one copy if tsx loads
 * this file twice (the pool module documents the same split).
 */
const ALS = Symbol.for("seer.attachment-cache.als");
const STATE = Symbol.for("seer.attachment-cache.state");

export type AttachmentCacheStore = {
  signedIn: boolean;
};

type GlobalState = {
  als: AsyncLocalStorage<AttachmentCacheStore>;
  /** Placeholder standing in for the mailbox OAuth access token. */
  accessToken: string;
  accountId: string;
  legacyProvider: "google" | "microsoft-entra-id";
  messageId: string;
  /** Provider attachment id, after synthetic id resolution. */
  providerAttachmentId: string;
  conversationId: string;
  mimeType: string;
  filename: string;
  bytes: Buffer;
  calls: { fn: string; args: unknown[] }[];
};

function createState(): GlobalState {
  return {
    als: new AsyncLocalStorage<AttachmentCacheStore>(),
    accessToken: "placeholder-access-token",
    accountId: "acct-1",
    legacyProvider: "google",
    messageId: "msg1",
    providerAttachmentId: "prov-att",
    conversationId: "conv-1",
    mimeType: "text/plain",
    filename: "invoice.txt",
    bytes: Buffer.from("INVOICE-BODY-7f3a9c"),
    calls: [],
  };
}

type GlobalWithState = typeof globalThis & {
  [ALS]?: AsyncLocalStorage<AttachmentCacheStore>;
  [STATE]?: GlobalState;
};

export function attachmentCacheAls(): AsyncLocalStorage<AttachmentCacheStore> {
  const g = globalThis as GlobalWithState;
  if (!g[ALS]) g[ALS] = new AsyncLocalStorage();
  return g[ALS];
}

export function attachmentCacheState(): GlobalState {
  const g = globalThis as GlobalWithState;
  if (!g[STATE]) g[STATE] = createState();
  // The ALS on the state object and the symbol must be the same store.
  g[STATE].als = attachmentCacheAls();
  return g[STATE];
}

export function signedInNow(): boolean {
  return attachmentCacheAls().getStore()?.signedIn === true;
}

export function noteCall(fn: string, args: unknown[]): void {
  attachmentCacheState().calls.push({ fn, args });
}
