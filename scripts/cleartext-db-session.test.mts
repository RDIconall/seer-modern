/**
 * Production sessions to a non-loopback Postgres must use TLS with
 * certificate verification when the operator omits sslmode.
 *
 * These tests fail while the v2 pool and the key-value pool still connect
 * in cleartext. They pass once a remote URL without sslmode negotiates
 * TLS before any startup or query message, and once production refuses a
 * remote sslmode=disable URL before opening a socket.
 *
 * Loopback URLs stay eligible for cleartext so embedded test databases
 * keep working. The unparseable key/value DSN branch is not part of this
 * file: production rejects it in validateProductionDatabaseUrl before a
 * pool is built.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_V3 = 196608;
const HOSTS = ["172.30.0.2", "172.17.0.1"];

const CREDENTIAL_AND_CORPUS_SQL =
  "select body_text, body_html, ciphertext from seer.messages m join seer.oauth_credentials c on c.account_id = m.account_id where m.conversation_id = $1";

type Capture = {
  sockets: number;
  tlsSockets: number;
  cleartextStartups: number;
  cleartextSnippets: string[];
};

function authOkAndReady(): Buffer {
  // pg-protocol parser: type byte, then int32 length that includes itself
  // but not the type. AuthenticationOk is code 0. ReadyForQuery is status I.
  const auth = Buffer.alloc(9);
  auth[0] = 82;
  auth.writeInt32BE(8, 1);
  auth.writeInt32BE(0, 5);
  const ready = Buffer.alloc(6);
  ready[0] = 90;
  ready.writeInt32BE(5, 1);
  ready[5] = 0x49;
  return Buffer.concat([auth, ready]);
}

function snippet(buf: Buffer): string {
  return buf
    .toString("utf8")
    .replace(/[^\t\n\r\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function observe(capture: Capture): net.Server {
  return net.createServer((socket) => {
    capture.sockets += 1;
    let buf = Buffer.alloc(0);
    let phase: "init" | "clear" | "tls" = "init";
    let countedTls = false;

    const noteTls = (chunk: Buffer) => {
      if (countedTls) return;
      if (chunk.length >= 3 && chunk[0] === 0x16 && chunk[1] === 0x03) {
        countedTls = true;
        capture.tlsSockets += 1;
        socket.end();
      }
    };

    socket.on("data", (chunk) => {
      if (phase === "tls") {
        noteTls(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      if (phase === "init" && buf.length >= 3 && buf[0] === 0x16 && buf[1] === 0x03) {
        phase = "tls";
        noteTls(buf);
        return;
      }
      if (phase === "init" && buf.length >= 8) {
        const length = buf.readInt32BE(0);
        const code = buf.readInt32BE(4);
        if (length === 8 && code === SSL_REQUEST_CODE) {
          phase = "tls";
          socket.write("S");
          const rest = buf.subarray(8);
          if (rest.length > 0) noteTls(rest);
          return;
        }
        if (code === PROTOCOL_V3 && length >= 8 && buf.length >= length) {
          phase = "clear";
          capture.cleartextStartups += 1;
          capture.cleartextSnippets.push(snippet(buf));
          socket.write(authOkAndReady());
        }
      }
      if (phase === "clear") {
        const text = snippet(buf);
        if (
          text.includes("body_text") ||
          text.includes("ciphertext") ||
          text.includes("seer_kv")
        ) {
          capture.cleartextSnippets.push(text);
          socket.end();
        }
      }
    });
    socket.on("error", () => {});
  });
}

async function listen(capture: Capture): Promise<{ host: string; port: number; server: net.Server }> {
  let lastError: unknown;
  for (const host of HOSTS) {
    const server = observe(capture);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a TCP address");
      }
      return { host, port: address.port, server };
    } catch (error) {
      lastError = error;
      server.close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no non-loopback address accepted a listener");
}

function databaseUrl(host: string, port: number, sslmode?: "disable"): string {
  const query = sslmode ? `?sslmode=${sslmode}` : "";
  return `postgres://seer_app:placeholder@${host}:${port}/seer${query}`;
}

function clearPgSslEnv(): void {
  delete process.env.PGSSLMODE;
  delete process.env.PGSSLNEGOTIATION;
  delete process.env.PGSSLROOTCERT;
  delete process.env.PGSSLCERT;
  delete process.env.PGSSLKEY;
}

function assertVerifiedTls(ssl: unknown, label: string): void {
  assert.ok(ssl && typeof ssl === "object", `${label} must enable TLS`);
  const opts = ssl as { rejectUnauthorized?: boolean };
  assert.equal(
    opts.rejectUnauthorized,
    true,
    `${label} must verify the server certificate`,
  );
}

async function runOmit(): Promise<void> {
  clearPgSslEnv();
  const capture: Capture = {
    sockets: 0,
    tlsSockets: 0,
    cleartextStartups: 0,
    cleartextSnippets: [],
  };
  const listener = await listen(capture);
  const url = databaseUrl(listener.host, listener.port);
  process.env.NODE_ENV = "production";
  process.env.SEER_V2_DATABASE_URL = url;

  const { db, resolveSsl } = await import("../src/lib/v2/db/pool.ts");
  const { pgGet } = await import("../src/lib/store/pg.ts");

  const failures: unknown[] = [];
  const note = (error: unknown) => {
    failures.push(error);
  };
  try {
    const resolved = resolveSsl(
      "postgres://seer_app:placeholder@db.example.com:5432/seer",
    );
    assertVerifiedTls(resolved.ssl, "resolveSsl for a remote host with no sslmode");
    assert.equal(
      resolved.connectionString.includes("sslmode"),
      false,
      "sslmode stays stripped so node-pg cannot drop the ssl object",
    );
  } catch (error) {
    note(error);
  }

  try {
    const pool = db();
    pool.on("error", () => {});
    const configured = pool.options as { ssl?: unknown; connectionString?: string };
    try {
      assertVerifiedTls(configured.ssl, "v2 pool");
      assert.equal(
        String(configured.connectionString).includes("sslmode"),
        false,
        "v2 pool connection string must not carry sslmode",
      );
    } catch (error) {
      note(error);
    }

    await Promise.all([
      pool
        .query(CREDENTIAL_AND_CORPUS_SQL, ["corpus-marker"])
        .catch((error: unknown) => error),
      pgGet("accounts").catch((error: unknown) => error),
    ]);
  } catch (error) {
    note(error);
  }

  try {
    assert.equal(
      capture.cleartextStartups,
      0,
      `startup and query bytes were readable before TLS: ${capture.cleartextSnippets.join(" | ")}`,
    );
    assert.ok(
      capture.tlsSockets >= 2,
      `v2 pool and key-value pool must each send a TLS ClientHello (tls=${capture.tlsSockets}, sockets=${capture.sockets})`,
    );
  } catch (error) {
    note(error);
  } finally {
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    throw failures[0];
  }
}

async function runDisable(): Promise<void> {
  clearPgSslEnv();
  const capture: Capture = {
    sockets: 0,
    tlsSockets: 0,
    cleartextStartups: 0,
    cleartextSnippets: [],
  };
  const listener = await listen(capture);
  const url = databaseUrl(listener.host, listener.port, "disable");
  process.env.NODE_ENV = "production";
  process.env.SEER_V2_DATABASE_URL = url;

  const { db, resolveDatabaseUrl } = await import("../src/lib/v2/db/pool.ts");
  const { pgGet } = await import("../src/lib/store/pg.ts");

  const failures: unknown[] = [];
  const note = (error: unknown) => {
    failures.push(error);
  };
  try {
    assert.throws(
      () => resolveDatabaseUrl({ NODE_ENV: "production", SEER_V2_DATABASE_URL: url }),
      /ssl|tls|cleartext|encrypt/i,
      "production must reject a remote URL that asks for cleartext",
    );
  } catch (error) {
    note(error);
  }

  try {
    const pool = db();
    pool.on("error", () => {});
    await pool.query(
      "select ciphertext from seer.oauth_credentials where account_id = $1",
      ["corpus-marker"],
    );
    note(new Error("db() connected instead of refusing a remote sslmode=disable URL"));
  } catch (error) {
    try {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /ssl|tls|cleartext|encrypt/i,
        "db() must refuse a remote cleartext URL before connecting",
      );
    } catch (assertError) {
      note(assertError);
    }
  }

  try {
    await pgGet("accounts");
    note(new Error("pgGet connected instead of refusing a remote sslmode=disable URL"));
  } catch (error) {
    try {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /ssl|tls|cleartext|encrypt/i,
        "pgGet must refuse a remote cleartext URL before connecting",
      );
    } catch (assertError) {
      note(assertError);
    }
  }

  try {
    assert.equal(
      capture.sockets,
      0,
      `a pool opened a session before refusing the URL: ${capture.cleartextSnippets.join(" | ")}`,
    );
    assert.equal(capture.cleartextStartups, 0);
    assert.doesNotThrow(() =>
      resolveDatabaseUrl({
        NODE_ENV: "production",
        SEER_V2_DATABASE_URL:
          "postgres://seer_app:placeholder@127.0.0.1:5432/seer?sslmode=disable",
      }),
    );
  } catch (error) {
    note(error);
  } finally {
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    throw failures[0];
  }
}

const scenario = process.env.SEER_CLEARTEXT_CASE;
if (scenario === "omit") {
  await runOmit();
  console.log("cleartext db session omit: observed TLS requirement");
} else if (scenario === "disable") {
  await runDisable();
  console.log("cleartext db session disable: production refused before connect");
} else if (!scenario) {
  let failed = false;
  for (const name of ["omit", "disable"]) {
    const result = spawnSync(TSX, [fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, SEER_CLEARTEXT_CASE: name },
    });
    if (result.status !== 0) failed = true;
  }
  if (failed) process.exit(1);
  console.log("cleartext db session: ok");
} else {
  throw new Error(`unknown SEER_CLEARTEXT_CASE ${scenario}`);
}
