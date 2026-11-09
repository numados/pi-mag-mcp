/**
 * Parser and mapper regressions.
 *
 * Every case here was reproduced against the old server (research §3, §7);
 * the test names state the defect being prevented, not the implementation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDdgLite, mapScrapeResults, resolveDdgUrl, looksLikeResultsPage } from "../dist/ddg.js";
import { mapTavilyResponse } from "../dist/tavily.js";
import { clampSnippet, decodeEntities, stripHtml, isSafeHttpUrl } from "../dist/text.js";

const row = (cells) => `<tr>${cells}</tr>`;
const link = (href, title, cls = "result-link") => `<a class="${cls}" href="${href}">${title}</a>`;
const snippet = (text) => `<td class="result-snippet">${text}</td>`;

test("snippets never attach to the wrong link when a link has no snippet", () => {
  // Old behaviour: index pairing gave page 2's snippet to page 1.
  const html = [
    row(`<td>1.</td><td>${link("https://a.example/1", "Page one")}</td>`),
    row(`<td>2.</td><td>${link("https://b.example/2", "Page two")}</td>`),
    row(`<td></td>${snippet("Snippet that belongs to page two")}`),
  ].join("");

  const { results } = parseDdgLite(html, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://a.example/1");
  assert.equal(results[0].snippet, "", "page one has no snippet and must not borrow one");
  assert.equal(results[1].url, "https://b.example/2");
  assert.equal(results[1].snippet, "Snippet that belongs to page two");
});

test("attribute order, extra classes and single quotes still parse", () => {
  const html = [
    row(`<td><a href='https://a.example/x' class='result-link extra' rel="nofollow">One</a></td>`),
    row(`<td class='result-snippet' align="top">First</td>`),
    row(`<td><a class="result-link sponsored" href='https://b.example/y'>Two</a></td>`),
    row(`<td class='result-snippet'>Second</td>`),
  ].join("");

  const { results } = parseDdgLite(html, 5);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((item) => [item.title, item.url, item.snippet]),
    [
      ["One", "https://a.example/x", "First"],
      ["Two", "https://b.example/y", "Second"],
    ],
  );
});

test("DDG lite redirect URLs resolve to the target", () => {
  const target = "https://example.com/path?a=1&b=2";
  const redirect = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`;
  assert.equal(resolveDdgUrl(redirect), target);
  assert.equal(resolveDdgUrl("https://example.com/direct"), "https://example.com/direct");
});

test("non-http(s) provider links are withheld and counted", () => {
  const html = [
    row(`<td>${link("javascript:alert(1)", "Evil")}</td>`),
    row(`<td>${link("https://good.example/", "Good")}</td>`),
    row(`<td class="result-snippet">fine</td>`),
  ].join("");

  const { results, droppedUnsafeUrls } = parseDdgLite(html, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://good.example/");
  assert.equal(droppedUnsafeUrls, 1);
});

test("a maintenance page is not an empty result set", () => {
  const maintenance = "<html><body><h1>We are performing maintenance</h1></body></html>";
  assert.equal(looksLikeResultsPage(maintenance), false, "must not be treated as a legitimate zero-hit page");
  assert.equal(looksLikeResultsPage(`<td class="result-snippet">x</td>`), true);
});

test("literal angle brackets in technical text survive", () => {
  assert.equal(stripHtml("use std::vector&lt;int&gt; here"), "use std::vector<int> here");
  assert.equal(stripHtml("<b>bold</b> &amp; &lt;tag&gt;"), "bold & <tag>");
  assert.equal(decodeEntities("a &amp;lt; b"), "a &lt; b", "entities decode exactly once");
  assert.equal(decodeEntities("&#104;&#105;"), "hi");
});

test("clamping reports truncation instead of dropping text silently", () => {
  const short = clampSnippet("short text", 50);
  assert.deepEqual(short, { snippet: "short text", truncated: false });

  const text = "word ".repeat(40).trim();
  const clamped = clampSnippet(text, 40);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.snippet.endsWith("…"));
  assert.ok(clamped.snippet.length <= 41, "clamped snippet stays within the budget");
});

test("only http(s) URLs are considered safe", () => {
  assert.equal(isSafeHttpUrl("https://example.com"), true);
  assert.equal(isSafeHttpUrl("http://example.com"), true);
  assert.equal(isSafeHttpUrl("javascript:alert(1)"), false);
  assert.equal(isSafeHttpUrl("data:text/html,<script>"), false);
  assert.equal(isSafeHttpUrl("not a url"), false);
});

test("scrape payloads are validated field by field", () => {
  const outcome = mapScrapeResults(
    [
      { title: "A", url: "https://a.example/", description: "<b>bold</b> text" },
      { title: "B", url: "file:///etc/passwd", description: "nope" },
      { title: 42, url: "https://missing-title.example/", description: null },
      null,
    ],
    5,
  );
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].snippet, "bold text");
  assert.equal(outcome.results[1].title, "(no title)");
  assert.equal(outcome.results[1].snippet, "");
  assert.equal(outcome.droppedUnsafeUrls, 1);
});

test("a non-array scrape payload is malformed, not empty", () => {
  const outcome = mapScrapeResults({ oops: true }, 5);
  assert.equal(outcome.results.length, 0);
  assert.equal(outcome.reason, "malformed");
  assert.equal(outcome.unrecognized, true);
});

test("Tavily content:null no longer crashes the formatter", () => {
  const outcome = mapTavilyResponse(
    {
      results: [
        { title: "Null body", url: "https://a.example/", content: null },
        { title: "Text", url: "https://b.example/", content: "has text" },
      ],
    },
    5,
  );
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].snippet, "");
  assert.equal(outcome.results[1].snippet, "has text");
});

test("Tavily malformed payloads are rejected at the boundary", () => {
  assert.equal(mapTavilyResponse(null, 5).reason, "malformed");
  assert.equal(mapTavilyResponse({ results: "nope" }, 5).reason, "malformed");
  assert.equal(mapTavilyResponse({ results: [] }, 5).results.length, 0);
});

test("result count truncation is reported", () => {
  const many = Array.from({ length: 4 }, (_, index) => ({
    title: `t${index}`,
    url: `https://example.com/${index}`,
    content: "c",
  }));
  const outcome = mapTavilyResponse({ results: many }, 2);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.resultsTruncated, true);
});
