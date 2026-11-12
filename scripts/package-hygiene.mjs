/** Shared test guard for package text. Tests inspect files directly, including untracked additions. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HOME_PATH = /\/(Users|home)\/[A-Za-z0-9._-]+\//;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TICKET = /\b([A-Z]{2,6})-\d{2,}\b/g;
const NEUTRAL_PREFIXES = new Set(["ABC", "PLAN", "PROJ", "TASK", "SAMPLE", "EXAMPLE", "LOCAL", "SMOKE", "CANON", "LEGACY", "MULTI", "STRING", "ROUTED", "FLOW"]);

export function contentFindings(text, denylist = []) {
  const findings = [];
  if (HOME_PATH.test(text)) findings.push("absolute home path");
  for (const [match] of text.matchAll(EMAIL)) {
    // A Teams thread identifier is not a personal e-mail address.
    if (!match.includes("@thread.")) findings.push("e-mail address");
  }
  for (const [, prefix] of text.matchAll(TICKET)) {
    if (!NEUTRAL_PREFIXES.has(prefix)) findings.push("non-placeholder ticket prefix");
  }
  if (denylist.some((token) => text.toLowerCase().includes(token))) findings.push("denylisted name");
  return findings;
}

function shippedFiles(root) {
  const files = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) return;
    if (statSync(absolute).isFile()) {
      files.push(relative);
      return;
    }
    for (const entry of readdirSync(absolute)) {
      if (!["node_modules", "dist"].includes(entry)) walk(path.join(relative, entry));
    }
  }
  for (const entry of ["src", "tests", "skills", "README.md", "requirements.json", "package.json", "config.example.json", "installation.example.json"]) walk(entry);
  return files;
}

export function registerPackageHygiene(testUrl) {
  const root = path.resolve(path.dirname(fileURLToPath(testUrl)), "..");
  test("shipped package text contains no machine data or denylisted names", () => {
    const files = shippedFiles(root);
    for (const required of ["README.md", "package.json"]) assert.ok(files.includes(required));
    for (const dir of ["src", "tests"]) assert.ok(files.some((file) => file.startsWith(`${dir}${path.sep}`)));
    const denylistPath = process.env.CONTENT_DENYLIST ?? path.join(homedir(), ".pi", "agent", "content-denylist.txt");
    const denylist = existsSync(denylistPath) ? readFileSync(denylistPath, "utf8")
      .split("\n").map((line) => line.trim().toLowerCase()).filter((line) => line && !line.startsWith("#")) : [];
    const findings = files.flatMap((file) => contentFindings(readFileSync(path.join(root, file), "utf8"), denylist)
      .map((kind) => `${file}: ${kind}`));
    assert.deepEqual(findings, []);
  });
}
