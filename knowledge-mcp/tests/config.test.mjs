/**
 * Config model: every accepted source form, label defaults and deduplication,
 * normalization (trailing slash, symlinked root), structural problems
 * reported as errors while valid sources survive, and the three file states
 * (ok / missing / malformed) — a broken file is never a silent fallback to
 * defaults.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../dist/config.js";

function makeBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "kmcp-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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

test("every source form collapses into the normalized Root shape", (t) => {
  const dir = makeBase(t);
  for (const name of ["one", "two", "three", "four", "five"]) mkdirSync(join(dir, name));
  useConfig(t, dir, {
    vaults: {
      work: {
        paths: [
          { path: join(dir, "one"), label: "main" },
          { path: join(dir, "two"), label: "shared" },
          { path: join(dir, "three"), label: "archive", writable: false, qmd: false },
        ],
      },
      personal: join(dir, "four"),
      notes: { path: join(dir, "five"), writable: false },
    },
    defaultVaults: ["work", "personal"],
    taskVault: "work",
  });

  const { state, errors, config } = loadConfig();
  assert.equal(state, "ok");
  assert.deepEqual(errors, []);
  assert.equal(config.sources.length, 3);

  const work = config.sources[0];
  assert.equal(work.name, "work");
  assert.deepEqual(work.roots.map((r) => r.label), ["main", "shared", "archive"]);
  assert.deepEqual(work.roots.map((r) => r.writable), [true, true, false]);
  assert.deepEqual(work.roots.map((r) => r.qmd), [null, null, false]);

  const personal = config.sources[1];
  assert.equal(personal.roots.length, 1);
  assert.equal(personal.roots[0].label, "four"); // basename default
  assert.equal(personal.roots[0].writable, true);
  assert.equal(personal.roots[0].qmd, null);

  const notes = config.sources[2];
  assert.equal(notes.roots[0].label, "five");
  assert.equal(notes.roots[0].writable, false);

  assert.deepEqual(config.defaultVaults, ["work", "personal"]);
  assert.equal(config.taskVault, "work");
});

test("array form and per-root options overriding source-level ones", (t) => {
  const dir = makeBase(t);
  for (const name of ["a", "nested", "nested/b"]) mkdirSync(join(dir, name), { recursive: true });
  useConfig(t, dir, {
    vaults: {
      s: {
        paths: [join(dir, "a"), { path: join(dir, "nested", "b"), writable: true }],
        writable: false,
        qmd: true,
      },
    },
  });

  const { config, errors } = loadConfig();
  assert.deepEqual(errors, []);
  const roots = config.sources[0].roots;
  assert.deepEqual(roots.map((r) => r.label), ["a", "b"]);
  assert.deepEqual(roots.map((r) => r.writable), [false, true]); // per-root overrides source
  assert.deepEqual(roots.map((r) => r.qmd), [true, true]); // inherited from source level
});

test("default labels deduplicate with -2 when basenames collide", (t) => {
  const dir = makeBase(t);
  for (const p of ["one", "nested/one", "deep/nested/one"]) mkdirSync(join(dir, p), { recursive: true });
  useConfig(t, dir, { vaults: { s: [join(dir, "one"), join(dir, "nested", "one"), join(dir, "deep", "nested", "one")] } });

  const { config, errors } = loadConfig();
  assert.deepEqual(errors, []);
  assert.deepEqual(config.sources[0].roots.map((r) => r.label), ["one", "one-2", "one-3"]);
});

test("a duplicate explicit label is an error and the later root is dropped", (t) => {
  const dir = makeBase(t);
  for (const name of ["a", "b", "c"]) mkdirSync(join(dir, name));
  useConfig(t, dir, {
    vaults: { s: { paths: [{ path: join(dir, "a"), label: "x" }, { path: join(dir, "b"), label: "x" }, join(dir, "c")] } },
  });

  const { config, errors } = loadConfig();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate root label "x" in source "s"/);
  assert.deepEqual(config.sources[0].roots.map((r) => r.label), ["x", "c"]);
});

test("the same absolute path claimed by two sources is reported, both survive", (t) => {
  const dir = makeBase(t);
  mkdirSync(join(dir, "shared"));
  const shared = realpathSync(join(dir, "shared")); // roots are normalized to real paths
  useConfig(t, dir, { vaults: { a: join(dir, "shared"), b: join(dir, "shared") } });

  const { config, errors } = loadConfig();
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`root path ${shared} is claimed by source "a" and source "b"`));
  assert.deepEqual(config.sources.map((s) => s.name), ["a", "b"]);
});

test("a non-absolute root path is an error and the source is dropped", (t) => {
  const dir = makeBase(t);
  mkdirSync(join(dir, "ok"));
  useConfig(t, dir, { vaults: { bad: "relative/path", good: join(dir, "ok") } });

  const { config, errors } = loadConfig();
  assert.ok(errors.some((e) => /vault "bad": root path must be absolute: relative\/path/.test(e)));
  assert.ok(errors.some((e) => /source "bad" has no usable roots/.test(e)));
  assert.deepEqual(config.sources.map((s) => s.name), ["good"]);
});

test("defaultVaults/taskVault/defaultVault naming unknown sources are errors, not silent drops", (t) => {
  const dir = makeBase(t);
  mkdirSync(join(dir, "a"));
  useConfig(t, dir, {
    vaults: { a: join(dir, "a") },
    defaultVaults: ["a", "zzz"],
    taskVault: "yyy",
    defaultVault: "xxx",
  });

  const { config, errors } = loadConfig();
  assert.match(errors.find((e) => e.includes("defaultVaults")), /defaultVaults names unknown source "zzz" \(known: a\)/);
  assert.match(errors.find((e) => e.includes("taskVault")), /taskVault names unknown source "yyy" \(known: a\)/);
  assert.match(errors.find((e) => e.includes("defaultVault ")), /defaultVault names unknown source "xxx" \(known: a\)/);
  assert.deepEqual(config.defaultVaults, ["a"]);
  assert.equal(config.taskVault, null);
  assert.equal(config.defaultVault, null);
});

test("legacy defaultVault is accepted and kept", (t) => {
  const dir = makeBase(t);
  mkdirSync(join(dir, "a"));
  useConfig(t, dir, { vaults: { a: join(dir, "a") }, defaultVault: "a" });
  const { config, errors } = loadConfig();
  assert.deepEqual(errors, []);
  assert.equal(config.defaultVault, "a");
});

test("a malformed file is state:malformed with the parser message and the path", (t) => {
  const dir = makeBase(t);
  const cfgPath = useConfig(t, dir, "{ not json");
  const { state, error, path, config, errors } = loadConfig();
  assert.equal(state, "malformed");
  assert.ok(typeof error === "string" && error.length > 0);
  assert.equal(path, cfgPath);
  assert.deepEqual(config.sources, []);
  assert.deepEqual(errors, []);
});

test("a missing file is state:missing with built-in defaults", (t) => {
  const dir = makeBase(t);
  const prev = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = join(dir, "does-not-exist.json");
  t.after(() => {
    if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev;
  });

  const { state, error, config } = loadConfig();
  assert.equal(state, "missing");
  assert.equal(error, undefined);
  assert.deepEqual(config.sources, []);
  assert.deepEqual(config.defaultVaults, []);
  assert.equal(config.allowWrite, true);
  assert.equal(config.qmd.enabled, true);
  assert.equal(config.qmd.updateTtlMinutes, 10);
});

test("the file is deep-merged over defaults and unknown keys are preserved", (t) => {
  const dir = makeBase(t);
  useConfig(t, dir, { qmd: { updateTtlMinutes: 5 }, zzz: { keep: true } });
  const { config } = loadConfig();
  assert.equal(config.qmd.enabled, true); // default survives the merge
  assert.equal(config.qmd.updateTtlMinutes, 5);
  assert.equal(config.allowWrite, true);
  assert.deepEqual(config.raw.zzz, { keep: true });
});

test("root paths are normalized: trailing slash stripped, symlink resolved", (t) => {
  const dir = makeBase(t);
  const real = join(dir, "real-vault");
  mkdirSync(real);
  const realPath = realpathSync(real); // /var → /private/var on macOS
  symlinkSync(real, join(dir, "link-vault"));
  useConfig(t, dir, { vaults: { linked: join(dir, "link-vault") + "/" } });

  const { config, errors } = loadConfig();
  assert.deepEqual(errors, []);
  const linked = config.sources[0].roots[0];
  assert.equal(linked.path, realPath); // realpath'd → a symlinked vault is the real dir
  assert.equal(linked.label, basename(realPath)); // label from the normalized path

  // a trailing slash cannot break containment either
  useConfig(t, dir, { vaults: { slashed: real + "/" } });
  const { config: cfg2 } = loadConfig();
  assert.equal(cfg2.sources[0].roots[0].path, realPath);
});

test("scalar settings are validated, invalid ones fall back and report", (t) => {
  const dir = makeBase(t);
  useConfig(t, dir, { allowWrite: "yes", knowledgeRoot: 5, qmd: { enabled: "no" }, defaultVaults: "work" });
  const { config, errors } = loadConfig();
  assert.ok(errors.some((e) => /allowWrite must be a boolean/.test(e)));
  assert.ok(errors.some((e) => /knowledgeRoot must be a string/.test(e)));
  assert.ok(errors.some((e) => /qmd\.enabled must be a boolean/.test(e)));
  assert.ok(errors.some((e) => /defaultVaults must be an array of source names/.test(e)));
  assert.equal(config.allowWrite, true);
  assert.equal(config.knowledgeRoot, null);
  assert.deepEqual(config.defaultVaults, []);
});

test("a leading ~/ is expanded to the home directory", (t) => {
  const base = makeBase(t);
  useConfig(t, base, { vaults: { home: "~/vaults/home" } });
  const loaded = loadConfig();
  assert.equal(loaded.state, "ok");
  assert.equal(loaded.config.sources[0].roots[0].path, join(homedir(), "vaults/home"));
});
