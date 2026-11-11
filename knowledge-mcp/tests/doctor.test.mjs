/**
 * Doctor: the verdict rules (binaries, roots, qmd collections, overlaps,
 * taskVault), the config section (missing/malformed/unknown keys/legacy) and
 * the CLI surface (--doctor/--json/exit codes). Binary and manager lookups are
 * injected, qmd answers are stubbed with this machine's real output formats —
 * no test spawns qmd, brew or npm, and the qmd index is never updated.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectionName, parseCollectionList, parseCollectionShow } from "../dist/collections.js";
import { createDoctor } from "../dist/doctor.js";
import { loadRequirements, parseRequirements } from "../dist/requirements.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

// ── fixtures ──────────────────────────────────────────────────────────────

const REQUIREMENTS = [
  { provider: "rg", check: "rg", install: "brew install ripgrep", manager: "brew", required: true, note: "lexical floor of every search path" },
  { provider: "qmd", check: "qmd", install: "npm i -g @tobilu/qmd", manager: "npm", required: false, note: "BM25 index" },
  { provider: "git", check: "git", install: "install git with your package manager", required: false, note: "repo root detection" },
];

const FULL_PATH = { rg: "/usr/bin/rg", qmd: "/usr/bin/qmd", git: "/usr/bin/git", brew: "/opt/homebrew/bin/brew", npm: "/usr/bin/npm" };
const NO_REPO = () => ({ repoRoot: null, config: {}, configPath: null });

function makeBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "kmcp-doc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return realpathSync(dir);
}

function useConfig(t, dir, value) {
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, typeof value === "string" ? value : JSON.stringify(value));
  const prev = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = cfgPath;
  t.after(() => {
    if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev;
  });
  return cfgPath;
}

function makeNotes(dir, count, { obsidian = false, prefix = "note-" } = {}) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `${prefix}${i}.md`), `# note ${i}\n\nsame body\n`);
  if (obsidian) mkdirSync(join(dir, ".obsidian"));
  return dir;
}

/** `qmd collection list/show` answers in the exact shape this machine's qmd prints. */
function qmdList(cols) {
  if (cols.length === 0) return { code: 0, stdout: "Collections (0):\n", stderr: "" };
  const body = cols
    .map((c) => `${c.name} (qmd://${c.name}/)\n  Pattern:  **/*.md\n  Files:    ${c.files}\n  Updated:  ${c.updated}`)
    .join("\n\n");
  return { code: 0, stdout: `Collections (${cols.length}):\n\n${body}\n`, stderr: "" };
}

function qmdShow(name, path) {
  return { code: 0, stdout: `Collection: ${name}\n  Path:     ${path}\n  Pattern:  **/*.md\n  Include:  yes (default)\n`, stderr: "" };
}

function qmdRun({ list = qmdList([]), shows = {}, failShow = [] } = {}) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "qmd" && args[0] === "collection" && args[1] === "list") return list;
    if (cmd === "qmd" && args[0] === "collection" && args[1] === "show") {
      const name = args[2];
      if (failShow.includes(name)) return { code: 1, stdout: "", stderr: `Collection not found: ${name}` };
      return shows[name] ?? { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${cmd} ${args.join(" ")}` };
  };
  return { run, calls };
}

function makeDoctor({ run = qmdRun().run, pathMap = FULL_PATH, configPath } = {}) {
  return createDoctor({
    run,
    resolveOnPath: (cmd) => pathMap[cmd] ?? null,
    requirements: REQUIREMENTS,
    loadRepo: NO_REPO,
    ...(configPath !== undefined ? { configPath } : {}),
  });
}

// ── requirements table ────────────────────────────────────────────────────

test("requirements.json is the owner: providers, weights and install facts", () => {
  const file = loadRequirements();
  assert.deepEqual(file.binaries.map((b) => b.provider), ["rg", "qmd", "git"]);
  const rg = file.binaries.find((b) => b.provider === "rg");
  const qmd = file.binaries.find((b) => b.provider === "qmd");
  const git = file.binaries.find((b) => b.provider === "git");
  assert.equal(rg.required, true);
  assert.equal(qmd.manager, "npm");
  assert.equal(qmd.install, "npm i -g @tobilu/qmd");
  assert.equal(git.manager, undefined); // an install string that names no manager
  assert.ok(file.setup?.command.includes("--setup"));
});

test("a malformed requirements table fails loudly instead of being half-used", () => {
  assert.throws(() => parseRequirements({ binaries: [{ provider: "rg" }] }), /requirements.json is invalid/);
  assert.throws(() => parseRequirements({}), /requirements.json is invalid/);
});

// ── collection naming and qmd output parsing ──────────────────────────────

test("collectionName: source name for one root, source-label for several", () => {
  const one = { name: "work", roots: [{ label: "main", path: "/a", writable: true, qmd: null }] };
  const many = {
    name: "work",
    roots: [
      { label: "main", path: "/a", writable: true, qmd: null },
      { label: "shared", path: "/b", writable: true, qmd: null },
    ],
  };
  assert.equal(collectionName(one, one.roots[0]), "work");
  assert.equal(collectionName(many, many.roots[0]), "work-main");
  assert.equal(collectionName(many, many.roots[1]), "work-shared");
});

test("parseCollectionList accepts this machine's format and ages", () => {
  const parsed = parseCollectionList(
    "Collections (2):\n\nexample-vault (qmd://example-vault/)\n  Pattern:  **/*.md\n  Files:    1484\n  Updated:  39d ago\n\nother (qmd://other/)\n  Pattern:  **/*.md\n  Files:    7\n  Updated:  2m ago\n",
  );
  assert.deepEqual([...parsed.keys()], ["example-vault", "other"]);
  assert.equal(parsed.get("example-vault").files, 1484);
  assert.equal(parsed.get("example-vault").updatedMinutesAgo, 39 * 1440);
  assert.equal(parsed.get("other").updatedMinutesAgo, 2);
  assert.equal(parseCollectionList("Collections (0):\n").size, 0);
  assert.equal(parseCollectionList("total garbage\nfrom a future qmd\n"), null);
});

test("parseCollectionShow extracts the registered Path and nothing else", () => {
  const show = parseCollectionShow("Collection: example-vault\n  Path:     /opt/notes/example-vault\n  Pattern:  **/*.md\n");
  assert.equal(show, "/opt/notes/example-vault");
  assert.equal(parseCollectionShow("Collection: x\n"), null);
});

// ── binaries ──────────────────────────────────────────────────────────────

test("binaries: present carries the resolved path", async (t) => {
  const base = makeBase(t);
  useConfig(t, base, { vaults: { s: join(base, "v") } });
  makeNotes(join(base, "v"), 3);
  const report = await makeDoctor().report();
  const rg = report.binaries.find((b) => b.provider === "rg");
  assert.equal(rg.verdict, "present");
  assert.equal(rg.path, "/usr/bin/rg");
});

test("binaries: installable names the exact command when the manager is present", async (t) => {
  const base = makeBase(t);
  useConfig(t, base, { vaults: { s: join(base, "v") } });
  makeNotes(join(base, "v"), 3);
  // qmd gone from PATH, npm still there
  const report = await makeDoctor({ pathMap: { rg: "/usr/bin/rg", git: "/usr/bin/git", npm: "/usr/bin/npm" } }).report();
  const qmd = report.binaries.find((b) => b.provider === "qmd");
  assert.equal(qmd.verdict, "installable");
  assert.equal(qmd.detail, "install: npm i -g @tobilu/qmd");
  assert.equal(report.ok, true, "an optional installable binary is not a failure");
});

test("binaries: blocked when the manager itself is absent", async (t) => {
  const base = makeBase(t);
  useConfig(t, base, { vaults: { s: join(base, "v") } });
  makeNotes(join(base, "v"), 3);
  const report = await makeDoctor({ pathMap: { rg: "/usr/bin/rg", git: "/usr/bin/git" } }).report(); // no qmd, no npm, no brew
  const qmd = report.binaries.find((b) => b.provider === "qmd");
  assert.equal(qmd.verdict, "blocked");
  assert.equal(qmd.detail, "needs npm, which is not on PATH");
  assert.equal(report.binaries.find((b) => b.provider === "rg").verdict, "present");
});

test("binaries: builtin when an install string names no manager (git)", async (t) => {
  const base = makeBase(t);
  useConfig(t, base, { vaults: { s: join(base, "v") } });
  makeNotes(join(base, "v"), 3);
  const report = await makeDoctor({ pathMap: { rg: "/usr/bin/rg", qmd: "/usr/bin/qmd", npm: "/usr/bin/npm", brew: "/opt/bin/brew" } }).report();
  const git = report.binaries.find((b) => b.provider === "git");
  assert.equal(git.verdict, "builtin");
  assert.equal(git.detail, "install git with your package manager");
});

test("binaries: qmd disabled by config wins even when the binary is present", async (t) => {
  const base = makeBase(t);
  useConfig(t, base, { vaults: { s: { path: join(base, "v"), qmd: true } }, qmd: { enabled: false } });
  makeNotes(join(base, "v"), 3);
  const { run, calls } = qmdRun();
  const report = await makeDoctor({ run }).report();
  const qmd = report.binaries.find((b) => b.provider === "qmd");
  assert.equal(qmd.verdict, "disabled");
  assert.match(qmd.detail, /qmd\.enabled=false/);
  assert.equal(calls.length, 0, "no qmd process may be spawned while disabled");
  assert.equal(report.sources[0].roots[0].qmd.state, "disabled");
});

test("a missing required binary makes the whole report fail", async (t) => {
  const base = makeBase(t);
  useConfig(t, base, { vaults: { s: join(base, "v") } });
  makeNotes(join(base, "v"), 3);
  const report = await makeDoctor({ pathMap: { qmd: "/usr/bin/qmd", npm: "/usr/bin/npm", git: "/usr/bin/git" } }).report(); // rg gone, brew gone
  assert.equal(report.ok, false);
  assert.ok(report.problems >= 1);
});

// ── roots ─────────────────────────────────────────────────────────────────

test("an ok root reports notes, obsidian, writable and bytes", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 5, { obsidian: true });
  useConfig(t, base, { vaults: { s: v }, defaultVaults: ["s"] });
  const report = await makeDoctor().report();
  const root = report.sources[0].roots[0];
  assert.equal(root.state, "ok");
  assert.equal(root.notes, 5);
  assert.equal(root.obsidian, true);
  assert.equal(root.writable, true);
  assert.ok(root.bytes > 0);
  assert.equal(report.ok, true);
  assert.equal(report.problems, 0);
});

test("a missing root directory is a problem (the machine case)", async (t) => {
  const base = makeBase(t);
  useConfig(t, base, { vaults: { s: join(base, "no-such-dir") } });
  const report = await makeDoctor().report();
  assert.equal(report.sources[0].roots[0].state, "missing");
  assert.equal(report.ok, false);
  const text = makeDoctor().render(report);
  assert.match(text, /no-such-dir: missing - .*no-such-dir/);
});

test("a root that is a file is not a directory", async (t) => {
  const base = makeBase(t);
  writeFileSync(join(base, "afile"), "x");
  useConfig(t, base, { vaults: { s: join(base, "afile") } });
  const report = await makeDoctor().report();
  assert.equal(report.sources[0].roots[0].state, "not a directory");
  assert.equal(report.ok, false);
});

test("an unreadable root is a problem", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 2);
  chmodSync(v, 0o000);
  try {
    useConfig(t, base, { vaults: { s: v } });
    const report = await makeDoctor().report();
    assert.equal(report.sources[0].roots[0].state, "unreadable");
    assert.equal(report.ok, false);
  } finally {
    chmodSync(v, 0o755); // before makeBase's rmSync hook (after-hooks run FIFO)
  }
});

test("a not-writable root counts only when allowWrite is on", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 2);
  chmodSync(v, 0o555);
  try {
    useConfig(t, base, { vaults: { s: v }, allowWrite: true });
    const gated = await makeDoctor().report();
    assert.equal(gated.sources[0].roots[0].state, "not writable");
    assert.equal(gated.ok, false);

    useConfig(t, base, { vaults: { s: v }, allowWrite: false });
    const open = await makeDoctor().report();
    assert.equal(open.sources[0].roots[0].state, "not writable");
    assert.equal(open.ok, true, "write gate closed - the state is data, not a problem");
  } finally {
    chmodSync(v, 0o755); // before makeBase's rmSync hook (after-hooks run FIFO)
  }
});

// ── qmd verdicts ──────────────────────────────────────────────────────────

test("qmd ok: collection registered on the root, fresh, in sync", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 3);
  useConfig(t, base, { vaults: { s: v }, qmd: { enabled: true, updateTtlMinutes: 10 } });
  const { run, calls } = qmdRun({
    list: qmdList([{ name: "s", files: 3, updated: "2m ago" }]),
    shows: { s: qmdShow("s", v) },
  });
  const report = await makeDoctor({ run }).report();
  const qmd = report.sources[0].roots[0].qmd;
  assert.equal(qmd.state, "ok");
  assert.equal(qmd.collection, "s");
  assert.equal(qmd.files, 3);
  assert.equal(qmd.updatedDaysAgo, 0);
  assert.equal(qmd.indexPath, v);
  // one list for the report, one show per collection, never an update
  assert.deepEqual(calls.map((c) => c.args.join(" ")), ["collection list", "collection show s"]);
});

test("qmd missing: no collection with the expected name", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 3);
  useConfig(t, base, { vaults: { s: v } });
  const { run, calls } = qmdRun({ list: qmdList([{ name: "example-vault", files: 1484, updated: "39d ago" }]) });
  const report = await makeDoctor({ run }).report();
  assert.equal(report.sources[0].roots[0].qmd.state, "missing");
  assert.equal(calls.length, 1, "no show call for a collection that does not exist");
});

test("qmd stale path: the collection points somewhere else", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 3);
  useConfig(t, base, { vaults: { s: v } });
  const dead = "/opt/notes/example-vault";
  const { run } = qmdRun({
    list: qmdList([{ name: "s", files: 1484, updated: "39d ago" }]),
    shows: { s: qmdShow("s", dead) },
  });
  const report = await makeDoctor({ run }).report();
  const qmd = report.sources[0].roots[0].qmd;
  assert.equal(qmd.state, "stale path");
  assert.equal(qmd.indexPath, dead);
  assert.equal(qmd.files, 1484);
  assert.equal(qmd.updatedDaysAgo, 39);
  assert.match(qmd.detail, new RegExp(`collection points at ${dead}`));
});

test("qmd stale index: older than updateTtlMinutes * 3, message capped at days", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 3);
  useConfig(t, base, { vaults: { s: v }, qmd: { enabled: true, updateTtlMinutes: 10 } });
  const { run } = qmdRun({
    list: qmdList([{ name: "s", files: 3, updated: "39d ago" }]),
    shows: { s: qmdShow("s", v) },
  });
  const report = await makeDoctor({ run }).report();
  const qmd = report.sources[0].roots[0].qmd;
  assert.equal(qmd.state, "stale index");
  assert.equal(qmd.updatedDaysAgo, 39);
  assert.match(qmd.detail, /stale index: 39 days \(refresh after 30 min\)/);
});

test("qmd drifted: indexed files vs notes beyond max(5, 10%)", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 3);
  useConfig(t, base, { vaults: { s: v }, qmd: { enabled: true, updateTtlMinutes: 10 } });
  const { run } = qmdRun({
    list: qmdList([{ name: "s", files: 1484, updated: "2m ago" }]),
    shows: { s: qmdShow("s", v) },
  });
  const report = await makeDoctor({ run }).report();
  const qmd = report.sources[0].roots[0].qmd;
  assert.equal(qmd.state, "drifted");
  assert.match(qmd.detail, /drifted: 1484 indexed vs 3 notes/);
});

test("qmd collection names per root and a root can opt out", async (t) => {
  const base = makeBase(t);
  const main = makeNotes(join(base, "main"), 2);
  const shared = makeNotes(join(base, "shared"), 3);
  useConfig(t, base, {
    vaults: { s: { paths: [{ path: main, label: "main" }, { path: shared, label: "shared", qmd: false }] } },
    qmd: { enabled: true, updateTtlMinutes: 10 },
  });
  const { run, calls } = qmdRun({
    list: qmdList([
      { name: "s-main", files: 2, updated: "1m ago" },
      { name: "s-shared", files: 3, updated: "1m ago" },
    ]),
    shows: { "s-main": qmdShow("s-main", main) },
  });
  const report = await makeDoctor({ run }).report();
  const roots = report.sources[0].roots;
  assert.equal(roots[0].qmd.state, "ok");
  assert.equal(roots[0].qmd.collection, "s-main");
  assert.equal(roots[1].qmd.state, "disabled");
  assert.match(roots[1].qmd.detail, /qmd: false/);
  // exactly one list for the whole report; no show for the opted-out root
  assert.deepEqual(
    calls.map((c) => c.args.join(" ")),
    ["collection list", "collection show s-main"],
  );
});

test("qmd unknown: unparseable output surfaces the raw first line", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 3);
  useConfig(t, base, { vaults: { s: v } });
  const garbage = qmdRun({ list: { code: 0, stdout: "totally new format v9\nsecond line\n", stderr: "" } });
  const report = await makeDoctor({ run: garbage.run }).report();
  assert.equal(report.sources[0].roots[0].qmd.state, "unknown");
  assert.equal(report.sources[0].roots[0].qmd.detail, "totally new format v9");

  const noPath = qmdRun({ list: qmdList([{ name: "s", files: 3, updated: "1m ago" }]), shows: { s: { code: 0, stdout: "Collection: s\n", stderr: "" } } });
  const report2 = await makeDoctor({ run: noPath.run }).report();
  assert.equal(report2.sources[0].roots[0].qmd.state, "unknown");
  assert.match(report2.sources[0].roots[0].qmd.detail, /Collection: s/); // the raw first line
});

test("qmd is not inspected at all when the binary is absent", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 3);
  useConfig(t, base, { vaults: { s: v } });
  const { run, calls } = qmdRun();
  const report = await makeDoctor({ run, pathMap: { rg: "/usr/bin/rg", git: "/usr/bin/git", npm: "/usr/bin/npm" } }).report();
  assert.equal(calls.length, 0);
  assert.equal(report.sources[0].roots[0].qmd.state, "unknown");
  assert.match(report.sources[0].roots[0].qmd.detail, /qmd binary not available/);
  assert.equal(report.ok, true, "an optional binary missing is not a failure");
});

// ── overlaps ──────────────────────────────────────────────────────────────

test("nested roots are reported on the inner one, in both directions", async (t) => {
  const base = makeBase(t);
  // distinct note names: the outer set must not content-match the inner one
  const outer = makeNotes(join(base, "vault"), 4, { obsidian: true, prefix: "top-" });
  const inner = makeNotes(join(base, "vault", "knowledge"), 3, { obsidian: true });
  useConfig(t, base, { vaults: { s: { paths: [{ path: outer, label: "wrapper" }, { path: inner, label: "inner" }] } } });
  const report = await makeDoctor().report();
  const roots = report.sources[0].roots;
  assert.deepEqual(roots[0].overlaps, []);
  assert.deepEqual(roots[1].overlaps, [{ with: "s/wrapper", kind: "nested" }]);
});

test("nested roots across sources name the source when it has one root", async (t) => {
  const base = makeBase(t);
  const outer = makeNotes(join(base, "obsidian"), 4, { obsidian: true, prefix: "top-" });
  const inner = makeNotes(join(base, "obsidian", "knowledge"), 4, { obsidian: true });
  useConfig(t, base, { vaults: { wrapper: outer, knowledge: inner } });
  const report = await makeDoctor().report();
  assert.deepEqual(report.sources[1].roots[0].overlaps, [{ with: "wrapper", kind: "nested" }]);
});

test("a copy is reported on the smaller root with the shared count", async (t) => {
  const base = makeBase(t);
  const big = makeNotes(join(base, "big"), 30);
  const small = makeNotes(join(base, "small"), 20); // the same note-0..19 files, same sizes
  useConfig(t, base, { vaults: { big, small } });
  const report = await makeDoctor().report();
  assert.deepEqual(report.sources[0].roots[0].overlaps, []);
  assert.deepEqual(report.sources[1].roots[0].overlaps, [{ with: "big", kind: "copy", shared: 20, otherNotes: 30 }]);
  const text = makeDoctor().render(report);
  assert.match(text, /copy of big: 20\/30 notes/);
});

test("equal note counts do not claim a copy (which side is canonical is the user's call)", async (t) => {
  const base = makeBase(t);
  const a = makeNotes(join(base, "a"), 25);
  const b = makeNotes(join(base, "b"), 25);
  useConfig(t, base, { vaults: { a, b } });
  const report = await makeDoctor().report();
  assert.deepEqual(report.sources[0].roots[0].overlaps, []);
  assert.deepEqual(report.sources[1].roots[0].overlaps, []);
});

// ── config section ────────────────────────────────────────────────────────

test("a malformed config is reported with the parser message, never replaced by defaults", async (t) => {
  const base = makeBase(t);
  useConfig(t, base, "{ not json");
  const report = await makeDoctor().report();
  assert.equal(report.config.state, "malformed");
  assert.ok(report.config.error.length > 0);
  assert.equal(report.ok, false);
  assert.match(makeDoctor().render(report), /malformed: /);
});

test("a missing config names the setup command", async (t) => {
  const base = makeBase(t);
  const cfgPath = join(base, "absent.json");
  const prev = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = cfgPath;
  t.after(() => {
    if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev;
  });
  const report = await makeDoctor().report();
  assert.equal(report.config.state, "missing");
  assert.equal(report.ok, false);
  assert.match(makeDoctor().render(report), /create one: node dist\/cli\.js --setup/);
});

test("unknown keys are enumerated and legacy defaultVault flagged", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 2);
  useConfig(t, base, { vaults: { s: v }, defaultVault: "s", $comment: "user note", future: { a: 1 } });
  const report = await makeDoctor().report();
  assert.deepEqual(report.config.unknownKeys, ["$comment", "future"]);
  assert.equal(report.config.legacyDefaultVault, true);
  assert.equal(report.ok, true);
  assert.match(makeDoctor().render(report), /unknown keys: \$comment, future/);
});

// ── taskVault ─────────────────────────────────────────────────────────────

test("taskRoot resolving in a non-write root is a detail, not a failure", async (t) => {
  const base = makeBase(t);
  const main = makeNotes(join(base, "main"), 2);
  const shared = makeNotes(join(base, "shared"), 2);
  mkdirSync(join(shared, "tasks"));
  useConfig(t, base, {
    vaults: { s: { paths: [{ path: main, label: "main" }, { path: shared, label: "shared" }] } },
    taskVault: "s",
    defaultTaskRoot: "tasks",
  });
  const report = await makeDoctor().report();
  const taskRoot = report.sources[0].taskRoot;
  assert.equal(taskRoot.rel, "tasks");
  assert.equal(taskRoot.root, "main");
  assert.deepEqual(taskRoot.elsewhere, ["shared"]);
  assert.equal(taskRoot.detail, 'taskRoot "tasks" resolves in root "shared", write root is "main"');
  assert.equal(report.ok, true, "the write root can still create the workspace");
  assert.match(makeDoctor().render(report), /! taskRoot "tasks" resolves in root "shared", write root is "main"/);
});

test("a taskVault with no writable root is a problem", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 2);
  useConfig(t, base, { vaults: { s: { path: v, writable: false } }, taskVault: "s", defaultTaskRoot: "tasks" });
  const report = await makeDoctor().report();
  assert.match(report.sources[0].problem, /no writable root in source "s"/);
  assert.equal(report.ok, false);
});

// ── repo section ──────────────────────────────────────────────────────────

test("the repo section: ok / malformed / unknown keys, read from the real file", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 2);
  useConfig(t, base, { vaults: { s: v }, defaultVaults: ["s"], knowledgeRoot: "Knowledge" });

  const repo = join(base, "repo");
  mkdirSync(repo);
  const repoCtxOf = () => ({ repoRoot: repo, config: {}, configPath: join(repo, ".knowledge-mcp.json") });

  writeFileSync(join(repo, ".knowledge-mcp.json"), JSON.stringify({ vault: "s", taskRoot: "tasks" }));
  const ok = await createDoctor({ run: qmdRun().run, resolveOnPath: () => "/bin/x", requirements: REQUIREMENTS, loadRepo: repoCtxOf }).report();
  assert.equal(ok.repo.state, "ok");
  assert.equal(ok.ok, true);

  writeFileSync(join(repo, ".knowledge-mcp.json"), JSON.stringify({ vault: "s", rogue: 1 }));
  const rogue = await createDoctor({ run: qmdRun().run, resolveOnPath: () => "/bin/x", requirements: REQUIREMENTS, loadRepo: repoCtxOf }).report();
  assert.equal(rogue.repo.state, "ok");
  assert.match(rogue.repo.errors[0], /unknown key "rogue"/);

  writeFileSync(join(repo, ".knowledge-mcp.json"), "{ nope");
  const malformed = await createDoctor({ run: qmdRun().run, resolveOnPath: () => "/bin/x", requirements: REQUIREMENTS, loadRepo: repoCtxOf }).report();
  assert.equal(malformed.repo.state, "malformed");
  assert.equal(malformed.ok, false, "a malformed repo config is a problem, not a silent ignore");
});

// ── rendering and the CLI ─────────────────────────────────────────────────

test("render is plain ASCII lines and renderJson parses", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 2, { obsidian: true });
  useConfig(t, base, { vaults: { s: v }, defaultVaults: ["s"], taskVault: "s", defaultTaskRoot: "tasks" });
  const doctor = makeDoctor();
  const report = await doctor.report();
  for (const line of doctor.render(report).split("\n")) {
    assert.ok(/^[\x20-\x7E]*$/.test(line), `non-ASCII line: ${JSON.stringify(line)}`);
  }
  const parsed = JSON.parse(doctor.renderJson(report));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sources[0].name, "s");
});

function runCli(t, args, { env = {}, cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? import.meta.dirname,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function stubBinDir(t, base) {
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rg"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "rg"), 0o755);
  return bin;
}

test("cli --doctor: exit 1 on a missing config, exit 0 on a clean machine", (t) => {
  const base = makeBase(t);
  const bin = stubBinDir(t, base);
  const bad = runCli(t, ["--doctor"], { env: { KNOWLEDGE_MCP_CONFIG: join(base, "absent.json"), PATH: bin }, cwd: base });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /missing \(no config file\)/);

  const v = makeNotes(join(base, "v"), 3);
  writeFileSync(join(base, "ok.json"), JSON.stringify({ vaults: { s: v }, defaultVaults: ["s"] }));
  const good = runCli(t, ["--doctor"], {
    env: { KNOWLEDGE_MCP_CONFIG: join(base, "ok.json"), PATH: bin },
    cwd: base,
  });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /ok: no problems/);
});

test("cli --doctor --json prints a parseable report", (t) => {
  const base = makeBase(t);
  const bin = stubBinDir(t, base);
  const result = runCli(t, ["--doctor", "--json"], {
    env: { KNOWLEDGE_MCP_CONFIG: join(base, "absent.json"), PATH: bin },
    cwd: base,
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.config.state, "missing");
  assert.ok(Array.isArray(parsed.binaries));
});

test("cli: unknown flags print usage on stderr and exit 2; --help exits 0", (t) => {
  const base = makeBase(t);
  const bad = runCli(t, ["--doctor", "--wat"], { cwd: base });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument "--wat"/);
  assert.match(bad.stderr, /Usage: node dist\/cli\.js/);
  assert.equal(bad.stdout, "");

  const help = runCli(t, ["--help"], { cwd: base });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--doctor/);
  assert.match(help.stdout, /--setup/);

  const missingValue = runCli(t, ["--min-notes"], { cwd: base });
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /--min-notes needs a value/);
});

test("qmd stale path: the index kept an older collection name after the vault moved", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "example-vault"), 3);
  useConfig(t, base, { vaults: { work: v }, defaultVaults: ["work"] });
  const dead = "/opt/notes/example-vault";
  const { run } = qmdRun({
    list: qmdList([{ name: "example-vault", files: 1484, updated: "39d ago" }]),
    shows: { "example-vault": qmdShow("example-vault", dead) },
  });
  const report = await makeDoctor({ run }).report();
  const qmd = report.sources[0].roots[0].qmd;
  assert.equal(qmd.state, "stale path");
  assert.equal(qmd.collection, "work");
  assert.equal(qmd.indexPath, dead);
  assert.match(qmd.detail ?? "", /qmd collection remove example-vault/);
});

test("qmd missing names the command that creates the collection", async (t) => {
  const base = makeBase(t);
  const v = makeNotes(join(base, "v"), 3);
  useConfig(t, base, { vaults: { s: v } });
  const { run } = qmdRun({ list: qmdList([]) });
  const report = await makeDoctor({ run }).report();
  const qmd = report.sources[0].roots[0].qmd;
  assert.equal(qmd.state, "missing");
  assert.match(qmd.detail ?? "", /qmd collection add s && qmd update/);
});
