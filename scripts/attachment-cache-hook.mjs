/**
 * The attachment routes import mailbox I/O by alias. tsx resolves those
 * aliases inside its loader, so a resolve hook never sees them. This load
 * hook rewrites those imports to the test stubs and transpiles the route
 * before tsx bundles the real modules in.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const stub = (name) => new URL(`./attachment-cache-stubs/${name}`, import.meta.url).href;

const replacements = [
  ["@/lib/mail/session", stub("mail-session.ts")],
  ["@/lib/mail/gmail", stub("gmail.ts")],
  ["@/lib/mail/graph", stub("graph.ts")],
  ["@/lib/v2/session", stub("v2-session.ts")],
  ["@/lib/v2/providers/provider", stub("provider.ts")],
  ["@/lib/v3/attachments/repository", stub("repository.ts")],
];

export async function load(url, context, nextLoad) {
  if (!url.includes("/src/app/api/") || !url.endsWith("route.ts")) {
    return nextLoad(url, context);
  }
  let source = readFileSync(fileURLToPath(url), "utf8");
  let touched = false;
  for (const [specifier, target] of replacements) {
    const quoted = `"${specifier}"`;
    if (!source.includes(quoted)) continue;
    source = source.replaceAll(quoted, JSON.stringify(target));
    touched = true;
  }
  if (!touched) return nextLoad(url, context);
  const result = transformSync(source, {
    loader: "ts",
    format: "esm",
    jsx: "automatic",
    sourcefile: url,
  });
  return { format: "module", source: result.code, shortCircuit: true };
}
