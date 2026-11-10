/**
 * Confluence behaviour: locator parsing, HTML conversion, the credential retry
 * rule, payload validation and bounded reads.
 *
 * No real network and no real credential: `fetch` is replaced for every test
 * that reaches the transport, and the environment is restored afterwards.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampText,
  getCredentialCandidates,
  htmlToText,
  parsePageId,
  withAuthCandidates,
} from "../dist/confluence.js";
import { RemoteError, readTextBounded } from "../dist/http.js";
import { readConfluencePage } from "../dist/tools.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ["CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN", "CONFLUENCE_BASE_URL", "HOME"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function withEnv(values) {
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

test("parsePageId understands every supported locator form", () => {
  assert.equal(parsePageId("12345678"), "12345678");
  assert.equal(parsePageId("https://x.atlassian.net/wiki/spaces/DOCS/pages/12345678/Title"), "12345678");
  assert.equal(parsePageId("https://x.atlassian.net/wiki/viewpage.action?pageId=999"), "999");
  assert.equal(parsePageId("https://x.atlassian.net/wiki/blog/2026/09/02/123456789/post"), "123456789");
  assert.equal(parsePageId("https://example.com/no/id/here"), null);
  assert.equal(parsePageId("   "), null);
});

test("htmlToText keeps code angles, renders http links and drops unsafe schemes", () => {
  const text = htmlToText(
    '<h1>Title</h1><p>std::vector&lt;int&gt;</p>' +
      '<a href="https://x.example/a">docs</a>' +
      '<a href="javascript:alert(1)">click</a>' +
      '<ul><li>a</li><li>b</li></ul>',
  );
  assert.match(text, /# Title/);
  assert.match(text, /std::vector<int>/, "entities are decoded once, after tag removal");
  assert.match(text, /docs \(https:\/\/x\.example\/a\)/);
  assert.doesNotMatch(text, /javascript:/, "a non-http(s) href never becomes a link");
  assert.match(text, /- a\n- b/);
});

test("clampText reports truncation instead of hiding it", () => {
  assert.deepEqual(clampText("short", 10), { text: "short", truncated: false });
  const clamped = clampText("x".repeat(20), 10);
  assert.equal(clamped.truncated, true);
  assert.equal(clamped.text.length, 11, "budget plus the ellipsis marker");
});

test("the environment tuple is used only when complete", () => {
  withEnv({ CONFLUENCE_EMAIL: "a@b.c", CONFLUENCE_API_TOKEN: "t", CONFLUENCE_BASE_URL: "https://x.atlassian.net/" });
  const envCandidates = getCredentialCandidates({ CONFLUENCE_EMAIL: "a@b.c", CONFLUENCE_API_TOKEN: "t", CONFLUENCE_BASE_URL: "https://x.atlassian.net/" });
  assert.equal(envCandidates[0].baseUrl, "https://x.atlassian.net", "trailing slash is normalised");
  assert.equal(envCandidates[0].source, "env");

  const partial = getCredentialCandidates({ CONFLUENCE_EMAIL: "a@b.c", CONFLUENCE_API_TOKEN: "t" });
  assert.equal(partial.filter((c) => c.source === "env").length, 0, "a partial tuple is not a credential");
});

test("only a 401 moves to the next credential", async () => {
  const candidates = [
    { email: "a@b.c", token: "first", baseUrl: "https://x", source: "env" },
    { email: "a@b.c", token: "second", baseUrl: "https://x", source: "jira-config" },
  ];

  const tried = [];
  const value = await withAuthCandidates(candidates, async (credential) => {
    tried.push(credential.token);
    if (credential.token === "first") throw new RemoteError({ kind: "auth", message: "rejected", status: 401 });
    return "ok";
  });
  assert.equal(value, "ok");
  assert.deepEqual(tried, ["first", "second"]);

  tried.length = 0;
  await assert.rejects(
    () =>
      withAuthCandidates(candidates, async (credential) => {
        tried.push(credential.token);
        throw new RemoteError({ kind: "auth", message: "forbidden", status: 403 });
      }),
    (error) => error.failure.status === 403,
  );
  assert.deepEqual(tried, ["first"], "a 403 is a real answer, not a reason to retry");
});

test("a page read maps the payload and validates its shape", async () => {
  const home = mkdtempSync(join(tmpdir(), "office-mcp-home-"));
  try {
    withEnv({
      HOME: home,
      CONFLUENCE_EMAIL: "a@b.c",
      CONFLUENCE_API_TOKEN: "t",
      CONFLUENCE_BASE_URL: "https://x.atlassian.net",
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "42",
          type: "page",
          title: "Doc",
          space: { key: "DOCS" },
          version: { number: 3, when: "2026-01-01T00:00:00Z" },
          body: { view: { value: "<h1>Hello</h1><p>world</p>" } },
          _links: { webui: "/spaces/DOCS/pages/42/Doc" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const output = await readConfluencePage("42");
    assert.equal(output.status, "ok");
    assert.equal(output.pageId, "42");
    assert.match(output.text, /# Hello/);
    assert.equal(output.textTruncated, false);
    assert.equal(output.url, "https://x.atlassian.net/wiki/spaces/DOCS/pages/42/Doc");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a payload without an id is a malformed boundary, not a crash", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ title: "no id" }), { status: 200, headers: { "content-type": "application/json" } });

  const { getPage } = await import("../dist/confluence.js");
  await assert.rejects(
    () => getPage({ email: "a@b.c", token: "t", baseUrl: "https://x" }, "1", undefined),
    (error) => error instanceof RemoteError && error.failure.kind === "malformed",
  );
});

test("an HTTP failure is classified and never echoes the body", async () => {
  globalThis.fetch = async () => new Response("secret internals", { status: 403 });

  const { getPage } = await import("../dist/confluence.js");
  await assert.rejects(
    () => getPage({ email: "a@b.c", token: "t", baseUrl: "https://x" }, "1", undefined),
    (error) => error.failure.kind === "auth" && !error.message.includes("secret"),
  );
});

test("oversized bodies are rejected instead of buffered", async () => {
  const response = new Response("x".repeat(1_000), { status: 200 });
  await assert.rejects(() => readTextBounded(response, 100), /exceeded 100 bytes/);
});

test("missing credentials produce an actionable note, not a crash", async () => {
  const home = mkdtempSync(join(tmpdir(), "office-mcp-home-"));
  try {
    // HOME is redirected so the real ~/.pi/agent/jira-config.json is never read.
    for (const key of ["CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN", "CONFLUENCE_BASE_URL"]) delete process.env[key];
    process.env.HOME = home;

    globalThis.fetch = async () => {
      throw new Error("network must not be reached without credentials");
    };
    const output = await readConfluencePage("https://x.atlassian.net/wiki/spaces/A/pages/123456/T", undefined);
    assert.equal(output.status, "unavailable");
    assert.equal(output.reason, "auth");
    assert.match(output.notes.join(" "), /CONFLUENCE_EMAIL/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unusable locator is rejected before credentials are read", async () => {
  globalThis.fetch = async () => {
    throw new Error("network must not be reached for an invalid locator");
  };
  const output = await readConfluencePage("https://example.com/no/page/id", undefined);
  assert.equal(output.status, "unavailable");
  assert.equal(output.reason, "unsupported");
});

test("a base URL that already ends with /wiki is normalised once", () => {
  const candidates = getCredentialCandidates({
    CONFLUENCE_EMAIL: "a@b.c",
    CONFLUENCE_API_TOKEN: "t",
    CONFLUENCE_BASE_URL: "https://x.atlassian.net/wiki/",
  });
  assert.equal(candidates[0].baseUrl, "https://x.atlassian.net", "no /wiki/wiki/rest path is built");
});

test("comments are truncated only when the API offers a next page", async () => {
  const home = mkdtempSync(join(tmpdir(), "office-mcp-home-"));
  try {
    withEnv({
      HOME: home,
      CONFLUENCE_EMAIL: "a@b.c",
      CONFLUENCE_API_TOKEN: "t",
      CONFLUENCE_BASE_URL: "https://x.atlassian.net",
    });
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      history: { createdBy: { displayName: "Ada" }, createdDate: "2026-01-01" },
      body: { view: { value: `<p>c${index}</p>` } },
    }));
    const { readConfluenceComments } = await import("../dist/tools.js");

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ results: rows, size: 100, limit: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const exact = await readConfluenceComments("42");
    assert.equal(exact.count, 100);
    assert.equal(exact.truncated, false, "a full page of exactly 100 comments is not evidence of more");

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ results: rows, size: 100, limit: 100, _links: { next: "/rest/api/content/42/child/comment?start=100" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const more = await readConfluenceComments("42");
    assert.equal(more.truncated, true, "a next link is evidence of more comments");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("zero matches is an empty success, not a failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "office-mcp-home-"));
  try {
    withEnv({
      HOME: home,
      CONFLUENCE_EMAIL: "a@b.c",
      CONFLUENCE_API_TOKEN: "t",
      CONFLUENCE_BASE_URL: "https://x.atlassian.net",
    });
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ results: [], size: 0, totalSize: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const { readConfluenceComments, searchConfluence } = await import("../dist/tools.js");
    const comments = await readConfluenceComments("42");
    assert.equal(comments.status, "empty");
    assert.equal(comments.count, 0);

    const search = await searchConfluence({ cql: "text~nothing", limit: 10 });
    assert.equal(search.status, "empty");
    assert.equal(search.results.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
