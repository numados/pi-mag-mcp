/**
 * Subprocess layer: argv-only execution (no shell), a bounded timeout that kills
 * the child, failure reported as a code instead of a throw, and PATH resolution
 * that never spawns anything.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { findOnPath, run } from "../dist/subprocess.js";

const node = process.execPath;

test("arguments are passed literally, never through a shell", async () => {
  const dangerous = "a; rm -rf /tmp/search-mcp-should-not-exist $(id) `id`";
  const result = await run(node, ["-e", "console.log(process.argv[1])", dangerous], { timeoutMs: 10_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), dangerous);
});

test("a missing executable reports code -1 instead of throwing", async () => {
  const result = await run("definitely-not-a-real-binary-xyz", [], { timeoutMs: 5_000 });
  assert.equal(result.code, -1);
  assert.match(result.stderr, /ENOENT|not found/i);
});

test("a non-zero exit keeps the child's stderr for the caller", async () => {
  const result = await run(node, ["-e", "console.error('boom'); process.exit(3)"], { timeoutMs: 10_000 });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /boom/);
});

test("a timeout kills the child and marks the result", async () => {
  const started = Date.now();
  const result = await run(node, ["-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 300 });
  assert.equal(result.code, -1);
  assert.match(result.stderr, /timeout after 300ms/);
  assert.ok(Date.now() - started < 10_000, "the call returns at the timeout, not when the child finishes");
});

test("output over the budget aborts the call", async () => {
  const result = await run(node, ["-e", "process.stdout.write('x'.repeat(200000))"], {
    timeoutMs: 15_000,
    maxOutputBytes: 1_000,
  });
  assert.equal(result.code, -1);
  assert.match(result.stderr, /output over 1000 bytes/);
});

test("findOnPath resolves an existing binary and rejects a missing one", () => {
  assert.ok(findOnPath("node"), "node is on PATH in this test");
  assert.equal(findOnPath("definitely-not-a-real-binary-xyz"), null);
  assert.equal(findOnPath("/definitely/not/here/node"), null);
});
