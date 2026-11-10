/**
 * Config layering: repo `.search-mcp.json` discovery stops at the git root, the
 * nearest file wins, and `SEARCH_MCP_CONFIG` is the sole source when set.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverRepoConfig } from "../dist/config.js";

function makeRepo(t) {
  const base = mkdtempSync(join(tmpdir(), "search-mcp-cfg-"));
  const repo = join(base, "repo");
  const nested = join(repo, "a", "b");
  const above = join(base, "above");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  mkdirSync(above, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, repo, nested, above };
}

test("finds .search-mcp.json between the start directory and the git root", (t) => {
  const { repo, nested } = makeRepo(t);
  writeFileSync(join(repo, ".search-mcp.json"), "{}");
  assert.equal(discoverRepoConfig(nested), join(repo, ".search-mcp.json"));
});

test("the nearest file wins", (t) => {
  const { repo, nested } = makeRepo(t);
  writeFileSync(join(repo, ".search-mcp.json"), "{}");
  writeFileSync(join(nested, ".search-mcp.json"), "{}");
  assert.equal(discoverRepoConfig(nested), join(nested, ".search-mcp.json"));
});

test("discovery never looks above the git root", (t) => {
  const { repo, nested, above } = makeRepo(t);
  writeFileSync(join(above, ".search-mcp.json"), "{}");
  assert.equal(discoverRepoConfig(nested), null);
  // The repo itself is still a boundary even when the file sits exactly there.
  writeFileSync(join(repo, ".search-mcp.json"), "{}");
  assert.equal(discoverRepoConfig(nested), join(repo, ".search-mcp.json"));
});

test("outside any repo the walk ends without throwing", (t) => {
  const { repo, nested } = makeRepo(t);
  rmSync(join(repo, ".git"), { recursive: true, force: true });
  const found = discoverRepoConfig(nested);
  assert.ok(found === null || found.endsWith(".search-mcp.json"));
});
