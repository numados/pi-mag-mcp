/**
 * Pipeline behaviour: statuses, fallback, budget, cancellation, concurrency.
 *
 * Providers are injected, so nothing here touches the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runSearch, guidanceFor, readDeadlineMs } from "../dist/pipeline.js";
import { webSearchOutputSchema } from "../dist/contract.js";
import { renderText, isErrorResult } from "../dist/render.js";

const item = (url = "https://example.com/a") => ({
  title: "Title",
  url,
  snippet: "Snippet",
  snippetTruncated: false,
});

const okProvider = (results) => async () => ({
  outcome: { results, droppedUnsafeUrls: 0 },
  step: { provider: "fake", outcome: results.length > 0 ? "ok" : "empty" },
});

const failProvider = (reason, error = "boom") => async () => ({
  outcome: { results: [], droppedUnsafeUrls: 0, error, reason },
  step: { provider: "fake", outcome: "error", error, reason },
});

const creds = { allowQuota: false };

test("auto mode returns results with ok status and provider provenance", async () => {
  const out = await runSearch("q", "auto", 5, {
    signal: new AbortController().signal,
    credentials: creds,
    duckduckgo: okProvider([item()]),
  });
  assert.equal(out.status, "ok");
  assert.equal(out.provider, "fake");
  assert.equal(out.results.length, 1);
  assert.equal(webSearchOutputSchema.safeParse(out).success, true);
});

test("a provider answering with zero results is empty, not an error", async () => {
  const out = await runSearch("q", "auto", 5, {
    signal: new AbortController().signal,
    credentials: creds,
    duckduckgo: okProvider([]),
  });
  assert.equal(out.status, "empty");
  assert.equal(isErrorResult(out), false, "empty must not be an execution error");
  assert.match(renderText(out), /No matching results/);
});

test("a provider outage is unavailable, never empty", async () => {
  const out = await runSearch("q", "auto", 5, {
    signal: new AbortController().signal,
    credentials: creds,
    duckduckgo: failProvider("blocked", "bot challenge"),
  });
  assert.equal(out.status, "unavailable");
  assert.equal(isErrorResult(out), true);
  assert.equal(out.chain[0].reason, "blocked");
  const text = renderText(out);
  assert.match(text, /Search unavailable/);
  assert.match(text, /says nothing about whether the information exists/);
});

test("deep mode falls back to DuckDuckGo and records the fallback", async () => {
  const out = await runSearch("q", "deep", 5, {
    signal: new AbortController().signal,
    credentials: creds,
    tavily: failProvider("rate-limited", "daily cap reached"),
    duckduckgo: okProvider([item()]),
  });
  assert.equal(out.status, "ok");
  assert.equal(out.provider, "fake");
  assert.deepEqual(out.fallback, {
    from: "fake",
    to: "fake",
    reason: "daily cap reached",
  });
  assert.equal(out.chain.length, 2);
  assert.match(renderText(out), /Fallback/);
});

test("deep mode with both providers failing is unavailable with per-provider causes", async () => {
  const out = await runSearch("q", "deep", 5, {
    signal: new AbortController().signal,
    credentials: creds,
    tavily: failProvider("rate-limited", "cap"),
    duckduckgo: failProvider("blocked", "challenge"),
  });
  assert.equal(out.status, "unavailable");
  assert.deepEqual(
    out.chain.map((step) => step.reason),
    ["rate-limited", "blocked"],
  );
  assert.ok(out.notes.length >= 2, "each cause gets guidance plus the no-evidence note");
});

test("caller cancellation is reported as cancelled and marks no provider", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("user cancelled", "AbortError"));
  const out = await runSearch("q", "auto", 5, {
    signal: controller.signal,
    credentials: creds,
    duckduckgo: okProvider([item()]),
  });
  assert.equal(out.status, "cancelled");
  assert.equal(out.results.length, 0);
  assert.equal(isErrorResult(out), true);
});

test("the deadline bounds a provider that ignores its signal", async () => {
  // A provider that never resolves and never reacts to the signal: the whole
  // search must still finish on the budget instead of hanging the tool.
  // The keep-alive timer stands in for the stdio transport, which normally
  // keeps the event loop alive for the duration of a request.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const ignored = () => new Promise(() => {});
    const started = Date.now();
    const out = await runSearch("q", "auto", 5, {
      signal: new AbortController().signal,
      credentials: creds,
      deadlineMs: 40,
      duckduckgo: ignored,
    });
    assert.ok(Date.now() - started < 1_000, "the search returned promptly");
    assert.equal(out.status, "unavailable");
    assert.equal(out.chain[0].reason, "timeout");
    assert.match(renderText(out), /budget/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("retry hints come only from provider data", () => {
  assert.match(
    guidanceFor({ provider: "tavily", outcome: "error", reason: "rate-limited", retryAfterSec: 42 }),
    /42s/,
  );
  const withoutHint = guidanceFor({ provider: "tavily", outcome: "error", reason: "rate-limited" });
  assert.match(withoutHint, /retrying later may work/);
  assert.doesNotMatch(withoutHint, /\d+s/, "no invented wait time");
});

test("unknown causes are stated as unconfirmed", () => {
  assert.match(guidanceFor({ provider: "x", outcome: "error" }), /could not be confirmed/);
});

test("deadline configuration is clamped", () => {
  assert.equal(readDeadlineMs({}), 30_000);
  assert.equal(readDeadlineMs({ WEB_SEARCH_DEADLINE_MS: "10" }), 1_000);
  assert.equal(readDeadlineMs({ WEB_SEARCH_DEADLINE_MS: "9999999" }), 120_000);
  assert.equal(readDeadlineMs({ WEB_SEARCH_DEADLINE_MS: "nonsense" }), 30_000);
});

test("failure is rendered with its causes and no speculative claim", async () => {
  const out = await runSearch("q", "auto", 5, {
    signal: new AbortController().signal,
    credentials: creds,
    duckduckgo: failProvider("timeout", "timed out"),
  });
  const text = renderText(out);
  assert.match(text, /did not answer within the time budget/);
  assert.match(text, /nothing about whether the information exists/);
});
