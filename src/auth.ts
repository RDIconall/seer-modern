/* Future native client: legacy cookie names and /api routes in src/lib/future-ios.ts */
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import {
  accessTokenNeedsRefresh,
  refreshAccessToken,
} from "@/lib/mail/refresh-token";
import {
  getCredentials,
  getOwnedAccount,
  markCredentialsReconnectRequired,
  upsertAccountWithCredentials,
  upsertUser,
  saveCredentials,
} from "@/lib/v2/db/accounts";
import { asAccountId, type UserId } from "@/lib/v2/db/types";
import {
  consumeAccountLinkState,
  type AccountLinkProvider,
} from "@/lib/auth/account-link";
import { setActiveAccountId } from "@/lib/store/accounts";

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
        const provider = toV2Provider(account.provider);
        if (provider) {
          const linkState = await consumeAccountLinkState(
            toLinkProvider(account.provider),
          );
          if (linkState.status === "invalid") {
            throw new Error("Invalid or expired account link state");
          }
          const profileEmail = (profile as { email?: string } | undefined)?.email;
          if (linkState.status === "valid" && !profileEmail) {
            throw new Error("Linked provider email is missing");
          }
          const providerEmail =
            profileEmail ?? (token.email as string | undefined);
          if (!providerEmail) {
            throw new Error("Provider email is missing");
          }
          const existingOwner = token.email as string | undefined;
          if (
            linkState.status === "valid" &&
            existingOwner &&
            existingOwner.toLowerCase() !==
              linkState.payload.ownerEmail.toLowerCase()
          ) {
            throw new Error("Account link owner mismatch");
          }
          if (
            linkState.status === "none" &&
            existingOwner &&
            existingOwner.toLowerCase() !== providerEmail.toLowerCase()
          ) {
            throw new Error("Account link state required");
          }
          const ownerEmail =
            linkState.status === "valid"
              ? linkState.payload.ownerEmail
              : providerEmail;
          const ownerUserId: UserId =
            linkState.status === "valid"
              ? (linkState.payload.ownerUserId as UserId)
              : await upsertUser(ownerEmail);
          if (linkState.status === "valid" && linkState.payload.accountId) {
            const linked = await getOwnedAccount(
              ownerUserId,
              asAccountId(linkState.payload.accountId),
            );
            if (!linked || linked.provider !== provider) {
              throw new Error("Account link target is not owned by user");
            }
          }
          const saved = await upsertAccountWithCredentials({
            userId: ownerUserId,
            provider,
            email: providerEmail,
            displayName:
              (profile as { name?: string } | undefined)?.name ??
              providerEmail,
            accessToken: account.access_token,
            refreshToken: account.refresh_token ?? undefined,
            expiresAt: account.expires_at,
          });
          token.email = ownerEmail;
          token.activeAccountId = saved.id;
          token.accessToken = undefined;
          token.refreshToken = undefined;
          try {
            await setActiveAccountId(saved.id);
          } catch {
            /* cookies() may be unavailable in some auth runtimes */
          }
          // Enroll provider push off the auth hot path — cron remains the net.
          void import("@/lib/v2/push/ensure")
            .then(({ ensurePushForAccount }) => ensurePushForAccount(saved))
            .catch((e) =>
              console.error(
                "[seer] push enroll failed",
                saved.email,
                e instanceof Error ? e.message : e,
              ),
            );
        }
        return token;
      }

      if (accessTokenNeedsRefresh(token)) {
        const provider = toV2Provider(token.provider);
        if (!provider || !token.activeAccountId) {
          return { ...token, error: "CanonicalAccountMissing" };
        }
        const credentials = await getCredentials(
          asAccountId(token.activeAccountId),
        );
        if (!credentials?.refreshToken) {
          if (token.activeAccountId) {
            await markCredentialsReconnectRequired(
              asAccountId(token.activeAccountId),
              "refresh token missing",
            );
          }
          return { ...token, error: "RefreshTokenMissing" };
        }
        const refreshed = await refreshAccessToken({
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          expiresAt: credentials.expiresAt
            ? Math.floor(credentials.expiresAt / 1000)
            : undefined,
          provider: accountProvider(token.provider),
        });
        if (!refreshed.accessToken || refreshed.error) {
          await markCredentialsReconnectRequired(
            asAccountId(token.activeAccountId),
            refreshed.error ?? "refresh access token missing",
          );
          return {
            ...token,
            accessToken: undefined,
            refreshToken: undefined,
            error: refreshed.error ?? "RefreshAccessTokenError",
          };
        }
        await saveCredentials(
          asAccountId(token.activeAccountId),
          provider,
          {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
          },
        );
        return {
          ...token,
          accessToken: undefined,
          refreshToken: undefined,
          expiresAt: refreshed.expiresAt,
          error: undefined,
        };
      }

      return token;
    },
    async session({ session, token }) {
      // V3 resolves credentials server-side from oauth_credentials. Provider
      // credentials never cross the Auth.js session boundary.
      session.accessToken = undefined;
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

function toLinkProvider(provider: string): AccountLinkProvider {
  if (provider === "google") return "google";
  if (provider === "microsoft-entra-id") return "microsoft-entra-id";
  throw new Error("Unsupported OAuth provider");
}

function accountProvider(
  provider: string | undefined,
): "google" | "microsoft-entra-id" {
  return provider === "google" ? "google" : "microsoft-entra-id";
}
