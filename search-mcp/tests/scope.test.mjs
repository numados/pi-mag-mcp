/**
 * Scope enforcement is part of the contract: these messages are quoted by
 * skills and agent instructions, so the wording is asserted, not just the throw.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { assertRoot, assertRoots, clipLimit, clipSnippet, truncate } from "../dist/scope.js";

const config = { roots: [], providers: {} };

test("broad roots are rejected with the documented message", () => {
  assert.throws(() => assertRoot(config, "/"), /root too broad, rejected: \//);
  assert.throws(() => assertRoot(config, "~"), /too broad/);
  assert.throws(() => assertRoot(config, homedir()), /too broad/);
  assert.throws(() => assertRoot(config, "/Users"), /too broad/);
  assert.throws(() => assertRoot(config, "/private/tmp"), /too broad/);
});

test("a root that does not exist is named in the error", () => {
  assert.throws(() => assertRoot(config, "/definitely/not/here"), /root not found: \/definitely\/not\/here/);
});

test("hidden paths are rejected unless a configured root covers them", () => {
  assert.throws(() => assertRoot(config, "~/.config"), /hidden path rejected/);

  const allowedRoot = `${homedir()}/.config/search-mcp-scope-test`;
  const allowed = { roots: [allowedRoot], providers: {} };
  mkdirSync(`${allowedRoot}/.hidden`, { recursive: true });
  try {
    assert.equal(assertRoot(allowed, `${allowedRoot}/.hidden`), resolve(`${allowedRoot}/.hidden`));
  } finally {
    rmSync(allowedRoot, { recursive: true, force: true });
  }
});

test("a root outside the configured allowlist is rejected", () => {
  const allowlisted = { roots: ["/Users/someone/Personal"], providers: {} };
  assert.throws(() => assertRoot(allowlisted, "/Users/someone/Other"), /root outside configured allowed roots/);
});

test("assertRoots rejects an empty list and names the offending root", () => {
  assert.throws(() => assertRoots(config, []), /no roots given and no default for this intent/);
  assert.throws(() => assertRoots(config, ["/"]), /too broad/);
});

test("limits and snippets are clipped to the documented bounds", () => {
  assert.equal(clipLimit(undefined), 50);
  assert.equal(clipLimit(1_000), 200);
  assert.equal(clipLimit(-5), 50);
  assert.equal(clipLimit(0), 50);
  assert.equal(clipSnippet(undefined), 240);
  assert.equal(clipSnippet(99_999), 2_000);
});

test("snippets collapse whitespace and mark truncation", () => {
  assert.equal(truncate("  a\n\tb  ", 100), "a b");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});
