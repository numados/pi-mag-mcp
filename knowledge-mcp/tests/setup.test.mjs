/**
 * Setup: preview writes nothing, --confirm writes with a backup and preserves
 * keys setup does not own, --force replaces a malformed file, a second run is
 * idempotent, --group builds a multi-root source with deduplicated labels,
 * --qmd prints without --confirm and executes per root (failures isolated),
 * and .knowledge-mcp.json / the mcp registration are never written. The
 * runner is a recording stub — no test spawns qmd.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSetup } from "../dist/setup.js";
import { parseArgs } from "../dist/cli.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

function makeBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "kmcp-set-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return realpathSync(dir);
}

const discovery = (candidates) => ({ scan: async () => candidates });

const cand = (path, extra = {}) => ({
  path: realpathSync(path),
  name: path.split("/").pop(),
  notes: 25,
  obsidian: false,
  newestMtimeDaysAgo: 0,
  bytes: 1000,
  registeredAs: null,
  ...extra,
});

function makeSetup(overrides = {}) {
  return createSetup({
    discovery: discovery([]),
    confirm: false,
    force: false,
    qmd: false,
    json: false,
    ...overrides,
  });
}

function recordingRun(handler = () => ({ code: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve(handler(cmd, args));
  };
  return { run, calls };
}

function backups(dir) {
  return readdirSync(dir).filter((f) => /\.bak\.\d{8}-\d{6}$/.test(f));
}

// ── preview / confirm ─────────────────────────────────────────────────────

test("plan() and apply() without --confirm write nothing anywhere", async (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(vault);
  const setup = makeSetup({ discovery: discovery([cand(vault)]), configPath: join(base, "config.json") });

  const plan = await setup.plan();
  assert.equal(existsSync(join(base, "config.json")), false);
  assert.deepEqual(plan.commands.flat().filter((x) => x === "qmd").length > 0, true, "commands are still proposed");

  const result = await setup.apply(plan);
  assert.equal(result.written, false);
  assert.equal(existsSync(join(base, "config.json")), false);
  assert.match(result.notes.join("\n"), /preview only/);
});

test("apply() with --confirm: backup, mode 600, unknown keys and other settings preserved", async (t) => {
  const base = makeBase(t);
  const existing = join(base, "vault-old");
  mkdirSync(existing);
  const fresh = join(base, "vault-new");
  mkdirSync(fresh);
  const configPath = join(base, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vaults: { old: existing },
      defaultVaults: ["old"],
      zzz: { keep: true },
      allowWrite: false,
      defaultTaskRoot: "tasks",
      qmd: { enabled: false, updateTtlMinutes: 5 },
    }),
  );

  const setup = makeSetup({
    discovery: discovery([cand(fresh)]),
    configPath,
    confirm: true,
  });
  const plan = await setup.plan();
  const result = await setup.apply(plan);

  assert.equal(result.written, true);
  assert.equal(result.backup !== null && existsSync(result.backup), true);
  assert.match(result.backup, /\.bak\.\d{8}-\d{6}$/);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written.vaults, { old: existing, "vault-new": fresh }); // existing untouched, new added
  assert.deepEqual(written.defaultVaults, ["old"]); // existing value wins
  assert.equal(written.taskVault, "old"); // first of the kept defaultVaults
  assert.deepEqual(written.zzz, { keep: true }); // unknown key preserved
  assert.equal(written.allowWrite, false); // setting setup does not own
  assert.equal(written.defaultTaskRoot, "tasks");
  assert.equal(written.qmd.enabled, false);
  // the backup holds the previous content verbatim
  assert.equal(JSON.parse(readFileSync(result.backup, "utf8")).zzz.keep, true);
});

test("a missing parent directory is created on the first write", async (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(vault);
  const configPath = join(base, "nested", "dir", "config.json");
  const setup = makeSetup({ discovery: discovery([cand(vault)]), configPath, confirm: true });
  const result = await setup.apply(await setup.plan());
  assert.equal(result.written, true);
  assert.equal(existsSync(configPath), true);
});

// ── malformed / force ─────────────────────────────────────────────────────

test("a malformed config is refused without --force and replaced with it", async (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(vault);
  const configPath = join(base, "config.json");
  writeFileSync(configPath, "{ not json");

  const cautious = makeSetup({ discovery: discovery([cand(vault)]), configPath, confirm: true });
  const refused = await cautious.apply(await cautious.plan());
  assert.equal(refused.written, false);
  assert.equal(refused.error !== null && /malformed/.test(refused.error), true);
  assert.match(refused.error, /--force/);
  assert.equal(readFileSync(configPath, "utf8"), "{ not json");

  const forced = makeSetup({ discovery: discovery([cand(vault)]), configPath, confirm: true, force: true });
  const plan = await forced.plan();
  assert.match(plan.text, /malformed/);
  const result = await forced.apply(plan);
  assert.equal(result.written, true);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).vaults.vault, vault);
});

// ── idempotency ───────────────────────────────────────────────────────────

test("a second run proposes no changes, writes nothing and creates no backup", async (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(vault);
  const configPath = join(base, "config.json");

  const first = makeSetup({ discovery: discovery([cand(vault)]), configPath, confirm: true });
  await first.apply(await first.plan());
  const afterFirst = readFileSync(configPath, "utf8");
  assert.equal(backups(base).length, 0, "nothing existed before, no backup");

  const second = makeSetup({ discovery: discovery([cand(vault)]), configPath, confirm: true });
  const plan = await second.plan();
  assert.equal(plan.changed, false);
  assert.match(plan.text, /nothing to change/);
  const result = await second.apply(plan);
  assert.equal(result.written, false);
  assert.equal(result.backup, null);
  assert.equal(backups(base).length, 0);
  assert.equal(readFileSync(configPath, "utf8"), afterFirst);
});

// ── selection rules ───────────────────────────────────────────────────────

test("copies are proposed read-only and stay out of defaultVaults; taskVault follows", async (t) => {
  const base = makeBase(t);
  const main = join(base, "main");
  const copy = join(base, "copy");
  mkdirSync(main);
  mkdirSync(copy);
  const setup = makeSetup({
    discovery: discovery([cand(main), cand(copy, { copyOf: main, sharedNotes: 20 })]),
    configPath: join(base, "config.json"),
  });
  const plan = await setup.plan();
  assert.deepEqual(plan.config.vaults, { main, copy: { path: copy, writable: false } });
  assert.deepEqual(plan.config.defaultVaults, ["main"]);
  assert.equal(plan.config.taskVault, "main");
  assert.match(plan.text, /copy .*read-only/);
});

test("a candidate already registered or covered by a registered root is not re-added", async (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  const nested = join(vault, "inner");
  mkdirSync(nested, { recursive: true });
  const configPath = join(base, "config.json");
  writeFileSync(configPath, JSON.stringify({ vaults: { work: vault } }));

  const setup = makeSetup({
    discovery: discovery([cand(vault, { registeredAs: { source: "work", label: "vault" } }), cand(nested)]),
    configPath,
  });
  const plan = await setup.plan();
  assert.deepEqual(plan.config.vaults, { work: vault });
  assert.equal(plan.qmdSteps.length, 0, "registered roots get no qmd steps");
  assert.match(plan.text, /already registered as work\/vault/);
  assert.match(plan.text, /inside registered root work\/vault/);
});

test("a wrapper candidate (all notes live in a nested one) is skipped in the proposal", async (t) => {
  const base = makeBase(t);
  const wrapper = join(base, "obsidian");
  const inner = join(wrapper, "knowledge");
  mkdirSync(inner, { recursive: true });
  const setup = makeSetup({
    discovery: discovery([
      cand(wrapper, { obsidian: true, notes: 40, containsNested: [inner] }),
      cand(inner, { obsidian: true, notes: 40, nestedIn: wrapper }),
    ]),
    configPath: join(base, "config.json"),
  });
  const plan = await setup.plan();
  assert.deepEqual(plan.config.vaults, { knowledge: inner });
  assert.match(plan.text, /wrapper/);
});

test("name collisions get a -2 suffix", async (t) => {
  const base = makeBase(t);
  const a = join(base, "a", "notes");
  const b = join(base, "b", "notes");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const setup = makeSetup({ discovery: discovery([cand(a), cand(b)]), configPath: join(base, "config.json") });
  const plan = await setup.plan();
  assert.deepEqual(Object.keys(plan.config.vaults), ["notes", "notes-2"]);
});

// ── --group ───────────────────────────────────────────────────────────────

test("--group builds one multi-root source with labels from basenames", async (t) => {
  const base = makeBase(t);
  const one = join(base, "vault-one");
  const two = join(base, "vault-two");
  mkdirSync(one);
  mkdirSync(two);
  const setup = makeSetup({
    discovery: discovery([]),
    configPath: join(base, "config.json"),
    groups: [{ name: "work", paths: [one, two] }],
  });
  const plan = await setup.plan();
  assert.deepEqual(plan.config.vaults, { work: { paths: [one, two] } });
  assert.deepEqual(plan.config.defaultVaults, ["work"]);
  assert.deepEqual(
    plan.qmdSteps.map((s) => s.collection),
    ["work-vault-one", "work-vault-two"],
  );
  assert.match(plan.text, /group work: 2 roots \(vault-one, vault-two\)/);
});

test("--group labels deduplicate basename collisions (a, a-2)", async (t) => {
  const base = makeBase(t);
  const one = join(base, "a", "shared");
  const two = join(base, "b", "shared");
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  const setup = makeSetup({
    discovery: discovery([]),
    configPath: join(base, "config.json"),
    groups: [{ name: "work", paths: [one, two] }],
  });
  const plan = await setup.plan();
  assert.deepEqual(
    plan.qmdSteps.map((s) => `${s.label}:${s.collection}`),
    ["shared:work-shared", "shared-2:work-shared-2"],
  );
});

// ── --task-vault / --project ──────────────────────────────────────────────

test("--task-vault wins when it names a proposed source, and is ignored otherwise", async (t) => {
  const base = makeBase(t);
  const a = join(base, "a");
  const b = join(base, "b");
  mkdirSync(a);
  mkdirSync(b);
  const configPath = join(base, "config.json");

  const named = makeSetup({
    discovery: discovery([cand(a), cand(b)]),
    configPath,
    taskVault: "b",
  });
  assert.equal((await named.plan()).config.taskVault, "b");

  const unknown = makeSetup({
    discovery: discovery([cand(a), cand(b)]),
    configPath,
    taskVault: "nope",
  });
  const plan = await unknown.plan();
  assert.equal(plan.config.taskVault, "a", "falls back to the first of defaultVaults");
  assert.match(plan.text, /--task-vault "nope" names no proposed source/);
});

test("--project adds entries; an unknown source is skipped with a warning", async (t) => {
  const base = makeBase(t);
  const a = join(base, "a");
  mkdirSync(a);
  const setup = makeSetup({
    discovery: discovery([cand(a)]),
    configPath: join(base, "config.json"),
    groups: [{ name: "work", paths: [a] }],
    projects: [
      { prefix: join(base, "proj"), source: "work" },
      { prefix: join(base, "other"), source: "ghost" },
    ],
  });
  const plan = await setup.plan();
  assert.deepEqual(plan.config.projects, { [join(base, "proj")]: "work" });
  assert.match(plan.text, /unknown source "ghost"/);
});

test("existing projects pass through untouched", async (t) => {
  const base = makeBase(t);
  const a = join(base, "a");
  mkdirSync(a);
  const configPath = join(base, "config.json");
  writeFileSync(configPath, JSON.stringify({ vaults: {}, projects: { "/keep": "me" } }));
  const setup = makeSetup({ discovery: discovery([cand(a)]), configPath });
  const plan = await setup.plan();
  assert.deepEqual(plan.config.projects, { "/keep": "me" });
});

// ── --qmd ─────────────────────────────────────────────────────────────────

test("--qmd without --confirm prints the commands and executes nothing", async (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(vault);
  const { run, calls } = recordingRun();
  const setup = makeSetup({ discovery: discovery([cand(vault)]), configPath: join(base, "config.json"), qmd: true, run });
  const plan = await setup.plan();
  assert.deepEqual(plan.commands, [["qmd", "collection", "add", "vault"], ["qmd", "update"]]);
  assert.match(plan.text, /qmd collection add vault/);
  assert.match(plan.text, /embed is never executed|never run automatically/);
  await setup.apply(plan);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(base, "config.json")), false);
});

test("--qmd with --confirm runs add then update per root and isolates failures", async (t) => {
  const base = makeBase(t);
  const good = join(base, "good");
  const bad = join(base, "bad");
  mkdirSync(good);
  mkdirSync(bad);
  const { run, calls } = recordingRun((cmd, args) => {
    if (cmd === "qmd" && args[0] === "collection" && args[2] === "bad") {
      return { code: 1, stdout: "", stderr: "boom: bad root" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const setup = makeSetup({
    discovery: discovery([cand(bad), cand(good)]),
    configPath: join(base, "config.json"),
    confirm: true,
    qmd: true,
    run,
  });
  const result = await setup.apply(await setup.plan());

  assert.equal(result.failed, 1);
  assert.equal(result.written, true);
  assert.deepEqual(
    calls.map((c) => `${c.cmd} ${c.args.join(" ")} @ ${c.opts.cwd}`),
    [
      `qmd collection add bad @ ${realpathSync(bad)}`,
      `qmd collection add good @ ${realpathSync(good)}`,
      `qmd update @ ${realpathSync(good)}`,
    ],
    "the failing root is skipped after add; the next root still runs in full",
  );
  assert.match(result.notes.join("\n"), /qmd collection add failed for bad\/bad: boom: bad root/);
  assert.match(result.notes.join("\n"), /index updated for good\/good/);
  assert.match(result.notes.join("\n"), /qmd embed/, "the embed suggestion is printed");
  assert.equal(calls.some((c) => c.args.includes("embed")), false, "embed is never executed");
});

// ── things setup must never write ─────────────────────────────────────────

test("a full apply never creates .knowledge-mcp.json anywhere in the tree", async (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(vault);
  const configPath = join(base, "config.json");
  const setup = makeSetup({ discovery: discovery([cand(vault)]), configPath, confirm: true });
  const plan = await setup.plan();
  assert.match(plan.text, /\.knowledge-mcp\.json/);
  await setup.apply(plan);

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      assert.notEqual(entry.name, ".knowledge-mcp.json");
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(base);
});

// ── CLI ───────────────────────────────────────────────────────────────

test("parseArgs: repeatable and valued flags in both forms, usage errors otherwise", () => {
  const { options, errors } = parseArgs([
    "--setup", "--json",
    "--group", "work=/a,/b",
    "--group=extra=/c",
    "--task-vault", "work",
    "--project", "/p=work",
    "--project=/q=extra",
    "--roots", "/x,/y",
    "--min-notes", "5",
  ]);
  assert.deepEqual(errors, []);
  assert.equal(options.setup, true);
  assert.equal(options.json, true);
  assert.deepEqual(options.groups, [
    { name: "work", paths: ["/a", "/b"] },
    { name: "extra", paths: ["/c"] },
  ]);
  assert.equal(options.taskVault, "work");
  assert.deepEqual(options.projects, [
    { prefix: "/p", source: "work" },
    { prefix: "/q", source: "extra" },
  ]);
  assert.deepEqual(options.roots, ["/x", "/y"]);
  assert.equal(options.minNotes, 5);

  assert.deepEqual(parseArgs(["--wat"]).errors, ['unknown argument "--wat"']);
  assert.deepEqual(parseArgs(["--group=broken"]).errors, ['--group needs name=/p1,/p2, got "broken"']);
  assert.deepEqual(parseArgs(["--min-notes", "x"]).errors, [
    '--min-notes needs a non-negative integer, got "x"',
  ]);
});

test("cli --setup --json prints the proposal and writes no file", (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(vault, "a.md"), "# a\n");
  const configPath = join(base, "config.json");
  const result = spawnSync(process.execPath, [CLI, "--setup", "--json", "--roots", base, "--min-notes", "1"], {
    cwd: base,
    encoding: "utf8",
    env: { ...process.env, KNOWLEDGE_MCP_CONFIG: configPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.changed, true);
  assert.equal(parsed.config.vaults.vault, realpathSync(vault));
  assert.equal(existsSync(configPath), false, "preview mode writes nothing");
});

test("cli --setup without --json prints a human plan and writes no file", (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  const configPath = join(base, "config.json");
  const result = spawnSync(process.execPath, [CLI, "--setup", "--roots", base], {
    cwd: base,
    encoding: "utf8",
    env: { ...process.env, KNOWLEDGE_MCP_CONFIG: configPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preview \(nothing is written without --confirm\)/);
  assert.equal(existsSync(configPath), false);
});

test("cli --setup --confirm writes the config through the whole pipeline", (t) => {
  const base = makeBase(t);
  const vault = join(base, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(vault, "a.md"), "# a\n");
  const configPath = join(base, "config.json");
  const env = { ...process.env, KNOWLEDGE_MCP_CONFIG: configPath };
  const args = ["--setup", "--confirm", "--roots", base, "--min-notes", "1"];
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: base, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(written.vaults.vault, realpathSync(vault));
  assert.deepEqual(written.defaultVaults, ["vault"]);

  // the second run is a no-op through the same pipeline
  const again = spawnSync(process.execPath, [CLI, ...args], { cwd: base, encoding: "utf8", env });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /nothing to change/);
  assert.equal(backups(base).length, 0, "neither run had a file to back up (first create, second no-op)");
});
