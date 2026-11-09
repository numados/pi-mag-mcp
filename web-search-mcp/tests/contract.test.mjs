/**
 * Contract invariants: input rules, output schema and the quota gate.
 *
 * These are the properties research §8 requires to be checkable: the advertised
 * schema and runtime validation cannot disagree, and a key in the environment
 * must not by itself spend account credits.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, webSearchInputSchema, webSearchOutputSchema, ENV } from "../dist/contract.js";
import { readTavilyCredentials, mapTavilyResponse } from "../dist/tavily.js";
import { searchTavily } from "../dist/tavily.js";

const parse = (value) => webSearchInputSchema.safeParse(value);

test("query is required, trimmed and length-bounded", () => {
  assert.equal(parse({}).success, false);
  assert.equal(parse({ query: "" }).success, false);
  assert.equal(parse({ query: "   " }).success, false);
  assert.equal(parse({ query: "  padded  " }).data.query, "padded", "surrounding whitespace is not sent to providers");
  assert.equal(parse({ query: "x".repeat(LIMITS.queryMaxChars) }).success, true);
  assert.equal(parse({ query: "x".repeat(LIMITS.queryMaxChars + 1) }).success, false);
});

test("count is a bounded integer with a real default", () => {
  assert.equal(parse({ query: "q" }).data.count, 5);
  for (const bad of [0, -1, 1.5, LIMITS.maxResults + 1, "5", null]) {
    assert.equal(parse({ query: "q", count: bad }).success, false, `count=${bad} must be rejected`);
  }
  assert.equal(parse({ query: "q", count: 1 }).data.count, 1);
  assert.equal(parse({ query: "q", count: LIMITS.maxResults }).data.count, LIMITS.maxResults);
});

test("an unknown mode is rejected instead of silently becoming auto", () => {
  assert.equal(parse({ query: "q", mode: "typo" }).success, false);
  assert.equal(parse({ query: "q", mode: "auto" }).data.mode, "auto");
  assert.equal(parse({ query: "q" }).data.mode, "auto");
  assert.equal(parse({ query: "q", mode: "deep" }).data.mode, "deep");
});

test("the output schema accepts every documented status and rejects others", () => {
  const base = {
    query: "q",
    mode: "auto",
    provider: null,
    results: [],
    chain: [],
    fallback: null,
    droppedUnsafeUrls: 0,
    resultsTruncated: false,
    notes: [],
  };
  for (const status of ["ok", "empty", "unavailable", "cancelled"]) {
    assert.equal(webSearchOutputSchema.safeParse({ ...base, status }).success, true, `status ${status}`);
  }
  assert.equal(webSearchOutputSchema.safeParse({ ...base, status: "failed" }).success, false);
  assert.equal(
    webSearchOutputSchema.safeParse({
      ...base,
      status: "unavailable",
      chain: [{ provider: "x", outcome: "error", reason: "made-up-reason" }],
    }).success,
    false,
    "an unrecognised cause cannot leak through the contract",
  );
});

test("a key alone never enables account spend", () => {
  const withKey = readTavilyCredentials({ [ENV.tavilyKey]: "tvly-secret" });
  assert.equal(withKey.allowQuota, false, "presence of a key is not permission to use it");
  assert.equal(withKey.apiKey, "tvly-secret");

  const opted = readTavilyCredentials({ [ENV.tavilyKey]: "tvly-secret", [ENV.allowQuota]: "1" });
  assert.equal(opted.allowQuota, true);

  const noKey = readTavilyCredentials({});
  assert.equal(noKey.apiKey, undefined);
  assert.equal("apiKey" in noKey, false, "no placeholder key is ever invented");
});

test("keyless deep search sends no Authorization header even when a key exists", async (t) => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(init?.headers ?? {});
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const { step } = await searchTavily("q", 5, new AbortController().signal, {
      allowQuota: false,
      apiKey: "tvly-should-not-be-sent",
    });
    assert.equal(step.outcome, "empty");
    assert.equal(seen.length, 1, "only the keyless path was used");
    const headers = seen[0];
    assert.equal(
      Object.keys(headers).some((name) => name.toLowerCase() === "authorization"),
      false,
      "the account key must not travel on the free path",
    );
    assert.equal(
      headers["x-tavily-access-mode"],
      "keyless",
      "the free tier must be requested explicitly, or the endpoint answers 401",
    );
  } finally {
    globalThis.fetch = original;
    t.diagnostic("restored fetch");
  }
});

test("account path is reachable only with explicit opt-in", async (t) => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(init?.headers ?? {});
    // Keyless is capped; the account request succeeds.
    if (Object.keys(init?.headers ?? {}).some((name) => name.toLowerCase() === "authorization")) {
      return new Response(
        JSON.stringify({ results: [{ title: "paid result", url: "https://a.example/", content: "text" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ detail: "daily_cap_reached" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "30" },
    });
  };
  try {
    const denied = await searchTavily("q", 5, new AbortController().signal, {
      allowQuota: false,
      apiKey: "tvly-key",
    });
    assert.equal(denied.step.outcome, "error");
    assert.equal(denied.step.reason, "rate-limited");
    assert.equal(denied.step.retryAfterSec, 30, "the provider's own wait hint is kept");
    assert.equal(seen.length, 1, "no account request without opt-in");

    seen.length = 0;
    const allowed = await searchTavily("q", 5, new AbortController().signal, {
      allowQuota: true,
      apiKey: "tvly-key",
    });
    assert.equal(allowed.step.provider, "tavily-account");
    assert.equal(allowed.outcome.results.length, 1);
    assert.equal(seen.length, 2, "keyless first, then the allowed account attempt");
  } finally {
    globalThis.fetch = original;
    t.diagnostic("restored fetch");
  }
});

test("malformed provider JSON is a boundary failure, not a crash", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } });
  try {
    const { step } = await searchTavily("q", 5, new AbortController().signal, { allowQuota: false });
    assert.equal(step.outcome, "error");
    assert.equal(step.reason, "malformed");
  } finally {
    globalThis.fetch = original;
    t.diagnostic("restored fetch");
  }
});

test("oversized bodies are rejected instead of buffered", async (t) => {
  const original = globalThis.fetch;
  const huge = "x".repeat(LIMITS.maxResponseBytes + 1024);
  globalThis.fetch = async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } });
  try {
    const { step } = await searchTavily("q", 5, new AbortController().signal, { allowQuota: false });
    assert.equal(step.outcome, "error");
    assert.match(step.error, /exceeded|too large|bytes/i);
  } finally {
    globalThis.fetch = original;
    t.diagnostic("restored fetch");
  }
});

test("mapTavilyResponse keeps snippet provenance intact", () => {
  const outcome = mapTavilyResponse(
    { results: [{ title: "T", url: "https://a.example/", content: "x".repeat(900) }] },
    5,
  );
  assert.equal(outcome.results[0].snippetTruncated, true);
  assert.ok(outcome.results[0].snippet.length <= LIMITS.snippetMaxChars + 1);
});
