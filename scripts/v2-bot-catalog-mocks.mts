/**
 * Stand-in for the Next.js request scope and the Auth.js session cookie.
 *
 * `cookies()` throws outside a Next request (`next/dist/server/request/cookies.js`
 * calls `throwForMissingRequestStore`). A signed-in desk with no active-account
 * cookie is a real state: `getActiveAccountId` then returns null and
 * `resolveMailboxAccount` selects the mailbox by the session email.
 * `auth()` is the session produced after sign-in. The org-email gate in
 * `getActiveV2Account` still runs on whatever email this holds.
 */
import { mock } from "node:test";

export const sessionState: {
  email: string | null;
  activeAccountId: string | null;
} = {
  email: null,
  activeAccountId: null,
};

mock.module("@/auth", {
  namedExports: {
    auth: async () => {
      if (!sessionState.email) return null;
      return {
        user: { email: sessionState.email },
        activeAccountId: sessionState.activeAccountId,
      };
    },
    handlers: {},
    signIn: async () => undefined,
    signOut: async () => undefined,
  },
});

mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
    }),
  },
});
