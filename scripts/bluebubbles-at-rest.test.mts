/**
 * The BlueBubbles server secret must not be readable from a copy of the
 * key-value table. OAuth tokens and Salesforce secrets are sealed before
 * kvSet; this save path has to do the same.
 *
 * These assertions fail while the password is stored as a plaintext JSON
 * string. They pass once the stored field is sealed to the normalized
 * account email and loadBlueBubbles opens it only in memory.
 *
 * The Settings handler (src/app/api/imessage/route.ts) trims the URL and
 * password, probes the server, then calls saveBlueBubbles. This test drives
 * that same sequence. The session gate in front of the handler is not part
 * of the storage bug and is not invoked here.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const SERVER_URL = "https://imessage.example.test";
const PLACEHOLDER = "placeholder-server-secret";

type StoredConfig = {
  url?: string;
  password?: unknown;
  savedAt?: string;
};

const db = await startTestDb();
try {
  const opts = db.pool.options as {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  };
  if (!opts.user || opts.password == null || !opts.database || opts.port == null) {
    throw new Error("test database pool did not expose connection fields");
  }
  const host = opts.host && opts.host.length > 0 ? opts.host : "localhost";
  process.env.POSTGRES_URL = `postgres://${encodeURIComponent(opts.user)}:${encodeURIComponent(opts.password)}@${host}:${opts.port}/${opts.database}`;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.DATABASE_URL;
  delete process.env.SEER_V2_DATABASE_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.SEER_CREDENTIAL_KEY;

  const { accountKey } = await import("../src/lib/store/kv.ts");
  const { isSealed, open } = await import("../src/lib/store/secret-at-rest.ts");
  const { loadBlueBubbles, saveBlueBubbles, syncTexting, testBlueBubbles } =
    await import("../src/lib/imessage/bluebubbles.ts");

  const ownerScope = accountKey(OWNER);
  const otherScope = accountKey(OTHER);
  const seenUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(url);
    const path = url.split("?")[0] ?? "";
    if (path.endsWith("/api/v1/server/info")) {
      return Response.json({ data: { server_version: "0", os_version: "test" } });
    }
    if (path.endsWith("/api/v1/contact")) {
      return Response.json({ data: [] });
    }
    if (path.endsWith("/api/v1/chat/query")) {
      assert.equal(init?.method, "POST");
      return Response.json({ data: [] });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  }) as typeof fetch;

  try {
    // POST action "save" trims, probes, then persists. saveBlueBubbles
    // strips a trailing slash on the way into the document.
    const submittedUrl = `  ${SERVER_URL}/  `.trim();
    const submittedSecret = `  ${PLACEHOLDER}  `.trim();
    const probe = await testBlueBubbles({
      url: submittedUrl,
      password: submittedSecret,
    });
    assert.equal(probe.ok, true);
    await saveBlueBubbles(OWNER, {
      url: submittedUrl,
      password: submittedSecret,
    });

    const raw = await db.pool.query<{ key: string; value: string }>(
      "select key, value::text as value from public.seer_kv",
    );
    assert.ok(raw.rows.length > 0, "save must write a key-value row");

    for (const row of raw.rows) {
      assert.equal(
        row.value.includes(PLACEHOLDER),
        false,
        `key-value row ${row.key} stores the server secret in the clear`,
      );
    }

    const configRow = raw.rows.find((row) => row.key.startsWith("bluebubbles:"));
    assert.ok(configRow, "expected a bluebubbles config row");
    const stored = JSON.parse(configRow.value) as StoredConfig;
    assert.equal(stored.url, SERVER_URL);
    assert.equal(
      isSealed(stored.password),
      true,
      "the stored password must be a sealed credential, not a string",
    );
    assert.equal(open(stored.password, ownerScope), PLACEHOLDER);
    assert.equal(
      open(stored.password, otherScope),
      undefined,
      "a sealed password bound to one account email must not open for another",
    );

    const loaded = await loadBlueBubbles(OWNER);
    assert.equal(loaded?.url, SERVER_URL);
    assert.equal(loaded?.password, PLACEHOLDER);
    assert.equal(await loadBlueBubbles(OTHER), null);

    seenUrls.length = 0;
    await syncTexting(OWNER);
    assert.ok(
      seenUrls.some((url) => url.includes(encodeURIComponent(PLACEHOLDER))),
      "an in-flight sync must still present the opened secret to the user's server",
    );

    const afterSync = await db.pool.query<{ key: string; value: string }>(
      "select key, value::text as value from public.seer_kv",
    );
    for (const row of afterSync.rows) {
      assert.equal(
        row.value.includes(PLACEHOLDER),
        false,
        `key-value row ${row.key} stores the server secret in the clear after sync`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  await db.stop();
}

console.log("bluebubbles-at-rest: ok");
