/**
 * Router behaviour: chain order, skipping with reasons, fall-through on empty
 * results and on errors, the degraded-semantic note, the probe cache, and scope
 * rejection. Providers are injected, so no binary, subscription or network is
 * involved.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CHAINS, Router } from "../dist/registry.js";

function fakeProvider(name, options = {}) {
  const {
    available = true,
    reason = "not installed",
    intents = [],
    hits = [],
    error = null,
    hangMs = 0,
    timeoutMs = 5_000,
    probes = { count: 0 },
  } = options;
  return {
    name,
    intents,
    timeoutMs,
    probes,
    probe: async () => {
      probes.count += 1;
      return available ? { ok: true, at: Date.now() } : { ok: false, reason, at: Date.now() };
    },
    search: async () => {
      if (hangMs > 0) await new Promise((resolve) => setTimeout(resolve, hangMs));
      if (error) throw error;
      return hits;
    },
  };
}

const hit = (path) => ({ path, snippet: "match", kind: "text" });

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "search-mcp-chain-"));
  writeFileSync(join(root, "a.ts"), "x");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const config = (overrides = {}) => ({ roots: [], providers: {}, ...overrides });

test("the chain order is the documented one", () => {
  assert.deepEqual(CHAINS.files, ["fd", "rgfiles", "mdfind"]);
  assert.deepEqual(CHAINS.semantic, ["auggie", "serena", "ast-grep", "rg"]);
  assert.deepEqual(CHAINS.crossrepo, ["zoekt", "rg"]);
  assert.deepEqual(CHAINS.machine, ["mdfind"]);
});

test("an empty result falls through and records why", async (t) => {
  const root = makeRoot(t);
  const router = new Router(config(), {
    providers: [
      fakeProvider("fd", { intents: ["files"], hits: [] }),
      fakeProvider("rgfiles", { intents: ["files"], hits: [hit("a.ts")] }),
      fakeProvider("mdfind", { intents: ["files"], hits: [] }),
    ],
  });
  const answer = await router.runChain("files", { query: "a", roots: [root] });
  assert.equal(answer.provider, "rgfiles");
  assert.equal(answer.count, 1);
  assert.deepEqual(answer.skipped, [{ name: "fd", reason: "no results" }]);
});

test("an error falls through with the provider's message", async (t) => {
  const root = makeRoot(t);
  const router = new Router(config(), {
    providers: [
      fakeProvider("fd", { intents: ["files"], error: new Error("fd exited 2: permission denied") }),
      fakeProvider("rgfiles", { intents: ["files"], hits: [hit("a.ts")] }),
      fakeProvider("mdfind", { intents: ["files"], hits: [] }),
    ],
  });
  const answer = await router.runChain("files", { query: "a", roots: [root] });
  assert.equal(answer.provider, "rgfiles");
  assert.deepEqual(answer.skipped, [{ name: "fd", reason: "fd exited 2: permission denied" }]);
});

test("a disabled provider is skipped by config, not by probe", async (t) => {
  const root = makeRoot(t);
  const provider = fakeProvider("fd", { intents: ["files"], hits: [hit("a.ts")] });
  const router = new Router(config({ providers: { fd: { enabled: false } } }), {
    providers: [provider, fakeProvider("rgfiles", { intents: ["files"], hits: [hit("b.ts")] })],
  });
  const answer = await router.runChain("files", { query: "a", roots: [root] });
  assert.equal(answer.provider, "rgfiles");
  assert.deepEqual(answer.skipped, [{ name: "fd", reason: "disabled by config" }]);
  assert.equal(provider.probes.count, 0, "a disabled provider is never probed");
});

test("an unavailable provider keeps its probe reason", async (t) => {
  const root = makeRoot(t);
  const router = new Router(config(), {
    providers: [
      fakeProvider("fd", { intents: ["files"], available: false, reason: "fd not found" }),
      fakeProvider("rgfiles", { intents: ["files"], hits: [hit("a.ts")] }),
    ],
  });
  const answer = await router.runChain("files", { query: "a", roots: [root] });
  assert.deepEqual(answer.skipped, [{ name: "fd", reason: "fd not found" }]);
});

test("semantic degraded to rg carries the documented note", async (t) => {
  const root = makeRoot(t);
  const router = new Router(config({ providers: { auggie: { enabled: false }, serena: { enabled: false } } }), {
    providers: [
      fakeProvider("ast-grep", { intents: ["structure", "semantic"], available: false, reason: "ast-grep not installed" }),
      fakeProvider("rg", { intents: ["text", "semantic"], hits: [hit("a.ts")] }),
    ],
  });
  const answer = await router.runChain("semantic", { query: "where is a", roots: [root] });
  assert.equal(answer.provider, "rg");
  assert.equal(answer.note, "degraded: lexical only — semantic providers unavailable/disabled");
  assert.deepEqual(
    answer.skipped.map((entry) => entry.name),
    ["auggie", "serena", "ast-grep"],
  );
});

test("when everything is empty, the first provider that answered is reported", async (t) => {
  const root = makeRoot(t);
  const router = new Router(config(), {
    providers: [
      fakeProvider("fd", { intents: ["files"], hits: [] }),
      fakeProvider("rgfiles", { intents: ["files"], hits: [] }),
      fakeProvider("mdfind", { intents: ["files"], hits: [] }),
    ],
  });
  const answer = await router.runChain("files", { query: "nothing", roots: [root] });
  assert.equal(answer.provider, "fd");
  assert.equal(answer.count, 0);
  assert.ok(answer.skipped.every((entry) => entry.reason === "no results"));
});

test("scope rejection reaches the caller with the contract wording", async () => {
  const router = new Router(config(), { providers: [fakeProvider("rg", { intents: ["text"], hits: [] })] });
  await assert.rejects(
    () => router.runChain("text", { query: "x", roots: ["/"] }),
    /root too broad, rejected: \//,
  );
});

test("a query must not be empty", async () => {
  const router = new Router(config(), { providers: [] });
  await assert.rejects(() => router.runChain("text", { query: "   " }), /query is required/);
});

test("probes are cached within the TTL", async (t) => {
  const root = makeRoot(t);
  const rg = fakeProvider("rg", { intents: ["text"], hits: [hit("a.ts")] });
  const router = new Router(config(), { providers: [rg], probeTtlMs: 60_000 });
  await router.runChain("text", { query: "a", roots: [root] });
  await router.runChain("text", { query: "a", roots: [root] });
  assert.equal(rg.probes.count, 1);
});

test("a provider that ignores its timeout is abandoned after the grace window", async (t) => {
  const root = makeRoot(t);
  // The runner waits timeoutMs + 2s before giving up, so the fake must outlive it.
  const router = new Router(config(), {
    providers: [fakeProvider("rg", { intents: ["text"], hangMs: 2_400, timeoutMs: 20 })],
  });
  await assert.rejects(
    () => router.runChain("text", { query: "a", roots: [root] }),
    (error) => {
      assert.match(error.message, /no provider answered intent "text"/);
      assert.match(error.message, /rg \(timeout after 20ms\)/);
      return true;
    },
  );
});

test("status reports enabled, availability and reasons", async () => {
  const router = new Router(config({ providers: { zoekt: { enabled: false } } }), {
    providers: [
      fakeProvider("rg", { intents: ["text"] }),
      fakeProvider("zoekt", { intents: ["crossrepo"], available: false, reason: "webserver unreachable" }),
    ],
  });
  const status = await router.status();
  assert.deepEqual(status[0], { name: "rg", enabled: true, available: true, intents: ["text"] });
  assert.equal(status[1].enabled, false);
  assert.equal(status[1].reason, "disabled by config");
});

test("a reloaded config replaces the roots immediately", async (t) => {
  const root = makeRoot(t);
  const router = new Router(config(), { providers: [fakeProvider("rg", { intents: ["text"], hits: [hit("a.ts")] })] });
  router.applyConfig(config({ roots: [root] }));
  const answer = await router.runChain("text", { query: "a" });
  assert.equal(answer.count, 1);
});
