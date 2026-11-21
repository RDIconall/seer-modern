const aiMock = new URL("./public-suffix-ai-mock.cjs", import.meta.url).href;
const sessionMock = new URL("./public-suffix-session-mock.cjs", import.meta.url).href;

function isSessionSpecifier(specifier) {
  return (
    specifier === "@/lib/mail/session" ||
    specifier.endsWith("/lib/mail/session.ts") ||
    specifier.endsWith("/lib/mail/session.js") ||
    specifier.endsWith("/src/lib/mail/session.ts")
  );
}

/**
 * Intercept the two modules the tests must not call for real: the model
 * SDK (no network, and the clustering pass is a scripted leftover) and
 * the mail session (the route's own close loop still runs).
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "ai") {
    return { url: aiMock, shortCircuit: true };
  }
  if (isSessionSpecifier(specifier)) {
    return { url: sessionMock, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
