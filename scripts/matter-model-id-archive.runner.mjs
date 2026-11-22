/**
 * Runs the matter-id archive tests.
 *
 * tsx's preflight resolves the app's @/ imports. The alias preload redirects
 * only the mail-session module to a test stand-in so the matters route can
 * run without a browser login. gmailThreadAction and graphThreadAction stay
 * the real ones; fetch is recorded by the test.
 *
 * Run: node scripts/matter-model-id-archive.runner.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

if (process.env.SEER_MATTER_ID_TEST_CHILD !== "1") {
  const child = spawnSync(
    process.execPath,
    [
      "--require",
      path.join(here, "matter-model-id-alias.cjs"),
      "--require",
      path.join(root, "node_modules/tsx/dist/preflight.cjs"),
      "--import",
      "tsx",
      path.join(here, "matter-model-id-archive.test.mts"),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        SEER_MATTER_ID_TEST_CHILD: "1",
        TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json"),
        SEER_DATA_DIR: mkdtempSync(path.join(tmpdir(), "seer-matter-ids-")),
        POSTGRES_URL: "",
        POSTGRES_PRISMA_URL: "",
        DATABASE_URL: "",
        SEER_V2_DATABASE_URL: "",
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
        KV_REST_API_URL: "",
        KV_REST_API_TOKEN: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
        GEMINI_API_KEY: "",
        AI_GATEWAY_API_KEY: "",
        VERCEL_OIDC_TOKEN: "",
        VERCEL: "",
      },
    },
  );
  process.exit(child.status ?? 1);
}
