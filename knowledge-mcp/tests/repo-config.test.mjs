/**
 * Repo layer: `.knowledge-mcp.json` loading with the key whitelist, git-root
 * detection through argv spawnSync (a repo directory containing spaces and
 * `$(…)` must be a literal argument, never a shell command), task-root
 * precedence and the repo name.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { findRepoRoot, loadRepoContext, repoName, resolveTaskRoot } from "../dist/repo-config.js";

const gitOk = spawnSync("git", ["--version"], { timeout: 5000 }).status === 0;

function makeBase(t) {
  const base = mkdtempSync(join(tmpdir(), "kmcp-repo-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

test("git root detection survives spaces and $(…) in the repo path (no shell)", { skip: !gitOk }, (t) => {
  const base = makeBase(t);
  // with a shell, the $(…) would run `touch` in the process cwd; with argv spawn it is a literal
  const canary = join(process.cwd(), "kmcp-pwned-canary.txt");
  const repoDir = join(base, "my repo $(touch kmcp-pwned-canary.txt)");
  mkdirSync(repoDir);
  t.after(() => rmSync(canary, { force: true }));
  const r = spawnSync("git", ["init", repoDir], { timeout: 10_000 });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  const nested = join(repoDir, "a dir", "b");
  mkdirSync(nested, { recursive: true });

  const root = findRepoRoot(nested);
  assert.ok(root !== null);
  // git prints real paths (/private/var/... on macOS), so compare realpaths
  assert.equal(realpathSync(root), realpathSync(repoDir));
  assert.ok(root.includes("$(touch"), "the $(…) segment stays a literal path part");
  assert.equal(existsSync(canary), false, "no shell may execute the $(…) segment");
});

test("a plain .git directory is enough when git does not recognize the tree", (t) => {
  const base = makeBase(t);
  const repo = join(base, "fake");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "deep", "sub"), { recursive: true });
  assert.equal(findRepoRoot(join(repo, "deep", "sub")), resolve(repo));
});

test("outside any repo the walk ends with null", (t) => {
  const base = makeBase(t);
  assert.equal(findRepoRoot(base), null);
  const ctx = loadRepoContext(base);
  assert.equal(ctx.repoRoot, null);
  assert.equal(ctx.configPath, null);
  assert.deepEqual(ctx.config, {});
});

test("the repo whitelist keeps only vault/taskRoot/knowledgeRoot/repo name+path", (t) => {
  const base = makeBase(t);
  const repo = join(base, "wl");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const configPath = join(repo, ".knowledge-mcp.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vault: "personal",
      taskRoot: "search/tasks",
      knowledgeRoot: "Knowledge",
      repo: { name: "service-a", path: "/srv/work/service-a" },
      // repository-controlled keys that must NOT pass the whitelist:
      allowWrite: false,
      qmd: { enabled: false },
      defaultVault: "evil",
      vaults: { evil: "/etc" },
    }),
  );
  const ctx = loadRepoContext(repo);
  assert.equal(ctx.repoRoot, resolve(repo));
  assert.equal(ctx.configPath, configPath);
  assert.deepEqual(ctx.config, {
    vault: "personal",
    taskRoot: "search/tasks",
    knowledgeRoot: "Knowledge",
    repo: { name: "service-a", path: "/srv/work/service-a" },
  });
});

test("a malformed repo config is not fatal; the repo root is still found", (t) => {
  const base = makeBase(t);
  const repo = join(base, "broken");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".knowledge-mcp.json"), "{ nope");
  const ctx = loadRepoContext(repo);
  assert.equal(ctx.repoRoot, resolve(repo));
  assert.deepEqual(ctx.config, {});
});

test("resolveTaskRoot: explicit > repo config > central default; leading slashes stripped", (t) => {
  const ctx = { repoRoot: "/r", config: { taskRoot: "repo/tasks" }, configPath: "/r/.knowledge-mcp.json" };
  assert.equal(resolveTaskRoot("explicit", ctx, "central"), "explicit");
  assert.equal(resolveTaskRoot(undefined, ctx, "central"), "repo/tasks");
  assert.equal(resolveTaskRoot(undefined, ctx, undefined), "repo/tasks");
  assert.equal(resolveTaskRoot(undefined, { ...ctx, config: {} }, "central"), "central");
  assert.equal(resolveTaskRoot("/leading/", ctx, undefined), "leading/");
  assert.throws(
    () => resolveTaskRoot(undefined, { repoRoot: null, config: {}, configPath: null }, undefined),
    /no task root: pass taskRoot=<vault-relative dir with <TICKET>\/ workspaces>, or add \{"taskRoot": "search\/tasks"\} to \.knowledge-mcp\.json in the repo root/,
  );
});

test("repoName: explicit > repo config > repo directory basename", () => {
  const ctx = { repoRoot: "/srv/work/service-a", config: { repo: { name: "cfg-name" } }, configPath: null };
  assert.equal(repoName(ctx, "explicit"), "explicit");
  assert.equal(repoName(ctx), "cfg-name");
  assert.equal(repoName({ repoRoot: "/srv/work/service-a", config: {}, configPath: null }), "service-a");
  assert.equal(repoName({ repoRoot: null, config: {}, configPath: null }), undefined);
});
