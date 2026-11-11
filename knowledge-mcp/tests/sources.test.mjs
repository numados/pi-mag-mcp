/**
 * Source and path resolution: precedence (explicit vault → repo
 * .knowledge-mcp.json → longest projects prefix on a directory boundary →
 * defaultVaults[0] → legacy defaultVault), multi-root path resolution with
 * `<label>:<rel>` addressing, ambiguity with the `address as` hint, the write
 * root and task workspaces. Error texts are part of the contract.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../dist/config.js";
import { resolveRef, resolveSource, taskRootOf, writeRoot } from "../dist/sources.js";

function makeFixture(t) {
  const base = mkdtempSync(join(tmpdir(), "kmcp-src-"));
  const main = join(base, "work-main");
  const shared = join(base, "work-shared");
  const archive = join(base, "work-archive");
  const personal = join(base, "personal");
  for (const p of [
    join(main, "Projects"),
    join(main, "Projects"),
    join(main, "attachments"),
    join(shared, "Notes"),
    join(shared, "Projects"),
    join(archive, "Old"),
    join(personal, "knowledge", "Notes"),
    join(base, "proj-foo", "sub"),
    join(base, "proj-foo-bar", "sub"),
    join(base, "proj-foobar"),
  ]) mkdirSync(p, { recursive: true });
  writeFileSync(join(main, "Projects", "overview.md"), "access notes");
  writeFileSync(join(main, "Projects", "plan.md"), "plan");
  writeFileSync(join(main, "attachments", "pic.png"), "png");
  writeFileSync(join(shared, "Notes", "retry.md"), "retry notes");
  writeFileSync(join(shared, "Projects", "plan.md"), "plan shared");
  writeFileSync(join(archive, "Old", "overview.md"), "old access");
  writeFileSync(join(personal, "knowledge", "Notes", "x.md"), "x");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // roots are realpath'd at load time (/var → /private/var on macOS); expectations
  // build on the real base so abs paths compare equal
  return realpathSync(base);
}

function loadCfg(t, base, extra = {}) {
  const { main, shared, archive, personal } = fixtureOf(base);
  const cfgPath = join(base, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      vaults: {
        work: {
          paths: [
            { path: main, label: "main" },
            { path: shared, label: "shared" },
            { path: archive, label: "archive", writable: false, qmd: false },
          ],
        },
        personal,
      },
      defaultVaults: ["work", "personal"],
      taskVault: "work",
      projects: {
        [join(base, "proj-foo")]: "personal",
        [join(base, "proj-foo-bar")]: "work",
      },
      knowledgeRoot: "Knowledge",
      defaultTaskRoot: "tasks",
      allowWrite: true,
      qmd: { enabled: false, updateTtlMinutes: 10 },
      ...extra,
    }),
  );
  const prev = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = cfgPath;
  t.after(() => {
    if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev;
  });
  return loadConfig();
}

// the fixture dirs by convention, so load() can rebuild a config on demand
function fixtureOf(base) {
  return {
    main: join(base, "work-main"),
    shared: join(base, "work-shared"),
    archive: join(base, "work-archive"),
    personal: join(base, "personal"),
  };
}

// ── resolveSource precedence ──────────────────────────────────────────────

test("explicit vault argument wins", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  const src = resolveSource(load, "personal", base);
  assert.equal(src.name, "personal");
});

test("unknown vault names list the known sources", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  assert.throws(() => resolveSource(load, "nope", base), /unknown vault "nope" \(known: work, personal\)/);
});

test("repo .knowledge-mcp.json selects the source", (t) => {
  const base = makeFixture(t);
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".knowledge-mcp.json"), JSON.stringify({ vault: "personal" }));
  const load = loadCfg(t, base);
  assert.equal(resolveSource(load, undefined, repo).name, "personal");
  // an explicit argument still beats the repo file
  assert.equal(resolveSource(load, "work", repo).name, "work");
});

test("an unknown repo vault is an error, not a fallback", (t) => {
  const base = makeFixture(t);
  const repo = join(base, "repo-unknown");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".knowledge-mcp.json"), JSON.stringify({ vault: "zzz" }));
  const load = loadCfg(t, base);
  assert.throws(() => resolveSource(load, undefined, repo), /unknown vault "zzz" \(known: work, personal\)/);
});

test("longest projects prefix wins on directory boundaries", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  assert.equal(resolveSource(load, undefined, join(base, "proj-foo-bar", "sub")).name, "work");
  assert.equal(resolveSource(load, undefined, join(base, "proj-foo", "sub")).name, "personal");
  // proj-foobar shares characters with proj-foo but is not inside it
  assert.equal(resolveSource(load, undefined, join(base, "proj-foobar")).name, "work"); // defaultVaults[0]
});

test("defaultVaults[0] applies when nothing else matches", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  assert.equal(resolveSource(load, undefined, base).name, "work");
});

test("legacy defaultVault is the last fallback", (t) => {
  const base = makeFixture(t);
  const { personal } = fixtureOf(base);
  const cfgPath = join(base, "config-legacy.json");
  writeFileSync(cfgPath, JSON.stringify({ vaults: { personal }, defaultVault: "personal" }));
  const prev = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = cfgPath;
  t.after(() => {
    if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev;
  });
  assert.equal(resolveSource(loadConfig(), undefined, base).name, "personal");
});

test("defaultVaults wins over the legacy defaultVault", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base, { defaultVault: "personal" });
  assert.equal(resolveSource(load, undefined, base).name, "work");
});

test("no vault resolved keeps the source text and adds the --setup hint", (t) => {
  const base = makeFixture(t);
  const cfgPath = join(base, "config-empty.json");
  writeFileSync(cfgPath, JSON.stringify({}));
  const prev = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = cfgPath;
  t.after(() => {
    if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev;
  });
  assert.throws(
    () => resolveSource(loadConfig(), undefined, base),
    (e) => {
      assert.match(
        e.message,
        /^no vault resolved: pass vault=<name>, or set defaultVault\/projects in .* \(known vaults: none — add one to vaults\) — run with --setup to create the config$/,
      );
      return true;
    },
  );

  // with known vaults but no default and no project match, they are listed
  const base2 = makeFixture(t);
  const cfg2 = join(base2, "config-nodefault.json");
  writeFileSync(
    cfg2,
    JSON.stringify({ vaults: { work: join(base2, "work-main"), personal: join(base2, "personal") } }),
  );
  const prev2 = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = cfg2;
  t.after(() => {
    if (prev2 === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev2;
  });
  assert.throws(
    () => resolveSource(loadConfig(), undefined, base2),
    /no vault resolved: .*\(known vaults: work, personal\) — run with --setup/,
  );
});

test("a source whose roots are all missing keeps the source error text", (t) => {
  const base = makeFixture(t);
  const dead = join(base, "no-such-dir");
  const cfgPath = join(base, "config-dead.json");
  writeFileSync(cfgPath, JSON.stringify({ vaults: { dead }, defaultVault: "dead" }));
  const prev = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = cfgPath;
  t.after(() => {
    if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev;
  });
  assert.throws(
    () => resolveSource(loadConfig(), undefined, base),
    new RegExp(`vault "dead" path does not exist or is not a directory: ${dead}`),
  );
});

// ── resolveRef ────────────────────────────────────────────────────────────

test("exact relative path, then rel + .md, walking roots in order", (t) => {
  const base = makeFixture(t);
  const { main } = fixtureOf(base);
  const load = loadCfg(t, base);
  const work = load.config.sources[0];

  const exact = resolveRef(work, "Projects/overview.md", "read");
  assert.equal(exact.root.label, "main");
  assert.equal(exact.rel, "Projects/overview.md");
  assert.equal(exact.abs, join(main, "Projects", "overview.md"));

  const appended = resolveRef(work, "Projects/overview", "read");
  assert.equal(appended.abs, join(main, "Projects", "overview.md"));
});

test("a basename unique across all roots resolves", (t) => {
  const base = makeFixture(t);
  const { shared } = fixtureOf(base);
  const load = loadCfg(t, base);
  const hit = resolveRef(load.config.sources[0], "retry", "read");
  assert.equal(hit.root.label, "shared");
  assert.equal(hit.abs, join(shared, "Notes", "retry.md"));
});

test("the same rel in two roots is ambiguous with the address-as hint", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  assert.throws(
    () => resolveRef(load.config.sources[0], "Projects/plan.md", "read"),
    /ambiguous path in source "work": main:Projects\/plan\.md, shared:Projects\/plan\.md — address as "main:Projects\/plan\.md"/,
  );
});

test("an ambiguous basename reports the same way", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  assert.throws(
    () => resolveRef(load.config.sources[0], "overview", "read"),
    /ambiguous path in source "work": main:Projects\/overview\.md, archive:Old\/overview\.md — address as "main:Projects\/overview\.md"/,
  );
});

test("<label>:<rel> addresses one root; unknown labels list the roots", (t) => {
  const base = makeFixture(t);
  const { shared, archive } = fixtureOf(base);
  const load = loadCfg(t, base);
  const work = load.config.sources[0];

  const labeled = resolveRef(work, "shared:Projects/plan.md", "read");
  assert.equal(labeled.root.label, "shared");
  assert.equal(labeled.abs, join(shared, "Projects", "plan.md"));

  assert.equal(resolveRef(work, "archive:Old/overview.md", "read").abs, join(archive, "Old", "overview.md"));
  assert.throws(
    () => resolveRef(work, "nope:x.md", "read"),
    /unknown root "nope" in source "work" \(roots: main, shared, archive\)/,
  );
});

test("missing notes keep the exact source text", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  assert.throws(
    () => resolveRef(load.config.sources[0], "missing.md", "read"),
    (e) => {
      assert.equal(e.message, "note not found: missing.md");
      return true;
    },
  );
});

test("an existing non-markdown exact match is not a note", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  assert.throws(
    () => resolveRef(load.config.sources[0], "attachments/pic.png", "read"),
    /not a Markdown note: attachments\/pic\.png/,
  );
});

test("safety rejections keep their texts inside a source", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  const work = load.config.sources[0];
  assert.throws(() => resolveRef(work, "../outside.md", "read"), /path escapes the vault: \.\.\/outside\.md/);
  assert.throws(() => resolveRef(work, ".git/config", "read"), /protected location/);
});

test("write mode: first writable root, .md ensured, read-only roots rejected", (t) => {
  const base = makeFixture(t);
  const { main, shared } = fixtureOf(base);
  const load = loadCfg(t, base);
  const work = load.config.sources[0];

  const created = resolveRef(work, "New Note", "write");
  assert.equal(created.root.label, "main");
  assert.equal(created.rel, "New Note.md");
  assert.equal(created.abs, join(main, "New Note.md"));

  const labeled = resolveRef(work, "shared:Notes/extra.md", "write");
  assert.equal(labeled.abs, join(shared, "Notes", "extra.md"));

  assert.throws(() => resolveRef(work, "archive:X.md", "write"), /source root "archive" is read-only by config/);
  assert.throws(() => resolveRef(work, "attachments/drop.md", "write"), /protected location/);
});

test("writeRoot: first writable root; a fully read-only source has none", (t) => {
  const base = makeFixture(t);
  const load = loadCfg(t, base);
  assert.equal(writeRoot(load.config.sources[0]).label, "main");

  const ro = { name: "ro", roots: [{ label: "a", path: base, writable: false, qmd: null }] };
  assert.throws(() => writeRoot(ro), /no writable root in source "ro" \(roots: a\)/);
});

// ── task workspaces ───────────────────────────────────────────────────────

test("taskRootOf resolves inside the write root and reports existing dirs elsewhere", (t) => {
  const base = makeFixture(t);
  const { main, shared } = fixtureOf(base);
  const load = loadCfg(t, base);
  const work = load.config.sources[0];
  const noRepo = { repoRoot: null, config: {}, configPath: null };

  const fresh = taskRootOf(work, noRepo, "tasks");
  assert.equal(fresh.rel, "tasks");
  assert.equal(fresh.root.label, "main");
  assert.deepEqual(fresh.elsewhere, []);

  // the dir exists only in a non-write root → data, not an error
  mkdirSync(join(shared, "tasks"));
  const elsewhere = taskRootOf(work, noRepo, "tasks");
  assert.equal(elsewhere.root.label, "main"); // still the write root
  assert.deepEqual(elsewhere.elsewhere.map((r) => r.label), ["shared"]);
  assert.equal(join(main, "tasks"), join(elsewhere.root.path, elsewhere.rel));

  assert.throws(() => taskRootOf(work, noRepo, undefined), /no task root: /);
});

test("taskRootOf: an explicit argument wins over the repo config and the central default", (t) => {
  const base = makeFixture(t);
  const { main } = fixtureOf(base);
  const load = loadCfg(t, base);
  const work = load.config.sources[0];
  const repo = { repoRoot: join(base, "repo"), config: { taskRoot: "repo-tasks" }, configPath: null };

  assert.equal(taskRootOf(work, repo, "central-tasks").rel, "repo-tasks", "repo beats central");
  const chosen = taskRootOf(work, repo, "central-tasks", "chosen");
  assert.equal(chosen.rel, "chosen", "explicit beats both");
  assert.equal(join(chosen.root.path, chosen.rel), join(main, "chosen"));
});

