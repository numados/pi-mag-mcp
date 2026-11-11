/** agent-file-size policy regressions.
 *
 *  Fixtures are throwaway git repos built with git init/add/commit ONLY
 *  (direct spawns) under an isolated HOME with GIT_CONFIG_NOSYSTEM=1,
 *  GIT_CONFIG_GLOBAL pointing at an empty file, and identity via env vars —
 *  no user config, no hooksPath, no remote activity ever.
 *
 *  These tests call checkStagedFileSize directly against staged blobs; they
 *  never commit in a real repository and never read live configuration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkStagedFileSize } from "../dist/agent-file-size.js";

// ── isolated git environment (before ANY git spawn) ───────────────────────

const fixtureRoot = mkdtempSync(join(tmpdir(), "agent-file-size-test-"));
process.on("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const fakeHome = join(fixtureRoot, "home");
mkdirSync(fakeHome, { recursive: true });
writeFileSync(join(fakeHome, ".gitconfig"), "");
process.env.HOME = fakeHome;
process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = join(fakeHome, ".gitconfig");
process.env.GIT_AUTHOR_NAME = "agent-file-size-test";
process.env.GIT_AUTHOR_EMAIL = "test@localhost";
process.env.GIT_COMMITTER_NAME = "agent-file-size-test";
process.env.GIT_COMMITTER_EMAIL = "test@localhost";

// ── fixture helpers: git init/add/commit ONLY ─────────────────────────────

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

let seq = 0;
function makeRepo(name = "repo") {
  const dir = join(fixtureRoot, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-b", "master");
  writeFileSync(join(dir, "base.txt"), "base\n");
  sh(dir, "add", "base.txt");
  sh(dir, "commit", "-m", "base");
  return dir;
}

function stage(repo, file, content) {
  const p = join(repo, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  sh(repo, "add", file);
}

function commit(repo, file, content) {
  stage(repo, file, content);
  sh(repo, "commit", "-m", `add ${file}`);
}

function violationPaths(check) {
  return check.violations.map((v) => v.path).sort();
}

const LIMIT = 20_000;
const BIG = 20_001;

// ── default test classification ───────────────────────────────────────────

test("test/spec directory components are skipped at root and nested levels", async () => {
  const repo = makeRepo("dirs");
  const paths = [
    "test/helpers.ts",
    "test/nested/deep.ts",
    "src/test/helpers.ts",
    "tests/unit.ts",
    "packages/foo/tests/unit.ts",
    "__tests__/unit.ts",
    "lib/__tests__/unit.ts",
    "spec/unit.ts",
    "src/spec/unit.ts",
    "specs/unit.ts",
    "app/specs/unit.ts",
  ];
  for (const p of paths) stage(repo, p, "x".repeat(BIG));

  const check = await checkStagedFileSize(repo);
  assert.equal(check.violations.length, 0, JSON.stringify(check.violations));
  assert.equal(check.checked, 0);
  assert.equal(check.skipped, paths.length);
});

test("conventional *.test.* and *.spec.* names are skipped at any depth", async () => {
  const repo = makeRepo("names");
  const paths = [
    "util.test.ts",
    "src/util.test.ts",
    "deep/nested/util.test.js",
    "util.spec.ts",
    "src/feature.spec.tsx",
    "a/b/c.spec.js",
  ];
  for (const p of paths) stage(repo, p, "x".repeat(BIG));

  const check = await checkStagedFileSize(repo);
  assert.equal(check.violations.length, 0, JSON.stringify(check.violations));
  assert.equal(check.checked, 0);
  assert.equal(check.skipped, paths.length);
});

test("language-idiomatic test names are skipped (Go, Python, C#)", async () => {
  const repo = makeRepo("lang");
  const paths = [
    "foo_test.go",
    "cmd/bar_test.go",
    "test_foo.py",
    "pkg/test_foo.py",
    "pkg/foo_test.py",
    "FooTest.cs",
    "Tests/BarTests.cs",
  ];
  for (const p of paths) stage(repo, p, "x".repeat(BIG));

  const check = await checkStagedFileSize(repo);
  assert.equal(check.violations.length, 0, JSON.stringify(check.violations));
  assert.equal(check.checked, 0);
  assert.equal(check.skipped, paths.length);
});

test("production names with test-like substrings still block; 20000-byte limit preserved", async () => {
  const repo = makeRepo("negative");
  stage(repo, "src/at-limit.ts", "x".repeat(LIMIT));
  const negative = [
    "src/contest.ts",
    "src/testimonial.ts",
    "src/latest.ts",
    "test.ts",
    "tests.ts",
    "spec.ts",
  ];
  for (const p of negative) stage(repo, p, "x".repeat(BIG));

  const check = await checkStagedFileSize(repo);
  assert.equal(check.maxBytes, LIMIT);
  assert.equal(check.bytesPerToken, 4);
  assert.deepEqual(violationPaths(check), [...negative].sort());
  assert.ok(!check.violations.some((v) => v.path === "src/at-limit.ts"));
  for (const v of check.violations) {
    assert.equal(v.stagedBytes, BIG, v.path);
    assert.equal(v.oldBytes, null, v.path);
  }
});

// ── mixed fixtures and staged-only accounting ─────────────────────────────

test("docs/text/tests are skipped while an oversized ordinary source still blocks", async () => {
  const repo = makeRepo("mixed");
  stage(repo, "docs/guide.md", "x".repeat(BIG));
  stage(repo, "notes.txt", "x".repeat(BIG));
  stage(repo, "test/big.test.ts", "x".repeat(BIG));
  stage(repo, "src/ordinary.ts", "x".repeat(BIG));

  const check = await checkStagedFileSize(repo);
  assert.equal(check.violations.length, 1, JSON.stringify(check.violations));
  assert.equal(check.violations[0].path, "src/ordinary.ts");
  assert.equal(check.violations[0].stagedBytes, BIG);
  assert.equal(check.checked, 1);
  assert.equal(check.skipped, 3);
});

test("only staged blobs are checked; an unstaged large source is not counted", async () => {
  const repo = makeRepo("staged-only");
  stage(repo, "src/staged.ts", "x".repeat(BIG));
  writeFileSync(join(repo, "src", "unstaged.ts"), "x".repeat(BIG));

  const check = await checkStagedFileSize(repo);
  assert.equal(check.violations.length, 1);
  assert.equal(check.violations[0].path, "src/staged.ts");
});

// ── configured modes still apply test classification ──────────────────────

test("configured growth/all modes still exempt tests and block ordinary sources", async () => {
  for (const mode of ["growth", "all"]) {
    const repo = makeRepo(`mode-${mode}`);
    commit(repo, "src/legacy.ts", "x".repeat(1000));
    commit(repo, "src/legacy.test.ts", "x".repeat(1000));
    stage(repo, ".agent-file-size.conf", `mode=${mode}\n`);
    stage(repo, "src/legacy.ts", "x".repeat(BIG));
    stage(repo, "src/legacy.test.ts", "x".repeat(BIG));

    const check = await checkStagedFileSize(repo);
    assert.equal(check.violations.length, 1, `${mode}: ${JSON.stringify(check.violations)}`);
    assert.equal(check.violations[0].path, "src/legacy.ts", mode);
    assert.equal(check.violations[0].oldBytes, 1000, mode);
  }
});
