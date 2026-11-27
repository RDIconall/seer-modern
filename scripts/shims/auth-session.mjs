export async function auth() {
  return globalThis.__seerMailboxTestAuth ?? null;
}

export const handlers = {};

export async function signIn() {
  throw new Error("signIn is not part of this test");
}

export async function signOut() {
  throw new Error("signOut is not part of this test");
}
