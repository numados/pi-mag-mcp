/**
 * Shipped text must stay free of machine- and tenant-specific data: no home
 * directories, no customer or product names, no real ticket prefixes. The
 * examples in schemas, requirements and tests use neutral names only, so a
 * copy of this package never leaks where it was written or for whom.
 *
 * This guard is deliberately a shape check (absolute home paths, ticket-like
 * identifiers outside a neutral allowlist) rather than a denylist of names —
 * writing the names into the test would leak them again.
 */

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const shipped = [
  ...walk(join(packageRoot, "src")).filter((p) => p.endsWith(".ts")),
  join(packageRoot, "requirements.json"),
  ...walk(join(packageRoot, "tests")).filter((p) => p.endsWith(".mjs")),
];

/** Home directories of real machines: `/Users/<name>`, `/home/<name>`. */
const HOME_PATH = /\/(Users|home)\/[A-Za-z0-9._-]+\//;

/** Ticket-like identifiers (`ABC-123`) are legitimate, but the prefix must be
 *  a neutral example one — a real tracker prefix is a tenant detail. */
const TICKET = /\b([A-Z]{2,6})-\d{2,}\b/g;
const NEUTRAL_PREFIXES = new Set(["ABC", "PLAN", "PROJ", "TASK", "SAMPLE", "EXAMPLE", "LOCAL"]);

test("shipped text contains no real home directory", () => {
  for (const file of shipped) {
    const text = readFileSync(file, "utf8");
    const hit = HOME_PATH.exec(text);
    assert.equal(hit, null, `${file.replace(packageRoot + "/", "")}: ${hit?.[0]} — use a fixture path from os.tmpdir()`);
  }
});

test("ticket-like examples use a neutral prefix", () => {
  for (const file of shipped) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(TICKET)) {
      assert.ok(
        NEUTRAL_PREFIXES.has(match[1]),
        `${file.replace(packageRoot + "/", "")}: "${match[0]}" looks like a real tracker id — use a neutral example`,
      );
    }
  }
});

test("tool descriptions carry no absolute path or ticket id", async () => {
  const { TOOLS } = await import("../dist/contract.js");
  for (const tool of TOOLS) {
    const text = [tool.title ?? "", tool.description, JSON.stringify(tool.inputSchema)].join(" ");
    assert.equal(HOME_PATH.test(text), false, `${tool.name}: description carries a home path`);
  }
});
