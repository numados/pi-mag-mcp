/**
 * Discovery: wrapper reporting vs nested vaults, the candidate rule
 * (vault or minNotes notes, ancestors pruned), copy detection via the shared
 * sample rule, threshold/depth/time limits, skip lists, glob root expansion
 * and registeredAs marks. Everything runs on temp trees with explicit roots —
 * the real home directory is never scanned by a test.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDiscovery, expandRoots } from "../dist/discover.js";

function makeBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "kmcp-disc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return realpathSync(dir);
}

function notes(dir, count, { obsidian = false, prefix = "note-" } = {}) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `${prefix}${i}.md`), `# note ${i}\n\nsame body\n`);
  if (obsidian) mkdirSync(join(dir, ".obsidian"));
  return dir;
}

const scan = async (base, opts = {}) => createDiscovery({ roots: [base], ...opts }).scan();

test("a wrapper directory is reported as the wrapper, not as a candidate", async (t) => {
  const base = makeBase(t);
  const vault = notes(join(base, "wrapper", "vault"), 25, { obsidian: true });
  const candidates = await scan(base);
  assert.deepEqual(candidates.map((c) => c.path), [vault]);
  assert.equal(candidates[0].nestedIn, join(base, "wrapper"));
  assert.equal(candidates[0].obsidian, true);
  assert.equal(candidates[0].notes, 25);
});

test("a vault nested in a vault: both are candidates and cross-marked (the machine case)", async (t) => {
  const base = makeBase(t);
  const obsidian = notes(join(base, "obsidian"), 0, { obsidian: true });
  const knowledge = notes(join(obsidian, "knowledge"), 25, { obsidian: true });
  const candidates = await scan(base);
  assert.deepEqual(candidates.map((c) => c.path), [obsidian, knowledge]);
  assert.deepEqual(candidates[1].nestedIn, obsidian);
  assert.deepEqual(candidates[0].containsNested, [knowledge]);
});

test("a note directory becomes a candidate; its ancestor is pruned, not double-counted", async (t) => {
  const base = makeBase(t);
  const dir = notes(join(base, "docs", "notes"), 25);
  const candidates = await scan(base);
  assert.deepEqual(candidates.map((c) => c.path), [dir]);
  assert.equal(candidates[0].nestedIn, join(base, "docs"));
});

test("a small directory below --min-notes is not a candidate", async (t) => {
  const base = makeBase(t);
  notes(join(base, "tiny"), 5);
  assert.deepEqual(await scan(base), []);
  const raised = await scan(base, { minNotes: 5 });
  assert.deepEqual(raised.map((c) => c.path), [join(base, "tiny")]);
});

test("copy detection: >=60% shared sample and fewer notes marks the duplicate", async (t) => {
  const base = makeBase(t);
  const big = notes(join(base, "big"), 30);
  const small = notes(join(base, "small"), 20); // note-0..19 with identical sizes
  const candidates = await scan(base);
  const copy = candidates.find((c) => c.path === small);
  assert.equal(copy.copyOf, big);
  assert.equal(copy.sharedNotes, 20);
  assert.equal(candidates.find((c) => c.path === big).copyOf, undefined);
});

test("a copy that sorts before its original is still detected", async (t) => {
  const base = makeBase(t);
  const aaaCopy = notes(join(base, "aaa-copy"), 20); // sorts before the original
  const zzzVault = notes(join(base, "zzz-vault"), 30);
  for (let i = 0; i < 20; i++) writeFileSync(join(aaaCopy, `note-${i}.md`), readFileSync(join(zzzVault, `note-${i}.md`)));
  const candidates = await scan(base);
  assert.equal(candidates.find((c) => c.path === aaaCopy).copyOf, zzzVault);
  assert.equal(candidates.find((c) => c.path === zzzVault).copyOf, undefined);
});

test("equal note counts never mark a copy (canonical is the user's call)", async (t) => {
  const base = makeBase(t);
  notes(join(base, "a"), 25);
  notes(join(base, "b"), 25);
  const candidates = await scan(base);
  assert.deepEqual(candidates.map((c) => c.copyOf), [undefined, undefined]);
});

test("depth limit: a vault one level too deep is not found", async (t) => {
  const base = makeBase(t);
  const deep = notes(join(base, "deep", "a", "b", "c", "v"), 3, { obsidian: true }); // depth 5
  assert.deepEqual(await scan(base), [], "default maxDepth is 4");
  const found = await scan(base, { maxDepth: 5 });
  assert.deepEqual(found.map((c) => c.path), [deep]);
});

test("time budget: a consumed budget stops the walk", async (t) => {
  const base = makeBase(t);
  notes(join(base, "vault"), 3, { obsidian: true });
  let clock = 0;
  const exhausted = await scan(base, { timeBudgetMs: 0, now: () => (clock += 1000) });
  assert.deepEqual(exhausted, []);
  const enough = await scan(base, { timeBudgetMs: 60_000, now: () => (clock += 1000) });
  assert.equal(enough.length, 1);
});

test("node_modules and .app bundles are skipped, notes there are not counted", async (t) => {
  const base = makeBase(t);
  const vault = notes(join(base, "vault"), 2, { obsidian: true });
  notes(join(vault, "node_modules", "pkg"), 50); // invisible
  notes(join(vault, "Some.app", "Contents"), 30, { obsidian: true }); // invisible
  const candidates = await scan(base);
  assert.deepEqual(candidates.map((c) => c.path), [vault]);
  assert.equal(candidates[0].notes, 2, "hidden and skipped dirs contribute no notes");
});

test("newestMtimeDaysAgo and bytes are reported", async (t) => {
  const base = makeBase(t);
  const dir = notes(join(base, "notes"), 25);
  const candidates = await scan(base);
  assert.deepEqual(candidates.map((c) => c.path), [dir]);
  assert.equal(candidates[0].newestMtimeDaysAgo, 0); // just written
  assert.ok(candidates[0].bytes > 0);
  assert.equal(candidates[0].name, "notes");
});

test("registeredAs marks candidates the config already owns", async (t) => {
  const base = makeBase(t);
  const big = notes(join(base, "big"), 25);
  const small = notes(join(base, "other"), 25);
  const load = () => ({
    state: "ok",
    path: "/tmp/none.json",
    errors: [],
    config: {
      sources: [{ name: "work", roots: [{ label: "big", path: big, writable: true, qmd: null }] }],
      defaultVaults: ["work"],
      taskVault: null,
      defaultVault: null,
      projects: {},
      knowledgeRoot: null,
      defaultTaskRoot: null,
      allowWrite: true,
      qmd: { enabled: true, updateTtlMinutes: 10 },
      configPath: "/tmp/none.json",
      raw: {},
    },
  });
  const candidates = await scan(base, { load });
  assert.deepEqual(candidates.find((c) => c.path === big).registeredAs, { source: "work", label: "big" });
  assert.equal(candidates.find((c) => c.path === small).registeredAs, null);
});

test("expandRoots: globs over the parent, missing roots dropped, no duplicates", (t) => {
  const base = makeBase(t);
  mkdirSync(join(base, "Yandex.Disk-en"));
  mkdirSync(join(base, "Yandex.Disk.ru"));
  mkdirSync(join(base, "Other"));
  const expanded = expandRoots([
    join(base, "Yandex.Disk*"),
    join(base, "Other"),
    join(base, "does-not-exist"),
    join(base, "Other"), // duplicate root collapses
  ]).sort();
  assert.deepEqual(expanded, [
    realpathSync(join(base, "Other")),
    realpathSync(join(base, "Yandex.Disk-en")),
    realpathSync(join(base, "Yandex.Disk.ru")),
  ]);
});
