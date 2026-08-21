/**
 * Gate: email HTML keeps its structure and loses the sender's theme.
 *
 * Outlook ships black-on-white colours and whole quoted threads; rendering
 * that raw breaks the dark skin, and flattening it to plain text loses the
 * paragraphs and lists that made it readable. The structural sanitiser is
 * what stands between those two failures.
 */
import assert from "node:assert/strict";
import {
  readableHtml,
  sanitizeStructuralHtml,
  stripQuotedHtml,
} from "../src/lib/v3/reader/email-html.ts";

// Script and style CONTENT must leave with their tags.
{
  const safe = sanitizeStructuralHtml(
    `<html><head><style>.x{color:red}</style><script>alert(1)</script></head>` +
      `<body><p>Keep me</p></body></html>`,
  );
  assert.match(safe, /Keep me/);
  assert.doesNotMatch(safe, /alert|color:red|<script|<style/i);
}

// Event handlers and javascript: URLs are stripped; safe links stay.
{
  const safe = sanitizeStructuralHtml(
    `<p onclick="evil()">Hi</p>` +
      `<a href="javascript:alert(1)">bad</a>` +
      `<a href="https://rditrials.com/doc">good</a>`,
  );
  assert.doesNotMatch(safe, /onclick|javascript:/i);
  assert.match(safe, /href="https:\/\/rditrials.com\/doc"/);
  assert.match(safe, /target="_blank"/);
  assert.match(safe, /rel="noopener noreferrer"/);
}

// Colour and font declarations drop; structural styles survive.
{
  const safe = sanitizeStructuralHtml(
    `<p style="color:rgb(0,0,0);font-size:14pt;font-family:Calibri;` +
      `font-weight:700;text-align:left;margin-left:24px">Bold left</p>`,
  );
  assert.doesNotMatch(safe, /color:|font-size:|font-family:/i);
  assert.match(safe, /font-weight:\s*700/);
  assert.match(safe, /text-align:\s*left/);
  assert.match(safe, /margin-left:\s*24px/);
}

// Unknown tags unwrap — the text they wrapped is never lost.
{
  const safe = sanitizeStructuralHtml(
    `<custom-wrapper><font face="Arial">Still here</font></custom-wrapper>`,
  );
  assert.match(safe, /Still here/);
  assert.doesNotMatch(safe, /custom-wrapper|<font/i);
}

// Lists and tables keep their structure.
{
  const safe = sanitizeStructuralHtml(
    `<ul><li>One</li><li>Two</li></ul>` +
      `<table><tr><th>H</th></tr><tr><td>Cell</td></tr></table>`,
  );
  assert.match(safe, /<ul>/);
  assert.match(safe, /<li>One<\/li>/);
  assert.match(safe, /<table>/);
  assert.match(safe, /<th>H<\/th>/);
  assert.match(safe, /<td>Cell<\/td>/);
}

// Outlook reply/forward markers are cut; the quoted count is the depth.
{
  const outlook =
    `<div class="elementToProof">Can you reprice this?</div>` +
    `<div id="appendonsend"></div>` +
    `<div id="divRplyFwdMsg"><div>From: Priya</div></div>` +
    `<div>Original paragraph the reader already saw.</div>` +
    `<div id="divRplyFwdMsg"><div>From: Conall</div></div>` +
    `<div>Even older.</div>`;
  const stripped = stripQuotedHtml(outlook);
  assert.match(stripped.html, /Can you reprice this/);
  assert.doesNotMatch(stripped.html, /Original paragraph|Even older|divRplyFwdMsg/);
  assert.equal(stripped.quotedCount, 2);

  const readable = readableHtml(outlook);
  assert.match(readable.html, /Can you reprice this/);
  assert.doesNotMatch(readable.html, /color:|Original paragraph/);
  assert.equal(readable.quotedCount, 2);
}

// Gmail's quote class is the same fold.
{
  const gmail =
    `<div>New sentence.</div>` +
    `<div class="gmail_quote">On Fri, Priya wrote:<br>old body</div>`;
  const stripped = stripQuotedHtml(gmail);
  assert.equal(stripped.html.includes("New sentence."), true);
  assert.equal(stripped.html.includes("gmail_quote"), false);
  assert.equal(stripped.quotedCount, 1);
}

// A bare forward is all quoted history — never blank it to prove a point.
{
  const bareForward =
    `<div id="divRplyFwdMsg">From: Priya Vance &lt;priya@lumos.com&gt;</div>` +
    `<div class="elementToProof">Two extra visits at weeks 12 and 20.</div>`;
  const stripped = stripQuotedHtml(bareForward);
  assert.match(stripped.html, /Two extra visits/);
  assert.equal(stripped.quotedCount, 0);

  const readable = readableHtml(bareForward);
  assert.match(readable.html, /Two extra visits/);
  assert.equal(readable.quotedCount, 0);
}

// A blockquote is only history when a client SAID it was quoting. Zoho wraps
// every send in `blockquote_zmail`, once per send: cutting on the tag alone
// left "Hi Conall," on the screen and called the rest seven hidden messages.
{
  const zoho =
    `<div class="zmail_extra"><div>Hi Conall,<br></div>` +
    `<blockquote id="blockquote_zmail" style="margin:0px"><div>` +
    `<blockquote id="x_890740167blockquote_zmail" style="margin:0px"><div>` +
    `<blockquote id="x_1780677492blockquote_zmail" style="margin:0px"><div>` +
    `How are you? We're excited to introduce a platform where clinical ` +
    `research service providers can showcase their services.` +
    `</div></blockquote></div></blockquote></div></blockquote></div>`;
  const stripped = stripQuotedHtml(zoho);
  assert.match(stripped.html, /Hi Conall/);
  assert.match(stripped.html, /excited to introduce a platform/, "the mail itself survives");
  assert.equal(stripped.quotedCount, 0, "layout indentation is not quoted history");

  const readable = readableHtml(zoho);
  assert.match(readable.html, /excited to introduce a platform/);
  assert.equal(readable.quotedCount, 0);
}

// An announced quote still folds, blockquote or not.
{
  const announced =
    `<div>Numbers attached.</div>` +
    `<div>On Fri, 8 Aug 2026 at 10:57, Priya Vance wrote:</div>` +
    `<blockquote style="margin:0"><div>Can you reprice this?</div></blockquote>`;
  const stripped = stripQuotedHtml(announced);
  assert.match(stripped.html, /Numbers attached/);
  assert.doesNotMatch(stripped.html, /Can you reprice/);
  assert.equal(stripped.quotedCount, 1);
}

// An Outlook header block above a blockquote announces it just as well.
{
  const header =
    `<div>Agreed.</div>` +
    `<div>From: Priya Vance<br>Sent: Friday 8 August<br>To: Conall</div>` +
    `<blockquote><div>The original ask.</div></blockquote>`;
  const stripped = stripQuotedHtml(header);
  assert.match(stripped.html, /Agreed/);
  assert.doesNotMatch(stripped.html, /The original ask/);
  assert.equal(stripped.quotedCount, 1);
}

// A `type="cite"` blockquote says so itself, with nothing above it.
{
  const cited = `<div>Fine by me.</div><blockquote type="cite"><p>Older mail.</p></blockquote>`;
  const stripped = stripQuotedHtml(cited);
  assert.match(stripped.html, /Fine by me/);
  assert.doesNotMatch(stripped.html, /Older mail/);
  assert.equal(stripped.quotedCount, 1);
}

// Empty / null bodies stay empty.
assert.deepEqual(readableHtml(null), { html: "", quotedCount: 0 });
assert.deepEqual(readableHtml("   "), { html: "", quotedCount: 0 });
assert.deepEqual(readableHtml("<style>.x{}</style>"), { html: "", quotedCount: 0 });

console.log("v3-email-html: OK");
