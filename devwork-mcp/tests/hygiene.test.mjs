/**
 * Content hygiene: nothing machine-specific or tenant-specific ships in the
 * package. Placeholders are allowed; real home paths, tenant hosts and ticket
 * prefixes are not.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["src", "tests", "README.md", "requirements.json", "installation.example.json", "package.json"];

const RULES = [
  { name: "absolute home path", pattern: /(?:\/Users\/[a-z0-9._-]+|\/home\/[a-z0-9._-]+)/i },
  { name: "real ticket prefix", pattern: /\b(?:NUMDOS|FSE|CTE)-\d+/ },
  { name: "company tenant host", pattern: /https?:\/\/(?!your-company|example|acme|your-org)[a-z0-9-]+\.atlassian\.net/i },
  { name: "credential literal", pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "personal e-mail", pattern: /[a-z0-9._%+-]+@(?!example\.com|localhost)[a-z0-9.-]+\.[a-z]{2,}/i },
];

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
  assert.ok(files.length >= 15, `expected the package sources, got ${files.length} files`);
  assert.ok(files.some((file) => file.includes("installation.example.json")));
  assert.ok(files.some((file) => file.startsWith("src")));
});

test("no machine-specific or tenant-specific data ships", () => {
  const findings = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const rule of RULES) {
      const match = text.match(rule.pattern);
      if (match) findings.push(`${file}: ${rule.name} → "${match[0]}"`);
    }
  }
  assert.deepEqual(findings, []);
});

test("the example profile holds placeholders and disables unused backends", () => {
  const example = JSON.parse(readFileSync(path.join(root, "installation.example.json"), "utf8"));
  assert.equal(example.write.policy, "read-only", "an example must not ship write access by default");
  assert.equal(example.jira.auth, "off");
  assert.equal(example.ado.auth, "off");
  assert.match(example.github.token, /^env:/, "secrets are referenced, never stored");
  assert.match(example.repositoryRoot, /^~\//, "repository roots are written home-relative");
});
