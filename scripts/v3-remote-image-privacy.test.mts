/**
 * Opening a message must not phone home to the sender.
 *
 * Remote images stay blocked until the reader clicks Show remote images.
 * The frame is what the browser actually loads: these tests render that frame
 * from the same components the mailbox uses, then open it in Chrome with the
 * same sandbox and referrer policy. A request to the sender's image URL before
 * that click is a failure.
 *
 * Run: npx tsx scripts/v3-remote-image-privacy.test.mts
 *
 * Surfaces covered: MessageHtml (also the compose quote preview), the v3
 * Reader's open external turn, the Reader's internal branch once expanded,
 * and LegacyThread. Quoted https img src and https CSS url() are the controls
 * that already stay blocked.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { JSDOM } from "jsdom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1/mail",
  pretendToBeVisual: true,
});
const window = dom.window;
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  DocumentFragment: window.DocumentFragment,
  DOMParser: window.DOMParser,
  NodeFilter: window.NodeFilter,
  HTMLTemplateElement: window.HTMLTemplateElement,
  getComputedStyle: window.getComputedStyle.bind(window),
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { MessageHtml } = await import("../src/components/v2/MessageHtml.tsx");
const { Reader } = await import("../src/components/v2/Reader.tsx");
const { LegacyThread } = await import("../src/components/mail/LegacyThread.tsx");

type Hit = { url: string; userAgent: string; referer: string };

const hits: Hit[] = [];
const server: Server = createServer((req, res) => {
  hits.push({
    url: req.url ?? "",
    userAgent: req.headers["user-agent"] ?? "",
    referer: typeof req.headers.referer === "string" ? req.headers.referer : "",
  });
  if (req.url === "/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml);
    return;
  }
  res.writeHead(200, {
    "content-type": "image/gif",
    "cache-control": "no-store",
  });
  res.end(
    Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("tracker failed to listen");
const host = `127.0.0.1:${address.port}`;

const REMOTE = /^(?:https?:)?\/\//i;
const LOADABLE_ATTRS = ["src", "srcset", "poster", "background", "href", "xlink:href", "data"];

function loadableRemotes(srcdoc: string): string[] {
  const doc = new JSDOM(srcdoc).window.document;
  const found: string[] = [];
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of LOADABLE_ATTRS) {
      if (attr.startsWith("data-blocked")) continue;
      if (attr === "href" || attr === "xlink:href") {
        const tag = el.tagName.toLowerCase();
        if (tag !== "image" && tag !== "use" && tag !== "feimage") continue;
      }
      const raw = el.getAttribute(attr);
      if (!raw) continue;
      const candidates = attr === "srcset" ? raw.split(",") : [raw];
      for (const candidate of candidates) {
        const url = candidate.trim().split(/\s+/)[0] ?? "";
        if (REMOTE.test(url)) found.push(`${el.tagName.toLowerCase()} ${attr}=${url}`);
      }
    }
    if (el.tagName.toLowerCase() === "style" || el.hasAttribute("style")) {
      const source = el.tagName.toLowerCase() === "style" ? (el.textContent ?? "") : (el.getAttribute("style") ?? "");
      for (const match of source.matchAll(/url\(\s*(['"]?)\s*([^)'"]+)\s*\1\s*\)/gi)) {
        const url = match[2] ?? "";
        if (REMOTE.test(url.trim())) found.push(`${el.tagName.toLowerCase()} url(${url.trim()})`);
      }
    }
  }
  return found;
}

function cspText(srcdoc: string): string {
  const doc = new JSDOM(srcdoc).window.document;
  const parts: string[] = [];
  for (const meta of doc.querySelectorAll("meta")) {
    if ((meta.getAttribute("http-equiv") ?? "").toLowerCase() === "content-security-policy") {
      parts.push(meta.getAttribute("content") ?? "");
    }
  }
  return parts.join("; ");
}

function directive(policy: string, name: string): string | null {
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens[0]?.toLowerCase() === name) return tokens.slice(1).join(" ");
  }
  return null;
}

function allowsNetwork(sourceList: string): boolean {
  return sourceList.split(/\s+/).some((token) => {
    const value = token.toLowerCase();
    return (
      value === "*" ||
      value === "http:" ||
      value === "https:" ||
      value === "*:" ||
      value.startsWith("http://") ||
      value.startsWith("https://") ||
      value.startsWith("//")
    );
  });
}

/** Images and media may come from data: or cid: only, until the reader opts in. */
function policyBlocksRemoteLoads(policy: string): string | null {
  if (!policy.trim()) return "frame document has no Content-Security-Policy";
  const img = directive(policy, "img-src") ?? directive(policy, "default-src");
  const media = directive(policy, "media-src") ?? directive(policy, "default-src");
  if (!img) return "CSP does not set img-src or default-src";
  if (!media) return "CSP does not set media-src or default-src";
  if (!img.split(/\s+/).includes("data:")) return `img policy ${img} does not allow data: images`;
  if (allowsNetwork(img)) return `img policy ${img} still allows a network image`;
  if (allowsNetwork(media)) return `media policy ${media} still allows a network fetch`;
  return null;
}

type Frame = { srcdoc: string; button: boolean };

function frameFromMarkup(markup: string): Frame {
  const doc = new JSDOM(markup).window.document;
  return {
    srcdoc: doc.querySelector("iframe")?.getAttribute("srcdoc") ?? "",
    button: [...doc.querySelectorAll("button")].some((button) =>
      (button.textContent ?? "").includes("Show remote images"),
    ),
  };
}

function renderMessage(html: string): Frame {
  return frameFromMarkup(
    renderToString(createElement(MessageHtml, { html, text: "Hello" })),
  );
}

function message(html: string, id: string, from: string, to: string) {
  return {
    providerMessageId: id,
    from: { email: from, name: "Sender" },
    to: [{ email: to, name: "Reader" }],
    cc: [] as { email: string }[],
    sentAt: "2026-08-01T12:00:00.000Z",
    snippet: "Hello",
    bodyHtml: html,
    bodyText: "Hello",
    isUnread: true,
    isOutgoing: false,
    attachments: [] as [],
  };
}

const noop = () => {};

function renderReader(html: string, from: string, to: string, ownEmail: string): string {
  return renderToString(
    createElement(Reader, {
      provider: "google",
      conversation: {
        providerConversationId: "conversation-1",
        subject: "Hello",
        lastMessageAt: "2026-08-01T12:00:00.000Z",
        messages: [message(html, "message-1", from, to)],
      },
      ownEmail,
      onReply: noop,
      onReplyAll: noop,
      onForward: noop,
      onArchive: noop,
      onDelete: noop,
    }),
  );
}

const failures: string[] = [];
const iframes: { name: string; srcdoc: string }[] = [];

function expectBlocked(name: string, frame: Frame) {
  if (!frame.srcdoc) {
    failures.push(`${name}: message frame was not rendered`);
    return;
  }
  if (!frame.button) {
    failures.push(`${name}: Show remote images was not offered`);
  }
  const loads = loadableRemotes(frame.srcdoc).filter((item) => item.includes(host));
  if (loads.length > 0) {
    failures.push(`${name}: frame still has a loadable remote URL (${loads.join("; ")})`);
  }
  const policy = policyBlocksRemoteLoads(cspText(frame.srcdoc));
  if (policy) failures.push(`${name}: ${policy}`);
  iframes.push({ name, srcdoc: frame.srcdoc });
}

const pixel = (path: string) => `http://${host}${path}`;
const relative = (path: string) => `//${host}${path}`;

const cases: Array<[string, string]> = [
  ["protocol-relative-src", `<p>Hello</p><img alt="" src="${relative("/img/protocol-relative.gif")}">`],
  ["img-srcset", `<img alt="" srcset="${pixel("/img/srcset.gif")} 1x">`],
  ["img-srcset-protocol-relative", `<img alt="" srcset="${relative("/img/srcset-relative.gif")} 2x">`],
  ["picture-source-srcset", `<picture><source srcset="${pixel("/img/picture.gif")}"><img alt="" src="cid:inline"></picture>`],
  ["video-poster", `<video poster="${pixel("/img/poster.gif")}"></video>`],
  ["video-poster-protocol-relative", `<video poster="${relative("/img/poster-relative.gif")}"></video>`],
  ["video-src", `<video src="${pixel("/media/video.mp4")}"></video>`],
  ["source-src", `<video><source src="${pixel("/media/source.mp4")}" type="video/mp4"></video>`],
  ["audio-src", `<audio src="${pixel("/media/audio.mp3")}"></audio>`],
  ["track-src", `<video src="data:video/mp4;base64,AAAA"><track default src="${pixel("/media/track.vtt")}" kind="subtitles"></video>`],
  ["css-protocol-relative", `<div style="background-image:url(${relative("/img/css.gif")})">Hello</div>`],
  ["css-quoted-protocol-relative", `<div style="background-image:url('${relative("/img/css-quoted.gif")}')">Hello</div>`],
  ["table-background", `<table background="${pixel("/img/table.gif")}"><tr><td>Hello</td></tr></table>`],
  ["td-background", `<table><tr><td background="${relative("/img/cell.gif")}">Hello</td></tr></table>`],
  ["svg-image", `<svg><image href="${pixel("/img/svg.gif")}" width="1" height="1"></image></svg>`],
  ["svg-feimage", `<svg><feImage href="${pixel("/img/feimage.gif")}"></feImage></svg>`],
  ["input-image", `<input type="image" src="${pixel("/img/input.gif")}" alt="">`],
];

for (const [name, html] of cases) {
  expectBlocked(name, renderMessage(html));
}

const externalHtml = `<p>Hello</p><img alt="" src="${relative("/img/reader.gif")}">`;
expectBlocked(
  "reader-open-turn",
  frameFromMarkup(renderReader(externalHtml, "attacker@outside.test", "you@example.com", "you@example.com")),
);

const legacyMarkup = renderToString(
  createElement(LegacyThread, {
    reader: {
      id: "legacy-1",
      threadId: "thread-1",
      fromEmail: "attacker@outside.test",
      fromName: "Sender",
      subject: "Hello",
      snippet: "Hello",
      receivedAt: "2026-08-01T12:00:00.000Z",
      isUnread: true,
      textBody: "Hello",
      htmlBody: `<p>Hello</p><img alt="" src="${relative("/img/legacy.gif")}">`,
      toEmail: "you@example.com",
      ccEmail: "",
      messageIdHeader: "<legacy-1@outside.test>",
    },
  }),
);
expectBlocked("legacy-thread", frameFromMarkup(legacyMarkup));

// Controls that already hold: a quoted http(s) image and a quoted https CSS
// url are rewritten, and an inline data or cid image is left alone.
{
  const quoted = renderMessage(`<img alt="" src="${pixel("/control/quoted.gif")}">`);
  assert.equal(quoted.button, true, "a quoted http image still offers Show remote images");
  assert.deepEqual(
    loadableRemotes(quoted.srcdoc).filter((item) => item.includes(host)),
    [],
    "a quoted http image must not stay loadable",
  );
  iframes.push({ name: "control-quoted-http", srcdoc: quoted.srcdoc });

  const css = renderMessage(
    `<div style="background-image:url(${pixel("/control/css.gif")})">Hello</div>`,
  );
  assert.deepEqual(
    loadableRemotes(css.srcdoc).filter((item) => item.includes(host)),
    [],
    "a quoted https CSS url() must not stay loadable",
  );
  iframes.push({ name: "control-css-https", srcdoc: css.srcdoc });

  const inline = renderMessage(
    `<img alt="inline" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">`,
  );
  assert.equal(inline.button, false, "a data image is not a remote image");
  assert.match(inline.srcdoc, /src="data:image\/gif/);

  const cid = renderMessage(`<img alt="" src="cid:logo">`);
  assert.equal(cid.button, false, "a cid image is not a remote image");
  assert.match(cid.srcdoc, /src="cid:logo"/);

  const styleTag = renderMessage(
    `<style>div{background:url(${pixel("/control/style-tag.gif")})}</style><div>Hello</div>`,
  );
  assert.deepEqual(
    loadableRemotes(styleTag.srcdoc).filter((item) => item.includes("/control/style-tag.gif")),
    [],
  );
}

async function optedSrcdoc(html: string): Promise<string | null> {
  const hostEl = document.createElement("div");
  document.body.appendChild(hostEl);
  const root = createRoot(hostEl);
  await act(async () => {
    root.render(createElement(MessageHtml, { html, text: "Hello" }));
  });
  const button = [...hostEl.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent ?? "").includes("Show remote images"),
  );
  if (!button) {
    await act(async () => root.unmount());
    hostEl.remove();
    return null;
  }
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const srcdoc = hostEl.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  await act(async () => root.unmount());
  hostEl.remove();
  return srcdoc;
}

const optInCases: Array<[string, string, string]> = [
  ["opt-protocol-relative", "/opt/protocol-relative.gif", `<img alt="" src="${relative("/opt/protocol-relative.gif")}">`],
  ["opt-srcset", "/opt/srcset.gif", `<img alt="" srcset="${pixel("/opt/srcset.gif")} 1x">`],
  ["opt-poster", "/opt/poster.gif", `<video poster="${pixel("/opt/poster.gif")}"></video>`],
  ["opt-css", "/opt/css.gif", `<div style="background-image:url(${relative("/opt/css.gif")})">Hello</div>`],
  ["opt-background", "/opt/table.gif", `<table background="${pixel("/opt/table.gif")}"><tr><td>Hello</td></tr></table>`],
  ["opt-svg", "/opt/svg.gif", `<svg><image href="${pixel("/opt/svg.gif")}" width="1" height="1"></image></svg>`],
];
const optInReady: string[] = [];
for (const [name, path, html] of optInCases) {
  const srcdoc = await optedSrcdoc(html);
  if (!srcdoc) {
    failures.push(`${name}: Show remote images could not be clicked`);
    continue;
  }
  const loads = loadableRemotes(srcdoc).filter((item) => item.includes(path));
  if (loads.length === 0) {
    failures.push(`${name}: opting in did not restore a loadable image URL`);
  }
  optInReady.push(path);
  iframes.push({ name, srcdoc });
}

// The internal branch stays collapsed until the reader opens it. Expanding it
// is not the same as agreeing to remote images.
{
  const html = `<p>Hello</p><img alt="" src="${relative("/img/branch.gif")}">`;
  const hostEl = document.createElement("div");
  document.body.appendChild(hostEl);
  const root = createRoot(hostEl);
  await act(async () => {
    root.render(
      createElement(Reader, {
        provider: "google",
        conversation: {
          providerConversationId: "conversation-branch",
          subject: "Internal",
          lastMessageAt: "2026-08-01T12:00:00.000Z",
          messages: [message(html, "branch-1", "colleague@example.com", "you@example.com")],
        },
        ownEmail: "you@example.com",
        onReply: noop,
        onReplyAll: noop,
        onForward: noop,
        onArchive: noop,
        onDelete: noop,
      }),
    );
  });
  const opener = hostEl.querySelector("button.reader-branch-head");
  if (!opener) {
    failures.push("reader-branch: internal branch could not be expanded");
  } else {
    await act(async () => {
      opener.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expectBlocked("reader-branch", frameFromMarkup(hostEl.innerHTML));
  }
  await act(async () => root.unmount());
  hostEl.remove();
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

let pageHtml = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>`;
for (const frame of iframes) {
  pageHtml += `<iframe title="${frame.name}" sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttr(frame.srcdoc)}"></iframe>`;
}
pageHtml += `</body></html>`;

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--disable-background-networking",
    "--virtual-time-budget=3000",
    `http://${host}/page`,
  ],
  { stdio: "ignore" },
);
const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 15000);
await new Promise<void>((resolve) => {
  chrome.on("exit", () => resolve());
});
clearTimeout(killTimer);
await new Promise((resolve) => setTimeout(resolve, 200));

const requested = hits.filter((hit) => hit.url !== "/page" && hit.url !== "/favicon.ico");
assert.ok(
  hits.some((hit) => hit.url === "/page"),
  "Chrome did not open the message frame fixture",
);
assert.equal(
  requested.some((hit) => hit.url.includes("/control/")),
  false,
  `a quoted http image was requested: ${requested.map((hit) => hit.url).join(", ")}`,
);

for (const hit of requested) {
  if (hit.url.includes("/opt/")) continue;
  failures.push(
    `frame requested ${hit.url} before Show remote images (user-agent present: ${hit.userAgent.length > 0}, referer: ${hit.referer || "none"})`,
  );
}
const optedUrls = requested.filter((hit) => hit.url.includes("/opt/")).map((hit) => hit.url);
for (const [name, path] of optInCases) {
  if (!optInReady.includes(path)) continue;
  if (!optedUrls.some((url) => url.includes(path))) {
    failures.push(`${name}: opting in did not load the remote image`);
  }
}

server.closeAllConnections?.();
server.close();

if (failures.length > 0) {
  assert.fail(`remote images loaded without consent:\n${failures.map((item) => `- ${item}`).join("\n")}`);
}

console.log("v3-remote-image-privacy: OK");
