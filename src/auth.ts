/* Future native client: legacy cookie names and /api routes in src/lib/future-ios.ts */
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import {
  accessTokenNeedsRefresh,
  refreshAccessToken,
} from "@/lib/mail/refresh-token";

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
                  "openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
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
                  "openid profile email offline_access User.Read Mail.ReadWrite Mail.Send",
              },
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;
        token.provider = account.provider;
        token.error = undefined;
        return token;
      }

      if (accessTokenNeedsRefresh(token)) {
        return refreshAccessToken(token);
      }

      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string | undefined;
      session.provider = token.provider as string | undefined;
      session.error = token.error as string | undefined;
      return session;
    },
  },
});
