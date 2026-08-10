/**
 * Gate: the model reads what a person would read. Naive tag-stripping leaves
 * CSS and script bodies in the text and never decodes entities — the model then
 * "reads" style rules as if they were the message.
 */
import assert from "node:assert/strict";
import { htmlToText, readableBody } from "../src/lib/v2/intelligence/html-text.ts";

// Style and script CONTENT must be gone, not just their tags.
{
  const html = `
    <html><head>
      <style>.x { color: #fff; font-family: Arial; } .y { margin: 0 }</style>
      <script>var tracking = 1; function ping(){}</script>
    </head>
    <body><p>Please countersign the CDA by Friday.</p></body></html>`;
  const text = htmlToText(html);
  assert.ok(!/color|font-family|margin/.test(text), `CSS leaked into the read: ${text}`);
  assert.ok(!/tracking|function/.test(text), `script leaked into the read: ${text}`);
  assert.equal(text, "Please countersign the CDA by Friday.");
}

// Entities are decoded the way a reader would see them.
{
  assert.equal(htmlToText("<p>IgG plasma &gt; 15 g/L</p>"), "IgG plasma > 15 g/L");
  assert.equal(htmlToText("<p>Roche&nbsp;&amp;&nbsp;RDI</p>"), "Roche & RDI");
  assert.equal(htmlToText("<p>Fee &#8212; $5</p>"), "Fee — $5");
}

// Block structure becomes line breaks so sentences don't fuse together.
{
  // Blocks are separated (paragraph spacing is fine); what matters is that
  // separate lines never fuse into one run-on sentence.
  const text = htmlToText("<div>First line</div><div>Second line</div>");
  assert.deepEqual(
    text.split("\n").filter(Boolean),
    ["First line", "Second line"],
  );
  assert.equal(htmlToText("A<br>B"), "A\nB");
}

// HTML comments (often huge in marketing mail) are dropped.
assert.equal(htmlToText("<!-- hidden preheader --><p>Hello</p>"), "Hello");

// readableBody prefers real text, falls back to HTML, then the snippet.
{
  assert.equal(
    readableBody({ bodyText: "plain wins", bodyHtml: "<p>html</p>", snippet: "snip" }),
    "plain wins",
  );
  assert.equal(
    readableBody({ bodyText: null, bodyHtml: "<p>from html</p>", snippet: "snip" }),
    "from html",
  );
  assert.equal(readableBody({ bodyText: null, bodyHtml: null, snippet: "snip" }), "snip");
  // An HTML body that is only styling falls through to the snippet.
  assert.equal(
    readableBody({ bodyText: null, bodyHtml: "<style>.a{color:red}</style>", snippet: "snip" }),
    "snip",
  );
}

console.log("v2-html-text: OK");
