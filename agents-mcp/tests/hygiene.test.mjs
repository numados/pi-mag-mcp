/**
 * Content hygiene: nothing machine-specific or tenant-specific ships in the
 * package. The shape checks mirror ../scripts/check-content.sh (home paths,
 * e-mails, ticket-like ids), and the machine-local content denylist is applied
 * the same way when it is present.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["src", "tests", "README.md", "requirements.json", "package.json", "skills", "config.example.json"];

// Same shapes as scripts/check-content.sh.
const HOME_PATH = /\/(Users|home)\/[A-Za-z0-9._-]+\//;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const TICKET = /\b([A-Z]{2,6})-\d{2,}\b/g;
const TICKET_ALLOWLIST = new Set(["ABC", "PLAN", "PROJ", "TASK", "SAMPLE", "EXAMPLE", "LOCAL", "SMOKE", "CANON", "LEGACY", "MULTI", "STRING", "ROUTED", "FLOW"]);

function walk(target, out = []) {
  const absolute = path.join(root, target);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return out;
  }
  if (stats.isFile()) {
    out.push(target);
    return out;
  }
  for (const entry of readdirSync(absolute)) {
    if (entry === "node_modules" || entry === "dist") continue;
    walk(path.join(target, entry), out);
  }
  return out;
}

const files = SCANNED.flatMap((entry) => walk(entry));

test("the scan covers the shipped surface", () => {
  assert.ok(files.length >= 12, `expected the package sources, got ${files.length} files`);
  assert.ok(files.some((file) => file.startsWith("src")));
  assert.ok(files.some((file) => file.startsWith("tests")));
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("skills/delegate/SKILL.md"));
});

test("no absolute home paths ship", () => {
  const findings = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    const match = text.match(HOME_PATH);
    if (match) findings.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(findings, []);
});

test("no e-mail addresses ship", () => {
  const findings = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    const match = text.match(EMAIL);
    if (match) findings.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(findings, []);
});

test("no non-placeholder ticket ids ship", () => {
  const findings = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(TICKET)) {
      const prefix = match[1];
      if (!TICKET_ALLOWLIST.has(prefix)) findings.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(findings, []);
});

test("removed tenant aliases stay removed", () => {
  // Built without the literal tokens so the guard does not match itself.
  const removed = new RegExp(["cc", "ct"].join("-") + "|claude-" + "c" + "orp");
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    assert.ok(!removed.test(text), `${file} still references the removed corporate alias`);
  }
});

test("no denylisted tenant/employer/person names ship", () => {
  const denylistPath = path.join(homedir(), ".pi", "agent", "content-denylist.txt");
  if (!existsSync(denylistPath)) {
    // Same posture as check-content.sh: without a denylist only shape checks run.
    return;
  }
  const tokens = readFileSync(denylistPath, "utf8")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(tokens.length > 0, "denylist exists but is empty");
  const findings = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8").toLowerCase();
    for (const token of tokens) {
      if (text.includes(token)) findings.push(`${file}: ${token}`);
    }
  }
  assert.deepEqual(findings, []);
});
