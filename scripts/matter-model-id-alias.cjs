const Module = require("node:module");
const path = require("node:path");

const root = path.join(__dirname, "..");
const sessionStub = path.join(__dirname, "matter-model-id-session-stub.ts");
const realSession = path.join(root, "src/lib/mail/session.ts");
const original = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  const normalized = typeof request === "string" ? request.split("?")[0] : request;
  if (
    normalized === "@/lib/mail/session" ||
    normalized === realSession ||
    (typeof normalized === "string" && normalized.endsWith(`${path.sep}src${path.sep}lib${path.sep}mail${path.sep}session.ts`))
  ) {
    request = sessionStub;
  }
  return original.call(this, request, parent, isMain, options);
};
