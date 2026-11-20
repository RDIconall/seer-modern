/**
 * Test stand-in for the provider HTTP APIs the inbox GET handlers call.
 *
 * Built from the request shapes in:
 * - src/lib/mail/gmail.ts (gmail.googleapis.com/gmail/v1)
 * - src/lib/mail/seer-labels.ts (labels list, labels create, messages/batchModify)
 * - src/lib/inbox/personal-context.ts (people.googleapis.com, calendar v3)
 * - @ai-sdk/google 4.x doGenerate → POST {baseURL}/models/{id}:generateContent
 *   with candidates[0].content.parts[].text (node_modules/@ai-sdk/google/dist/index.js)
 *
 * Records only side-effect kinds. Never records headers or credential material.
 */
"use strict";

const fs = require("node:fs");

const tracePath = process.env.SEER_CSRF_TRACE;
const messageId = process.env.SEER_CSRF_MSG_ID || "msg-gray-1";
const bodyMarker = process.env.SEER_CSRF_BODY_MARKER || "CROSS-SITE-BODY-MARKER";
const originalFetch = globalThis.fetch;

if (typeof originalFetch !== "function") {
  throw new Error("csrf preload: global fetch is missing");
}

const events = [];

function persist(event) {
  if (tracePath) {
    try {
      if (fs.readFileSync(tracePath, "utf8").trim() === "[]") events.length = 0;
    } catch {
      /* the test creates the file before the first request */
    }
  }
  events.push(event);
  if (!tracePath) return;
  fs.writeFileSync(tracePath, JSON.stringify(events));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function encodeBody(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}

function messageMetadata() {
  return {
    id: messageId,
    threadId: "thr-gray-1",
    snippet: "short preview only",
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Gray Sender <gray.sender@example.com>" },
        { name: "To", value: "Desk <desk@rditrials.com>" },
        { name: "Subject", value: "A note about the contract" },
      ],
    },
  };
}

function messageFull() {
  const text =
    "Please read this entire note. " +
    bodyMarker +
    " The clause needs a decision before Friday and is not in the preview.";
  return {
    ...messageMetadata(),
    payload: {
      ...messageMetadata().payload,
      body: { data: encodeBody(text), size: text.length },
    },
  };
}

function readBody(init, input) {
  const raw = init?.body ?? (typeof input !== "string" && input?.body);
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  return "";
}

globalThis.fetch = async function csrfPreloadFetch(input, init) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = String(
    init?.method ||
      (typeof input !== "string" && !(input instanceof URL) && input.method) ||
      "GET",
  ).toUpperCase();
  const body = readBody(init, input);
  const parsed = new URL(url);

  if (parsed.hostname === "gmail.googleapis.com") {
    const path = parsed.pathname.replace(/^\/gmail\/v1/, "");
    if (path === "/users/me/labels" && method === "GET") {
      return json({ labels: [] });
    }
    if (path === "/users/me/labels" && method === "POST") {
      persist({ kind: "label-create" });
      return json({ id: "Label_test", name: "Seer/read_and_delete" });
    }
    if (path === "/users/me/messages/batchModify" && method === "POST") {
      let ids = [];
      try {
        ids = JSON.parse(body).ids ?? [];
      } catch {
        ids = [];
      }
      persist({
        kind: "batchModify",
        count: Array.isArray(ids) ? ids.length : 0,
        includesTarget: Array.isArray(ids) && ids.includes(messageId),
      });
      return json({});
    }
    if (path === "/users/me/messages" && method === "GET") {
      const q = parsed.searchParams.get("q") ?? "";
      if (q.includes("in:inbox")) {
        return json({
          messages: [{ id: messageId, threadId: "thr-gray-1" }],
        });
      }
      return json({ messages: [] });
    }
    if (path.startsWith(`/users/me/messages/${messageId}`) && method === "GET") {
      if (parsed.searchParams.get("format") === "full") {
        persist({ kind: "body-fetch" });
        return json(messageFull());
      }
      return json(messageMetadata());
    }
    if (path.startsWith("/users/me/threads/") && method === "GET") {
      return json({
        messages: [
          {
            id: messageId,
            internalDate: String(Date.now()),
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "Gray Sender <gray.sender@example.com>" },
              ],
            },
          },
        ],
      });
    }
    return json({});
  }

  if (parsed.hostname === "people.googleapis.com") {
    if (parsed.pathname.includes("otherContacts")) {
      return json({ otherContacts: [] });
    }
    return json({ connections: [] });
  }

  if (
    parsed.hostname === "www.googleapis.com" &&
    parsed.pathname.includes("/calendar/")
  ) {
    return json({ items: [] });
  }

  if (
    parsed.hostname === "generativelanguage.googleapis.com" &&
    parsed.pathname.includes(":generateContent")
  ) {
    persist({
      kind: "model",
      bodySent: body.includes(bodyMarker),
    });
    const graded = {
      items: [
        {
          id: messageId,
          action: "read_and_delete",
          confidence: 0.91,
          reason: "Automated note",
          instruction: "Delete it",
          task: "none",
          category: "Bulk",
          sender: "machine",
          credible: false,
          importance: 0,
          deed: "none",
        },
      ],
    };
    return json({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(graded) }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
    });
  }

  if (
    parsed.hostname === "generativelanguage.googleapis.com" &&
    parsed.pathname.endsWith("/models")
  ) {
    return json({ models: [] });
  }

  return originalFetch(input, init);
};
