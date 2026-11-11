/**
 * The nine task-protocol compatibility tests, ported from the source server's
 * tests/task-compat.test.mjs (agent-toolkit knowledge-mcp). They pin the
 * `numados-task-*` behaviour this repository's tasks live on: identity
 * fields, multi-repo projection, legacy indexes, event/lifecycle
 * independence, routing, the repo-config whitelist, task-root selection,
 * the repo knowledge map and unparsable-index refusal.
 *
 * Differences from the source file are mechanical only: handlers take
 * (args, ctx) and config access goes through the ported shapes. The one red
 * assertion of the source ("longest project prefix wins" relying on the
 * ambient cwd) passes the fixture directory explicitly, testing the intended
 * rule.
 */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { loadRepoContext } from "../dist/repo-config.js";
import { parseNote, renderNote } from "../dist/md.js";
import { resolveSource } from "../dist/sources.js";
import { createContext } from "../dist/context.js";
import { knowledgeRead } from "../dist/tools/read.js";
import { knowledgeRepo } from "../dist/tools/repo.js";
import { knowledgeTask } from "../dist/tools/task.js";

const output = (result) => result.content[0].text;

function fixture(t, repoConfig = {}, central = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kmcp-compat-"));
  const repo = join(dir, "checkout");
  const vaults = { a: join(dir, "vault-a"), b: join(dir, "vault-b") };
  for (const path of [repo, ...Object.values(vaults)]) mkdirSync(path, { recursive: true });
  const git = spawnSync("git", ["-c", "init.templateDir=", "init", "--quiet", repo], { stdio: "ignore", timeout: 10_000 });
  assert.equal(git.status, 0, `git init failed: ${git.stderr}`);
  const repoConfigPath = join(repo, ".knowledge-mcp.json");
  writeFileSync(repoConfigPath, JSON.stringify(repoConfig));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    vaults, defaultVault: "b", defaultTaskRoot: "tasks", allowWrite: true,
    qmd: { enabled: false }, ...central,
  }));
  const cwd = process.cwd();
  const previousConfig = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = configPath;
  process.chdir(repo);
  t.after(() => {
    process.chdir(cwd);
    if (previousConfig === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = previousConfig;
  });
  const indexPath = (ticket, vault = "b", root = "tasks") => join(vaults[vault], root, ticket, "_task_index.md");
  const writeIndex = (ticket, frontmatter, body, vault = "b") => {
    const path = indexPath(ticket, vault);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, renderNote({ frontmatterRaw: null, frontmatter, body }));
    return path;
  };
  return { dir, repo, vaults, configPath, repoConfigPath, indexPath, writeIndex };
}

async function task(args) {
  const c = createContext();
  const result = await knowledgeTask(args, c.forTask(args));
  assert.notEqual(result.isError, true, output(result));
  return result;
}

const canonicalBody = "Current state: Verified facts remain here.\nNext: review\nBlocker: none\n\n[[research]]\n";

test("canonical init keeps multi-repo discovery data and never writes event outcomes to lifecycle", async (t) => {
  const f = fixture(t, { repo: { name: "inferred-repo" } });
  await task({ action: "init", ticket: "NEW", title: "New", status: "ready", repos: ["/work/first", "second"] });
  assert.equal(existsSync(f.indexPath("NEW")), false, "preview must not create a workspace");
  await task({ action: "init", ticket: "NEW", title: "New", status: "ready", repos: ["/work/first", "second"], confirm: true });
  const note = parseNote(readFileSync(f.indexPath("NEW"), "utf8"));
  assert.deepEqual(note.frontmatter.repos, [{ name: "first", path: "/work/first" }, { name: "second" }]);
  assert.equal(note.frontmatter.task_id, "NEW");
  assert.equal(note.frontmatter.ticket, undefined);
  assert.equal(note.frontmatter.repository, "first");
  assert.equal(note.frontmatter.current_phase, "none");
  assert.equal(note.frontmatter.status, "brainstorm");
  assert.equal(note.body, "Current state: Workspace initialized.\nNext: —\nBlocker: none\n");
  await task({ action: "init", ticket: "INFER", title: "Inferred repo", taskStatus: "planning", confirm: true });
  const inferred = parseNote(readFileSync(f.indexPath("INFER"), "utf8"));
  assert.equal(inferred.frontmatter.repository, "inferred-repo");
  assert.deepEqual(inferred.frontmatter.repos, [{ name: "inferred-repo" }]);
  assert.equal(inferred.frontmatter.status, "planning");
});

test("canonical projection updates Next/Blocker literally and preserves facts, metadata and identity", async (t) => {
  const f = fixture(t);
  const path = f.writeIndex("LOOKUP", {
    format: "numados-task-index-v1", task_id: "CANONICAL-ID", ticket: "OLD-ID",
    title: "Original", status: "implementing", repository: "first", current_phase: "p1", custom: "keep",
  }, canonicalBody);
  const previous = readFileSync(path, "utf8");
  const args = { action: "update", ticket: "LOOKUP", next: "ship $1 $&", blocker: "CI $`", taskStatus: "reviewing", phase: "p2", repos: ["second", "third"] };
  await task(args);
  assert.equal(readFileSync(path, "utf8"), previous, "preview must not mutate index");
  await task({ ...args, confirm: true });
  const note = parseNote(readFileSync(path, "utf8"));
  assert.equal(note.frontmatter.custom, "keep");
  assert.equal(note.frontmatter.task_id, "CANONICAL-ID");
  assert.equal(note.frontmatter.ticket, "OLD-ID");
  assert.equal(note.frontmatter.status, "reviewing");
  assert.equal(note.frontmatter.repository, "second");
  assert.deepEqual(note.frontmatter.repos, [{ name: "second" }, { name: "third" }]);
  assert.equal(note.frontmatter.current_phase, "p2");
  assert.equal(note.body, canonicalBody.replace("Next: review", () => "Next: ship $1 $&").replace("Blocker: none", () => "Blocker: CI $`"));
  const status = output(await task({ ticket: "LOOKUP" }));
  assert.match(status, /task_id: CANONICAL-ID/);
  assert.doesNotMatch(status, /task_id: OLD-ID/);
  await task({ action: "iteration", ticket: "LOOKUP", stage: "review", confirm: true });
  const event = parseNote(readFileSync(join(path, "../iterations/0001-review.md"), "utf8"));
  assert.equal(event.frontmatter.task_id, "CANONICAL-ID");
});

test("legacy ticket/repos/bullet indexes remain readable and updates preserve unrelated data and artifacts", async (t) => {
  const f = fixture(t);
  const path = f.writeIndex("LEGACY", {
    format: "numados-task-index-v1", ticket: "LEGACY-ID", title: "Old task", status: "research",
    repos: [{ name: "old-repo", path: "/work/old-repo" }], custom: { owner: "retain" },
  }, "# Old task\n\n## Current state\n\n- status: research\n- next: old\n- blocker: —\n\nUnrelated legacy prose.\n");
  const workspace = join(path, "..");
  mkdirSync(join(workspace, "iterations"));
  const immutable = {
    "research.md": "Research must survive verbatim.\n",
    "plan.md": "Approved plan must survive verbatim.\n",
    "iterations/0001-brainstorm.md": "---\nstatus: ready\n---\nHistorical event.\n",
  };
  for (const [name, raw] of Object.entries(immutable)) writeFileSync(join(workspace, name), raw);
  for (const status of ["active", "ready"]) {
    await task({ action: "update", ticket: "LEGACY", status, next: "new", blocker: "CI", confirm: true });
  }
  const note = parseNote(readFileSync(path, "utf8"));
  assert.equal(note.frontmatter.status, "research", "legacy statuses survive projection-only updates");
  assert.equal(note.frontmatter.ticket, "LEGACY-ID");
  assert.equal(note.frontmatter.task_id, undefined, "do not migrate identity fields");
  assert.equal(note.frontmatter.repository, undefined);
  assert.deepEqual(note.frontmatter.repos, [{ name: "old-repo", path: "/work/old-repo" }]);
  assert.deepEqual(note.frontmatter.custom, { owner: "retain" });
  assert.match(note.body, /^- status: research$/m);
  assert.match(note.body, /^- next: new$/m);
  assert.match(note.body, /^- blocker: CI$/m);
  assert.match(note.body, /Unrelated legacy prose/);
  assert.match(output(await task({ ticket: "LEGACY" })), /task_id: LEGACY-ID/);
  await task({ action: "iteration", ticket: "LEGACY", stage: "implementation", phase: "p1", status: "ready", confirm: true });
  const event = parseNote(readFileSync(join(workspace, "iterations/0002-implementation-p1.md"), "utf8"));
  assert.equal(event.frontmatter.task_id, "LEGACY-ID");
  assert.equal(event.frontmatter.status, "ready");
  assert.equal(parseNote(readFileSync(path, "utf8")).frontmatter.status, "implementing");
  for (const [name, raw] of Object.entries(immutable)) assert.equal(readFileSync(join(workspace, name), "utf8"), raw);
});

test("event outcome and lifecycle are independent, with stage inference and explicit override", async (t) => {
  const f = fixture(t);
  await task({ action: "init", ticket: "FLOW", title: "Flow", confirm: true });
  const cases = [
    { stage: "brainstorm", status: "ready", expected: "brainstorm" },
    { stage: "planning", status: "ready", expected: "planning" },
    { stage: "gap-drill", status: "active", expected: "brainstorm" },
    { stage: "implementation", phase: "p1", expected: "implementing" },
    { stage: "review", status: "ready", expected: "reviewing" },
    { stage: "implementation", status: "blocked", expected: "blocked" },
    { stage: "review", status: "done", expected: "done" },
    { stage: "review", status: "done", taskStatus: "implementing", expected: "implementing" },
  ];
  for (const [i, { expected, ...args }] of cases.entries()) {
    await task({ action: "iteration", ticket: "FLOW", ...args, confirm: true });
    const index = parseNote(readFileSync(f.indexPath("FLOW"), "utf8")).frontmatter;
    assert.equal(index.status, expected);
    assert.equal(index.current_phase, args.phase ?? "none");
    const filename = `${String(i + 1).padStart(4, "0")}-${args.stage}${args.phase ? `-${args.phase}` : ""}.md`;
    const event = parseNote(readFileSync(join(f.indexPath("FLOW"), "../iterations", filename), "utf8")).frontmatter;
    assert.equal(event.status, args.status ?? "active");
  }
  await task({ action: "update", ticket: "FLOW", status: "ready", confirm: true });
  assert.equal(parseNote(readFileSync(f.indexPath("FLOW"), "utf8")).frontmatter.status, "implementing");
  await task({ action: "update", ticket: "FLOW", status: "blocked", confirm: true });
  assert.equal(parseNote(readFileSync(f.indexPath("FLOW"), "utf8")).frontmatter.status, "blocked");
});

test("two-vault routing honors explicit > repo > longest project prefix > default", async (t) => {
  const f = fixture(t, { vault: "a", taskRoot: "repo-tasks" });
  writeFileSync(f.configPath, JSON.stringify({
    vaults: f.vaults, defaultVault: "b", defaultTaskRoot: "central-tasks",
    projects: { [f.dir]: "b", [f.repo]: "a" }, qmd: { enabled: false },
  }));
  await task({ action: "init", ticket: "ROUTED", title: "Repo", confirm: true });
  assert.equal(existsSync(f.indexPath("ROUTED", "a", "repo-tasks")), true);
  assert.equal(existsSync(f.indexPath("ROUTED", "b", "repo-tasks")), false);
  await task({ action: "init", ticket: "ROUTED", title: "Explicit", vault: "b", confirm: true });
  const read = async (vault) => {
    const args = { path: "repo-tasks/ROUTED/_task_index.md", part: "meta", ...(vault ? { vault } : {}) };
    return output(await knowledgeRead(args, createContext().forCall(args)));
  };
  assert.match(await read(), /title: Repo/);
  assert.match(await read("b"), /title: Explicit/);
  const load = loadConfig();
  const withProjects = (projects, startDir, vault) =>
    resolveSource({ ...load, config: { ...load.config, projects } }, vault, startDir);
  assert.equal(withProjects({ [f.repo]: "b" }, f.repo).name, "a", "repo beats project map");
  writeFileSync(f.repoConfigPath, "{}");
  // the source test relied on the ambient cwd here; the port passes the
  // fixture directories explicitly so it tests the prefix rule itself:
  // both f.dir and f.repo match, the longer one wins
  assert.equal(withProjects(load.config.projects, f.repo).name, "a", "longest project prefix wins");
  assert.equal(withProjects(load.config.projects, f.dir).name, "b");
  assert.equal(withProjects(load.config.projects, `${f.dir}-sibling`).name, "b", "prefix matches require directory boundary");
  assert.equal(withProjects({ [`${f.dir}-sib`]: "a" }, `${f.dir}-sibling`).name, "b");
  writeFileSync(f.repoConfigPath, JSON.stringify({ vault: "unknown" }));
  assert.throws(() => withProjects(load.config.projects, f.repo), /unknown vault/);
  assert.equal(withProjects(load.config.projects, f.repo, "b").name, "b");
});

test("repo config is whitelisted and cannot replace central vault endpoints, write gates or defaults", async (t) => {
  const f = fixture(t, {
    vault: "a", taskRoot: "repo-tasks", knowledgeRoot: "RepoKnowledge", repo: { name: "local", path: "relative", injected: true },
    vaults: { a: "/untrusted" }, defaultVault: "a", projects: { "/": "a" }, allowWrite: true,
    defaultTaskRoot: "injected", qmd: { enabled: true },
  }, { allowWrite: false, defaultTaskRoot: null });
  const cfg = loadConfig().config;
  assert.deepEqual(
    cfg.sources.map((s) => ({ name: s.name, paths: s.roots.map((r) => r.path) })),
    [
      { name: "a", paths: [realpathSync(f.vaults.a)] },
      { name: "b", paths: [realpathSync(f.vaults.b)] },
    ],
  );
  assert.equal(cfg.defaultVault, "b");
  assert.deepEqual(cfg.projects, {});
  assert.equal(cfg.allowWrite, false);
  assert.equal(cfg.defaultTaskRoot, null);
  assert.equal(cfg.qmd.enabled, false);
  assert.deepEqual(loadRepoContext(f.repo).config, {
    vault: "a", taskRoot: "repo-tasks", knowledgeRoot: "RepoKnowledge", repo: { name: "local", path: "relative" },
  });
  const args = { action: "init", ticket: "DENIED", title: "Denied", confirm: true };
  const denied = await knowledgeTask(args, createContext().forTask(args));
  assert.equal(denied.isError, true);
  assert.match(output(denied), /writes disabled/);
  assert.equal(existsSync(f.indexPath("DENIED", "a", "repo-tasks")), false);
  writeFileSync(f.repoConfigPath, JSON.stringify({ vault: 7, taskRoot: [], knowledgeRoot: {}, repo: { name: 3, path: false } }));
  assert.deepEqual(loadRepoContext(f.repo).config, { repo: {} });
  writeFileSync(f.repoConfigPath, "[]");
  assert.deepEqual(loadRepoContext(f.repo).config, {});
});

test("missing task root requires user selection; repository cannot inject defaultTaskRoot", async (t) => {
  const f = fixture(t, { defaultTaskRoot: "injected" }, { defaultTaskRoot: null });
  const args = { action: "init", ticket: "NO-ROOT", title: "No root", confirm: true };
  await assert.rejects(async () => knowledgeTask(args, createContext().forTask(args)), /no task root/);
  assert.equal(existsSync(join(f.vaults.b, "injected")), false);
  await task({ action: "init", ticket: "SELECTED", title: "Selected", taskRoot: "chosen", confirm: true });
  assert.equal(existsSync(f.indexPath("SELECTED", "b", "chosen")), true);
});

test("repo map discovers canonical repository or legacy repos, preferring canonical task identity", async (t) => {
  const f = fixture(t);
  f.writeIndex("CANON", { task_id: "CANONICAL-ID", ticket: "IGNORE-OLD-ID", repository: "domain/service-a", title: "Canonical", status: "planning" }, canonicalBody);
  f.writeIndex("LEGACY", { ticket: "LEGACY-ID", repos: [{ name: "service-a" }], title: "Legacy", status: "research" }, "old");
  f.writeIndex("MULTI", { task_id: "MULTI-ID", repository: "other", repos: [{ name: "other" }, { name: "service-a" }], title: "Multi", status: "implementing" }, canonicalBody);
  f.writeIndex("STRING", { ticket: "STRING-ID", repos: ["service-a"], title: "String list", status: "active" }, "old");
  f.writeIndex("FALSE-POSITIVE", { task_id: "EXCLUDE-ID", repository: "service-a-extra", title: "Not related", status: "brainstorm" }, "Mention service-a only in prose.\nname: service-a\n");
  const result = output(await knowledgeRepo({ repo: "service-a" }, createContext().forCall({})));
  assert.match(result, /task workspaces \(4\)/);
  for (const id of ["CANONICAL-ID", "LEGACY-ID", "MULTI-ID", "STRING-ID"]) assert.ok(result.includes(id), result);
  assert.doesNotMatch(result, /IGNORE-OLD-ID|EXCLUDE-ID/);
});

test("unparseable legacy indexes are never overwritten by update or iteration", async (t) => {
  const f = fixture(t);
  const path = f.writeIndex("RAW", {}, "");
  const raw = "---\nnot valid yaml\n---\nKeep raw legacy content.\n";
  writeFileSync(path, raw);
  for (const action of ["update", "iteration"]) {
    const args = { action, ticket: "RAW", stage: "planning", next: "plan", confirm: true };
    const result = await knowledgeTask(args, createContext().forTask(args));
    assert.equal(result.isError, true);
    assert.match(output(result), /unparsable/);
    assert.equal(readFileSync(path, "utf8"), raw);
  }
  assert.equal(existsSync(join(path, "../iterations")), false);
});
