/* Future native client: legacy cookie names and /api routes in src/lib/future-ios.ts */
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import {
  accessTokenNeedsRefresh,
  refreshAccessToken,
} from "@/lib/mail/refresh-token";
import { setActiveAccountId, upsertAccount } from "@/lib/store/accounts";

const googleConfigured =
  Boolean(process.env.AUTH_GOOGLE_ID) &&
  Boolean(process.env.AUTH_GOOGLE_SECRET);

const microsoftConfigured =
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    ...(googleConfigured
      ? [
          Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
            authorization: {
              params: {
                prompt: "consent",
                access_type: "offline",
                response_type: "code",
                scope:
                  "openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/documents.readonly",
              },
            },
          }),
        ]
      : []),
    ...(microsoftConfigured
      ? [
          MicrosoftEntraID({
            clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
            clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
            issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
            authorization: {
              params: {
                scope:
                  "openid profile email offline_access User.Read Mail.ReadWrite Mail.Send Contacts.Read Calendars.Read",
              },
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token ?? token.refreshToken;
        token.expiresAt = account.expires_at;
        token.provider = account.provider;
        token.error = undefined;
        const email =
          (profile as { email?: string } | undefined)?.email ??
          (token.email as string | undefined);
        if (email && account.provider) {
          token.email = email;
          const saved = await upsertAccount({
            provider: account.provider as "google" | "microsoft-entra-id",
            email,
            name:
              (profile as { name?: string } | undefined)?.name ??
              email,
            accessToken: account.access_token,
            refreshToken: account.refresh_token ?? undefined,
            expiresAt: account.expires_at,
          });
          token.activeAccountId = saved.id;
          try {
            await setActiveAccountId(saved.id);
          } catch {
            /* cookies() may be unavailable in some auth runtimes */
          }
        }
        return token;
      }

      if (accessTokenNeedsRefresh(token)) {
        const refreshed = await refreshAccessToken(token);
        if (
          refreshed.accessToken &&
          !refreshed.error &&
          token.email &&
          token.provider
        ) {
          await upsertAccount({
            provider: token.provider as "google" | "microsoft-entra-id",
            email: token.email as string,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
          });
        }
        return refreshed;
      }

      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string | undefined;
      session.provider = token.provider as string | undefined;
      session.error = token.error as string | undefined;
      if (token.email && session.user) {
        session.user.email = token.email as string;
      }
      return session;
    },
  },
});
