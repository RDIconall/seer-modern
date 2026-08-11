/* Future native client: legacy cookie names and /api routes in src/lib/future-ios.ts */
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import {
  accessTokenNeedsRefresh,
  refreshAccessToken,
} from "@/lib/mail/refresh-token";
import {
  upsertAccountWithCredentials,
  upsertUser,
  saveCredentials,
} from "@/lib/v2/db/accounts";
import { asAccountId } from "@/lib/v2/db/types";
import {
  legacyAccountFallbackEnabled,
  setActiveAccountId,
} from "@/lib/store/accounts";

const googleConfigured =
  Boolean(process.env.AUTH_GOOGLE_ID) &&
  Boolean(process.env.AUTH_GOOGLE_SECRET);

const microsoftConfigured =
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  debug: process.env.AUTH_DEBUG === "1",
  logger: {
    error(error) {
      // Default Auth.js behavior hides the cause behind a generic
      // "Server error" page — log the real one for Vercel logs.
      console.error(
        "[auth] error:",
        error?.message,
        (error as { cause?: { err?: Error } })?.cause?.err?.message ?? "",
      );
    },
    warn(code) {
      console.warn("[auth] warn:", code);
    },
    debug(message, metadata) {
      if (process.env.AUTH_DEBUG === "1") {
        console.log("[auth] debug:", message, metadata ?? "");
      }
    },
  },
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
                  "openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/documents.readonly",
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
        const provider = toV2Provider(account.provider);
        if (email && provider) {
          token.email = email;
          const userId = await upsertUser(email);
          const saved = await upsertAccountWithCredentials({
            userId,
            provider,
            email,
            displayName:
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
          token.provider &&
          toV2Provider(token.provider)
        ) {
          const provider = toV2Provider(token.provider);
          if (!provider) return refreshed;
          const userId = await upsertUser(token.email as string);
          if (token.activeAccountId) {
            await saveCredentials(
              asAccountId(token.activeAccountId),
              provider,
              {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
                expiresAt: refreshed.expiresAt,
              },
            );
          } else {
            await upsertAccountWithCredentials({
              userId,
              provider,
              email: token.email as string,
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
            });
          }
        }
        return refreshed;
      }

      return token;
    },
    async session({ session, token }) {
      // V3 resolves credentials server-side from oauth_credentials. Expose a
      // token to the browser only while the explicitly enabled legacy
      // fallback is still being migrated.
      session.accessToken = legacyAccountFallbackEnabled()
        ? (token.accessToken as string | undefined)
        : undefined;
      session.provider = token.provider as string | undefined;
      session.error = token.error as string | undefined;
      if (token.email && session.user) {
        session.user.email = token.email as string;
      }
      return session;
    },
  },
});

function toV2Provider(
  provider: string | undefined,
): "google" | "microsoft" | undefined {
  if (provider === "google") return "google";
  if (provider === "microsoft-entra-id" || provider === "microsoft") {
    return "microsoft";
  }
  return undefined;
}
