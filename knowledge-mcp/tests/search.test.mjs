/**
 * Search factory: qmd→rg behaviour with an injected runner (no binary, no
 * network, no qmd), the clip(…,240)/limit caps, the index-update TTL with an
 * injected clock, and rgContext line parsing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSearch } from "../dist/search.js";

const OK = { code: 0, stdout: "", stderr: "" };

function recording(handler) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve(handler(cmd, args));
  };
  return { run, calls };
}

const qmdDisabled = { enabled: false, updateTtlMinutes: 10 };
const qmdEnabled = { enabled: true, updateTtlMinutes: 10 };

test("qmd disabled by config: availability is false and search goes straight to rg", async () => {
  const { run, calls } = recording(() => ({ ...OK, stdout: "a.md\nb.md\n" }));
  const s = createSearch({ run, qmd: qmdDisabled });

  assert.equal(await s.qmdAvailable(), false);
  const out = await s.searchVault("/vault", "alpha error");
  assert.equal(out.provider, "rg");
  assert.deepEqual(out.hits.map((h) => h.path), ["a.md", "b.md"]);
  assert.equal(out.hits[0].snippet, "(filename/content match)");
  assert.deepEqual(calls.map((c) => c.cmd), ["rg"], "no qmd binary may be invoked");
  assert.deepEqual(calls[0].args, ["-i", "--max-count", "3", "-l", "--glob", "*.md", "-g", "!.obsidian", "alpha error"]);
  assert.equal(calls[0].opts.cwd, "/vault");
  assert.equal(out.skipped, undefined);
});

test("scope is passed as a path argument before the globs", async () => {
  const { run, calls } = recording(() => ({ ...OK }));
  const s = createSearch({ run, qmd: qmdDisabled });
  await s.searchVault("/vault", "q", { scope: "/Projects/" });
  assert.deepEqual(calls[0].args, ["-i", "--max-count", "3", "-l", "Projects/", "--glob", "*.md", "-g", "!.obsidian", "q"]);
});

test("empty first pass falls back to any-term matching", async () => {
  let call = 0;
  const { run, calls } = recording(() => {
    call++;
    return call === 1 ? { ...OK, stdout: "" } : { ...OK, stdout: "x.md\n" };
  });
  const s = createSearch({ run, qmd: qmdDisabled });
  const out = await s.searchVault("/vault", "alpha error");
  assert.deepEqual(calls.map((c) => c.cmd), ["rg", "rg"]);
  assert.deepEqual(calls[1].args, ["-i", "-l", "--glob", "*.md", "-g", "!.obsidian", "alpha|error"]);
  assert.equal(out.hits[0].snippet, "(any-term match)");
});

test("limit is capped at 100 (default 20)", async () => {
  const many = Array.from({ length: 150 }, (_, i) => `n${i}.md`).join("\n") + "\n";
  const capped = recording(() => ({ ...OK, stdout: many }));
  const s1 = createSearch({ run: capped.run, qmd: qmdDisabled });
  assert.equal((await s1.searchVault("/v", "q", { limit: 500 })).hits.length, 100);

  const def = recording(() => ({ ...OK, stdout: many }));
  const s2 = createSearch({ run: def.run, qmd: qmdDisabled });
  assert.equal((await s2.searchVault("/v", "q")).hits.length, 20);
});

test("prefer=rg bypasses qmd and says so", async () => {
  const { run, calls } = recording(() => ({ ...OK, stdout: "hit.md\n" }));
  const s = createSearch({ run, qmd: qmdEnabled });
  const out = await s.searchVault("/vault", "q", { prefer: "rg" });
  assert.equal(out.provider, "rg");
  assert.equal(out.skipped, "qmd bypassed (prefer=rg)");
  assert.deepEqual(calls.map((c) => c.cmd), ["rg"]);
});

test("qmd path: URIs rewritten, non-md filtered, snippets clipped at 240, scores rounded", async () => {
  const rows = [
    { score: 0.1234567, file: "qmd://work/Projects/overview.md", line: 12, snippet: "x".repeat(300) },
    { file: "qmd://work/img.png" },
    { file: "/vault/Notes/x.md", snippet: "absolute uri" },
  ];
  const { run, calls } = recording((cmd, args) => {
    if (cmd === "qmd" && args[0] === "--version") return { ...OK, stdout: "qmd 1.0\n" };
    if (cmd === "qmd" && args[0] === "search") return { ...OK, stdout: JSON.stringify(rows) };
    return { ...OK };
  });
  const s = createSearch({ run, qmd: qmdEnabled });

  const out = await s.searchVault("/vault", "alpha");
  assert.equal(out.provider, "qmd");
  assert.equal(out.hits.length, 2);
  assert.equal(out.hits[0].path, "Projects/overview.md");
  assert.equal(out.hits[0].line, 12);
  assert.equal(out.hits[0].score, 0.123);
  assert.equal(out.hits[0].snippet.length, 241);
  assert.ok(out.hits[0].snippet.endsWith("…"));
  assert.equal(out.hits[1].path, "Notes/x.md");

  assert.deepEqual(calls.map((c) => c.cmd + ":" + c.args[0]), ["qmd:--version", "qmd:update", "qmd:search"]);
  assert.deepEqual(calls[2].args, ["search", "--json", "--limit", "20", "alpha"]);
  assert.equal(calls[1].opts.cwd, "/vault");
});

test("qmd failure or bad JSON falls back to rg", async () => {
  for (const stdout of ["not json", "[{},5]"]) {
    const rg = recording((cmd, args) => {
      if (cmd === "qmd" && args[0] === "search") return { ...OK, stdout };
      if (cmd === "qmd") return { ...OK, stdout: "qmd 1.0\n" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const s = createSearch({ run: rg.run, qmd: qmdEnabled });
    const out = await s.searchVault("/vault", "q");
    assert.equal(out.provider, "rg");
    assert.deepEqual(out.hits, []);
  }

  const failing = recording((cmd, args) => {
    if (cmd === "qmd" && args[0] === "search") return { code: 2, stdout: "", stderr: "boom" };
    if (cmd === "qmd") return { ...OK, stdout: "qmd 1.0\n" };
    return { ...OK, stdout: "fallback.md\n" };
  });
  const s = createSearch({ run: failing.run, qmd: qmdEnabled });
  const out = await s.searchVault("/vault", "q");
  assert.equal(out.provider, "rg");
  assert.deepEqual(out.hits.map((h) => h.path), ["fallback.md"]);
});

test("the index-update TTL uses the injected clock", async () => {
  let t = 1_000_000;
  const { run, calls } = recording((cmd, args) => {
    if (cmd === "qmd" && args[0] === "search") return { ...OK, stdout: "[]" };
    return { ...OK };
  });
  const s = createSearch({ run, qmd: { enabled: true, updateTtlMinutes: 10 }, now: () => t });

  await s.searchVault("/v", "x"); // first call refreshes
  t += 60_000;
  await s.searchVault("/v", "x"); // inside the TTL: no refresh
  t += 10 * 60_000;
  await s.searchVault("/v", "x"); // past the TTL: refresh again
  assert.equal(calls.filter((c) => c.cmd === "qmd" && c.args[0] === "update").length, 2);
});

test("updateTtlMinutes 0 never refreshes the index", async () => {
  const { run, calls } = recording((cmd, args) => {
    if (cmd === "qmd" && args[0] === "search") return { ...OK, stdout: "[]" };
    return { ...OK };
  });
  const s = createSearch({ run, qmd: { enabled: true, updateTtlMinutes: 0 } });
  await s.searchVault("/v", "x");
  await s.searchVault("/v", "x");
  assert.equal(calls.filter((c) => c.cmd === "qmd" && c.args[0] === "update").length, 0);
});

test("rgContext: first line per file, context and scope args, clip at 240, limit 50", async () => {
  const text = "c".repeat(300);
  const { run, calls } = recording(() => ({
    ...OK,
    stdout: `Notes/a.md-3-ctx line\nNotes/a.md:4:second\nNotes/b.md-7-${text}\n`,
  }));
  const s = createSearch({ run, qmd: qmdDisabled });

  const hits = await s.rgContext("/vault", "query");
  assert.deepEqual(calls[0].args, ["-i", "--max-count", "12", "-n", "-C", "1", "--glob", "*.md", "-g", "!.obsidian", "query"]);
  assert.equal(calls[0].opts.cwd, "/vault");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].path, "Notes/a.md");
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].snippet, "ctx line");
  assert.equal(hits[1].path, "Notes/b.md");
  assert.equal(hits[1].line, 7);
  assert.equal(hits[1].snippet.length, 241);

  await s.rgContext("/vault", "q", { context: 2, scope: "/Notes/", limit: 99 });
  // rgContext (unlike searchVault) appends the scope after the globs — as in the source
  assert.deepEqual(calls[1].args, ["-i", "--max-count", "50", "-n", "-C", "2", "--glob", "*.md", "-g", "!.obsidian", "Notes/", "q"]);

  const failing = recording(() => ({ code: 1, stdout: "", stderr: "" }));
  const s2 = createSearch({ run: failing.run, qmd: qmdDisabled });
  assert.deepEqual(await s2.rgContext("/vault", "q"), []);
});
