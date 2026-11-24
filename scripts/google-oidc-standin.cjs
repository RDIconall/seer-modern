/**
 * Test stand-in for Google's OpenID discovery and token endpoint.
 *
 * Loaded with NODE_OPTIONS=--require into the Next.js server. Auth.js still
 * discovers the issuer, posts the authorization code, and parses the ID token
 * with the oauth4webapi version this app ships. The code is `claims.` plus
 * base64url JSON of the ID-token claims the stand-in should sign. That is the
 * test's way of choosing which Google account completed the login. The product
 * never reads those claims from the code; it reads them from the ID token.
 */
const { generateKeyPairSync, sign } = require("node:crypto");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const realFetch = globalThis.fetch.bind(globalThis);
const ISSUER = "https://accounts.google.com";

function b64url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64url");
}

function idToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    aud: process.env.AUTH_GOOGLE_ID,
    sub: claims.sub,
    iat: now,
    exp: now + 3600,
    email: claims.email,
    name: claims.name ?? claims.email,
  };
  if (Object.prototype.hasOwnProperty.call(claims, "email_verified")) {
    payload.email_verified = claims.email_verified;
  }
  if (Object.prototype.hasOwnProperty.call(claims, "hd")) {
    payload.hd = claims.hd;
  }
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${b64url(signature)}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.origin === ISSUER && url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
      token_endpoint: "https://oauth2.googleapis.com/token",
      userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    const raw =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";
    const code = new URLSearchParams(raw).get("code") ?? "";
    if (!code.startsWith("claims.")) {
      return json({ error: "invalid_grant" }, 400);
    }
    let claims;
    try {
      claims = JSON.parse(Buffer.from(code.slice("claims.".length), "base64url").toString("utf8"));
    } catch {
      return json({ error: "invalid_grant" }, 400);
    }
    return json({
      access_token: "placeholder-google-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "placeholder-google-refresh-token",
      scope: "openid email profile",
      id_token: idToken(claims),
    });
  }
  if (
    url.hostname === "accounts.google.com" ||
    url.hostname.endsWith(".googleapis.com") ||
    url.hostname.endsWith(".googleusercontent.com")
  ) {
    return new Response("google stand-in has no such endpoint", { status: 404 });
  }
  return realFetch(input, init);
};
