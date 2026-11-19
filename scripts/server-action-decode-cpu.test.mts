/**
 * Server Action reply decoding spends CPU in proportion to the square of the
 * number of multipart fields on the Next.js build this app ships.
 *
 * next start loads next/dist/compiled/next-server/app-page.runtime.prod.js
 * (module.compiled.js chooses it when TURBOPACK is unset). That runtime's
 * ReactServerDOMWebpackServer.decodeReplyFromBusboy is what
 * next/dist/server/app-render/action-handler.js calls for a Node multipart
 * fetch action, after the body-size pipe and the same busboy options
 * (defParamCharset utf8, fieldSize = the default 1MB limit).
 * app-page-turbo.runtime.prod.js is the copy used when TURBOPACK=1.
 *
 * A body under that 1MB limit must decode successfully and return within
 * DECODE_BUDGET_MS. next 15.5.23 blocks the process for much longer; 15.5.28
 * does not. Run:
 *   node --experimental-strip-types scripts/server-action-decode-cpu.test.mts
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Default Server Action body limit in action-handler.js (1024 * 1024).
const BODY_LIMIT_BYTES = 1024 * 1024;
// Fixed builds decode the payloads below in well under 200ms here.
// Vulnerable builds take about a second on the $K payload. 400ms sits between
// those, including the slower of the two production runtimes.
const DECODE_BUDGET_MS = 400;
const FIELD_COUNT = 14_000;

type ReplyServer = {
  decodeReplyFromBusboy: (
    busboy: NodeJS.EventEmitter,
    manifest: unknown,
    options?: unknown,
  ) => Promise<unknown>;
};

type RuntimeSpec = {
  label: string;
  file: string;
  exportName: "ReactServerDOMWebpackServer" | "ReactServerDOMTurbopackServer";
};

const RUNTIMES: RuntimeSpec[] = [
  {
    label: "next start (webpack production runtime)",
    file: "next/dist/compiled/next-server/app-page.runtime.prod.js",
    exportName: "ReactServerDOMWebpackServer",
  },
  {
    label: "TURBOPACK=1 production runtime",
    file: "next/dist/compiled/next-server/app-page-turbo.runtime.prod.js",
    exportName: "ReactServerDOMTurbopackServer",
  },
];

function readSource(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function hexId(index: number): string {
  return index.toString(16);
}

type PayloadKind = "K" | "R" | "refs";

function buildPayload(kind: PayloadKind, count: number): {
  boundary: string;
  body: Buffer;
} {
  // Short boundary so FIELD_COUNT fields stay under the 1MB action body limit.
  const boundary = "----B";
  const parts: string[] = [];
  const refs = new Array<string>(count);
  for (let i = 1; i <= count; i++) {
    const id = hexId(i);
    if (kind === "K") {
      refs[i - 1] = `$K${id}`;
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="_${id}_a"\r\n\r\nx\r\n`,
      );
    } else if (kind === "R") {
      refs[i - 1] = `$R${id}`;
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${i}"\r\n\r\nC\r\n`,
      );
    } else {
      refs[i - 1] = `$@${id}`;
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${i}"\r\n\r\n"x"\r\n`,
      );
    }
  }
  // The root row is last, so every lookup runs against the full field set.
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="0"\r\n\r\n${JSON.stringify(refs)}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return { boundary, body: Buffer.from(parts.join(""), "utf8") };
}

function loadReplyServer(spec: RuntimeSpec): ReplyServer {
  const runtime = require(spec.file) as {
    vendored: { "react-rsc": Record<string, ReplyServer | undefined> };
  };
  const server = runtime.vendored["react-rsc"][spec.exportName];
  assert.ok(server, `${spec.label} did not export ${spec.exportName}`);
  assert.equal(typeof server.decodeReplyFromBusboy, "function");
  return server;
}

async function decode(
  server: ReplyServer,
  kind: PayloadKind,
  count: number,
): Promise<{ ms: number; value: unknown; bytes: number }> {
  const { boundary, body } = buildPayload(kind, count);
  assert.ok(
    body.length <= BODY_LIMIT_BYTES,
    `${kind} payload is ${body.length} bytes, over the ${BODY_LIMIT_BYTES} byte Server Action limit`,
  );
  const Busboy = require("next/dist/compiled/busboy") as (options: {
    defParamCharset: string;
    headers: Record<string, string>;
    limits: { fieldSize: number };
  }) => NodeJS.ReadableStream & {
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
  const busboy = Busboy({
    defParamCharset: "utf8",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    limits: { fieldSize: BODY_LIMIT_BYTES },
  });
  const started = performance.now();
  const pending = server.decodeReplyFromBusboy(busboy, {});
  await new Promise<void>((resolve, reject) => {
    busboy.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    busboy.on("finish", () => {
      resolve();
    });
    Readable.from(body).pipe(busboy);
  });
  const value = await pending;
  return { ms: performance.now() - started, value, bytes: body.length };
}

async function assertDecoded(
  kind: PayloadKind,
  value: unknown,
  count: number,
): Promise<void> {
  assert.ok(Array.isArray(value), `${kind} root should be an array`);
  assert.equal(value.length, count, `${kind} root length`);
  if (kind === "K") {
    const form = value[0] as { get?: (name: string) => unknown };
    assert.equal(typeof form.get, "function");
    assert.equal(form.get!("a"), "x");
    const last = value[count - 1] as { get: (name: string) => unknown };
    assert.equal(last.get("a"), "x");
  } else if (kind === "refs") {
    // Chunk references stay wrapped until the element promise is observed.
    assert.equal(await value[0], "x");
    assert.equal(await value[count - 1], "x");
  } else {
    const stream = value[0] as { getReader?: unknown; cancel?: () => Promise<void> };
    assert.equal(typeof stream.getReader, "function");
    for (const entry of value) {
      const cancel = (entry as { cancel?: () => Promise<void> }).cancel;
      if (typeof cancel === "function") {
        await cancel.call(entry).catch(() => undefined);
      }
    }
  }
  value.length = 0;
}

const actions = readSource("src/app/actions.ts");
assert.match(actions, /^"use server";/);
assert.match(actions, /export async function loginGoogle\(/);
assert.match(actions, /export async function logout\(/);

const loginScreen = readSource("src/components/auth/AuthScreens.tsx");
assert.match(loginScreen, /loginGoogle/);
assert.match(loginScreen, /<form action=\{googleAction\}>/);

const home = readSource("src/app/page.tsx");
assert.match(home, /if \(!session\?\.user\) \{\s*return <DesktopLoginScreen \/>;/);

const middleware = readSource("src/middleware.ts");
assert.match(middleware, /return NextResponse\.next\(\)/);
assert.doesNotMatch(middleware, /auth\(/);

const metadata = require("next/dist/server/lib/server-action-request-meta.js")
  .getServerActionRequestMetadata as (req: {
  method: string;
  headers: Record<string, string>;
}) => {
  actionId: string | null;
  isMultipartAction: boolean;
  isFetchAction: boolean;
  isPossibleServerAction: boolean;
};

const posted = metadata({
  method: "POST",
  headers: {
    "next-action": "login-action",
    "content-type": "multipart/form-data; boundary=----SeerActionBoundary",
    host: "seer.example",
  },
});
assert.equal(posted.isFetchAction, true);
assert.equal(posted.isMultipartAction, true);
assert.equal(posted.isPossibleServerAction, true);
assert.equal(posted.actionId, "login-action");

for (const spec of RUNTIMES) {
  const server = loadReplyServer(spec);
  const warmup = await decode(server, "K", 32);
  await assertDecoded("K", warmup.value, 32);

  for (const kind of ["K", "R", "refs"] as const) {
    const result = await decode(server, kind, FIELD_COUNT);
    await assertDecoded(kind, result.value, FIELD_COUNT);
    assert.ok(
      result.ms < DECODE_BUDGET_MS,
      `${spec.label} ${kind} decode of ${FIELD_COUNT} fields (${result.bytes} bytes) took ${result.ms.toFixed(0)}ms, budget is ${DECODE_BUDGET_MS}ms`,
    );
    console.log(
      `${spec.label} ${kind}: ${result.ms.toFixed(0)}ms (${result.bytes} bytes)`,
    );
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
  }
}

console.log("server action decode stayed within budget");
