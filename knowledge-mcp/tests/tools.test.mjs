/**
 * Tool behaviour: two-phase writes (no file changes without confirm), the
 * secrets refusal, ambiguity messages, read-only roots, multi-source grouped
 * search with skipped entries, graph mode, conventions, the repo map and the
 * limit/maxChars clamps. Everything runs on temp trees with qmd disabled by
 * config; rg runs for real (it is the required binary).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createContext } from "../dist/context.js";
import { parseNote } from "../dist/md.js";
import { knowledgeLinks, knowledgeRead, knowledgeSearch, knowledgeStructure } from "../dist/tools/read.js";
import { knowledgeRepo } from "../dist/tools/repo.js";
import { knowledgeTask } from "../dist/tools/task.js";
import { knowledgeMove, knowledgeWrite } from "../dist/tools/write.js";

const output = (r) => r.content[0].text;

// ── fixture: work (multi-root: main writable, archive read-only) + personal ─

function makeTree(t) {
  const base = mkdtempSync(join(tmpdir(), "kmcp-tools-"));
  const main = join(base, "work-main");
  const archive = join(base, "work-archive");
  const personal = join(base, "personal");
  const dead = join(base, "gone-source"); // configured but never created
  for (const p of [join(main, "Projects"), join(main, "Knowledge"), join(archive, "Old"), join(personal, "notes")]) {
    mkdirSync(p, { recursive: true });
  }
  writeFileSync(join(main, "Projects", "overview.md"), "---\ntitle: Access\n---\n# Access\n\nalpha access notes\n\nsee [[connector]]\n");
  writeFileSync(join(main, "Projects", "connector.md"), "---\ntitle: connector\n---\nconnector connector notes\n");
  writeFileSync(join(main, "Knowledge", "topic.md"), "---\ntitle: Topic\nupdated: 2026-01-01\n---\n# Topic\n\n## Alpha\n\nalpha text\n\n## Beta\n\nbeta text\n");
  writeFileSync(join(archive, "Old", "overview.md"), "archived access");
  writeFileSync(join(personal, "notes", "personal.md"), "personal needle notes");
  const configPath = join(base, "config.json");
  writeFileSync(configPath, JSON.stringify({
    vaults: {
      work: { paths: [
        { path: main, label: "main" },
        { path: archive, label: "archive", writable: false, qmd: false },
      ] },
      personal,
      dead,
    },
    defaultVaults: ["work", "personal"],
    taskVault: "work",
    knowledgeRoot: "Knowledge",
    defaultTaskRoot: "tasks",
    allowWrite: true,
    qmd: { enabled: false },
  }));
  const prev = process.env.KNOWLEDGE_MCP_CONFIG;
  process.env.KNOWLEDGE_MCP_CONFIG = configPath;
  t.after(() => {
    if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
    else process.env.KNOWLEDGE_MCP_CONFIG = prev;
    rmSync(base, { recursive: true, force: true });
  });
  return { base: realpathSync(base), main, archive, personal, configPath };
}

/** Directory snapshot for two-phase checks (path → [mtime, size]). */
function snap(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(p, [st.mtimeMs, st.size]);
    }
  };
  walk(root);
  return out;
}

const sameTree = (before, after) =>
  before.size === after.size && [...before].every(([p, [m, s]]) => {
    const a = after.get(p);
    return a !== undefined && a[0] === m && a[1] === s;
  });

// ── two-phase writes ──────────────────────────────────────────────────────

test("no confirm changes nothing: write, move and task previews leave the tree untouched", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const before = snap(f.base);

  const previews = [
    knowledgeWrite({ op: "create", target: "Knowledge/new note.md", body: "fresh body [[topic]]" }, c.forCall({})),
    knowledgeWrite({ op: "update", target: "Knowledge/topic.md", body: "rewritten" }, c.forCall({})),
    knowledgeWrite({ op: "retire", target: "Knowledge/topic.md", reason: "old" }, c.forCall({})),
    knowledgeWrite({ op: "supersede", target: "Knowledge/topic.md", superseded_by: "connector" }, c.forCall({})),
    knowledgeMove({ from: "Knowledge/topic.md", to: "Knowledge/renamed.md" }, c.forCall({})),
    knowledgeTask({ action: "init", ticket: "TKT-9", title: "Nine" }, c.forTask({ ticket: "TKT-9" })),
    knowledgeTask({ action: "init", ticket: "TKT-9", title: "Nine", confirm: false }, c.forTask({ ticket: "TKT-9" })),
  ];
  for (const p of previews) {
    const r = await p;
    assert.notEqual(r.isError, true, output(r));
    assert.match(output(r), /re-call with confirm:true to execute/);
  }
  assert.deepEqual([...snap(f.base).keys()].sort(), [...before.keys()].sort(), "no file added");
  assert.ok(sameTree(before, snap(f.base)), "no file changed");
});

test("confirm:true executes: create writes, verifies and re-reads", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const done = await knowledgeWrite({ op: "create", target: "Knowledge/new note.md", body: "fresh body [[topic]]", confirm: true }, c.forCall({}));
  assert.match(output(done), /create OK: Knowledge\/new note\.md/);
  assert.match(output(done), /verification: re-read frontmatter parses; rediscovered by search/);
  const note = parseNote(readFileSync(join(f.main, "Knowledge", "new note.md"), "utf8"));
  assert.match(note.body, /fresh body/);
  assert.equal(note.frontmatter.title, "new note"); // neighbours have frontmatter → emitted
});

test("write previews name the vault and, for multi-root sources, the root", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const multi = output(await knowledgeWrite({ op: "create", target: "Knowledge/x.md", body: "x" }, c.forCall({})));
  assert.match(multi, /vault: work/);
  assert.match(multi, /root: main/);
  const single = output(await knowledgeWrite({ op: "create", target: "notes/x.md", body: "x", vault: "personal" }, c.forCall({ vault: "personal" })));
  assert.match(single, /vault: personal/);
  assert.doesNotMatch(single, /root:/);
});

test("secrets are the one blocking case: preview warns, confirm refuses", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const args = { op: "create", target: "Knowledge/leak.md", body: "key AKIAIOSFODNN7EXAMPLE" };
  const preview = await knowledgeWrite(args, c.forCall({}));
  assert.notEqual(preview.isError, true);
  assert.match(output(preview), /possible secrets in content: AWS access key/);
  const refused = await knowledgeWrite({ ...args, confirm: true }, c.forCall({}));
  assert.equal(refused.isError, true);
  assert.match(output(refused), /^refusing to write: possible secrets \(AWS access key\)$/);
  assert.equal(existsSync(join(f.main, "Knowledge", "leak.md")), false);
});

test("allowWrite=false keeps the source gate text", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const cfg = JSON.parse(readFileSync(f.configPath, "utf8"));
  writeFileSync(f.configPath, JSON.stringify({ ...cfg, allowWrite: false }));
  const denied = await knowledgeWrite({ op: "create", target: "Knowledge/x.md", body: "x", confirm: true }, c.forCall({}));
  assert.equal(denied.isError, true);
  assert.match(output(denied), /^writes disabled \(allowWrite=false in config\)$/);
  const moveDenied = await knowledgeMove({ from: "Knowledge/topic.md", to: "Knowledge/y.md", confirm: true }, c.forCall({}));
  assert.match(output(moveDenied), /^writes disabled \(allowWrite=false in config\)$/);
  const taskDenied = await knowledgeTask({ action: "init", ticket: "X", title: "x", confirm: true }, c.forTask({ ticket: "X" }));
  assert.match(output(taskDenied), /^writes disabled \(allowWrite=false in config\)$/);
});

// ── read-only roots ───────────────────────────────────────────────────────

test("a read-only root refuses writes with its own text", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  // create with explicit addressing → resolution error (thrown → isError at the server edge)
  await assert.rejects(
    () => knowledgeWrite({ op: "create", target: "archive:New.md", body: "x", confirm: true }, c.forCall({})),
    /source root "archive" is read-only by config/,
  );
  // update of a note living in the read-only root → explicit refusal result
  const refused = await knowledgeWrite({ op: "update", target: "archive:Old/overview.md", body: "x" }, c.forCall({}));
  assert.equal(refused.isError, true);
  assert.match(output(refused), /^source root "archive" is read-only by config$/);
  const moveRefused = await knowledgeMove({ from: "archive:Old/overview.md", to: "Old/moved.md", confirm: true }, c.forCall({}));
  assert.equal(moveRefused.isError, true);
  assert.match(output(moveRefused), /^source root "archive" is read-only by config$/);
});

// ── ambiguity ─────────────────────────────────────────────────────────────

test("ambiguous basename and ambiguous path keep their messages", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  await assert.rejects(
    () => knowledgeRead({ path: "overview" }, c.forCall({})),
    /ambiguous path in source "work": main:Projects\/overview\.md, archive:Old\/overview\.md — address as "main:Projects\/overview\.md"/,
  );
  await assert.rejects(
    () => knowledgeRead({ path: "Projects/nope.md", vault: "work" }, c.forCall({ vault: "work" })),
    /note not found: Projects\/nope\.md/,
  );
  // label addressing resolves the same note unambiguously
  const read = await knowledgeRead({ path: "archive:Old/overview.md" }, c.forCall({}));
  assert.match(output(read), /archived access/);
});

// ── multi-source grouped search ───────────────────────────────────────────

test("single source, single root: hybrid search stays byte-compatible (provider first line)", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const out = output(await knowledgeSearch({ query: "personal needle", vault: "personal" }, c.forSearch("personal")));
  const lines = out.split("\n");
  assert.equal(lines[0], "rg"); // provider head, exactly as the source
  assert.match(lines[1], /^1\) notes\/personal\.md/);
  const none = output(await knowledgeSearch({ query: "zzz-not-there", vault: "personal" }, c.forSearch("personal")));
  assert.equal(none, "rg\nno matches (try other terms, or mode=graph)");
  const lexical = output(await knowledgeSearch({ query: "zzz-not-there", mode: "lexical", vault: "personal" }, c.forSearch("personal")));
  assert.equal(lexical, "no matches (a failed search is not proof of absence — try other terms/scopes)");
});

test("multi-source search groups by source and root, with skipped entries and the degraded note", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const out = output(await knowledgeSearch({ query: "access", vault: ["work", "personal", "dead"] }, c.forSearch(["work", "personal", "dead"])));
  const lines = out.split("\n");
  assert.equal(lines[0], "vaults: work (2 roots), personal");
  assert.ok(lines.includes("work / main (1 hit, rg)"), out);
  assert.ok(lines.some((l) => l.startsWith("  1) Projects/overview.md")), out);
  assert.ok(lines.includes("skipped: dead (directory missing)"), out);
  assert.ok(out.endsWith("note: degraded: lexical only"), out); // qmd disabled by config
  // a source asked for by name that is not configured is reported, not fatal
  const unknown = output(await knowledgeSearch({ query: "personal needle", vault: ["personal", "bogus"] }, c.forSearch(["personal", "bogus"])));
  assert.match(unknown, /skipped: bogus \(unknown vault\)/);
  assert.match(unknown, /^personal \(1 hit, rg\)$/m);
});

test("limit clamps per group: small limits return fewer hits, huge limits are capped not rejected", async (t) => {
  const f = makeTree(t);
  for (let i = 0; i < 7; i++) writeFileSync(join(f.personal, "notes", `match-${i}.md`), `needle hit ${i}\n`);
  const c = createContext();
  const two = output(await knowledgeSearch({ query: "needle", vault: "personal", limit: 2 }, c.forSearch("personal")));
  assert.equal(two.split("\n").length - 1, 2, two); // provider line + 2 hits
  const capped = await knowledgeSearch({ query: "needle", vault: "personal", limit: 5000 }, c.forSearch("personal"));
  assert.notEqual(capped.isError, true); // clamped in code, never rejected
  assert.ok(output(capped).split("\n").length - 1 <= 101);
});

// ── graph mode ────────────────────────────────────────────────────────────

test("graph mode expands one hop: outgoing links and backlinks across the roots", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const out = output(await knowledgeSearch({ query: "alpha access notes", mode: "graph" }, c.forSearch(undefined)));
  assert.match(out, /# work\/main\/Projects\/overview\.md/); // source + label when several sources are searched
  assert.match(out, /outgoing: .*work\/main\/Projects\/connector\.md/);
  assert.match(out, /backlinks: \(none\)|backlinks: .*/);
  const noSeed = output(await knowledgeSearch({ query: "zzz-no-seed", mode: "graph", vault: "personal" }, c.forSearch("personal")));
  assert.equal(noSeed, 'no seed note for "zzz-no-seed" — nothing to expand');
});

// ── read / links ──────────────────────────────────────────────────────────

test("read meta/outline/section/body with maxChars clamp", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const meta = output(await knowledgeRead({ path: "topic" }, c.forCall({})));
  assert.match(meta, /^main\/Knowledge\/topic\.md$/m); // label-prefixed for multi-root
  assert.match(meta, /--- frontmatter ---\ntitle: Topic\nupdated: 2026-01-01\n--- outline ---\n- Topic \(:1\)\n  - Alpha \(:3\)\n  - Beta \(:7\)\n--- summary ---\nalpha text/);
  const sectionErr = await knowledgeRead({ path: "topic", part: "section", section: "Gamma" }, c.forCall({}));
  assert.equal(sectionErr.isError, true);
  assert.match(output(sectionErr), /section "Gamma" not found in main\/Knowledge\/topic\.md \(see part=outline\)/);
  const noSection = await knowledgeRead({ path: "topic", part: "section" }, c.forCall({}));
  assert.match(output(noSection), /part=section requires section=<heading text>/);
  const alpha = output(await knowledgeRead({ path: "topic", part: "section", section: "Alpha", maxChars: 5 }, c.forCall({})));
  assert.match(alpha, /alph\n… \(truncated\)/); // clamp applied
  const body = output(await knowledgeRead({ path: "personal", part: "body", vault: "personal" }, c.forCall({ vault: "personal" })));
  assert.match(body, /^notes\/personal\.md\n\npersonal needle notes\n?$/);
});

test("links: outgoing resolution states and backlinks across roots", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const out = output(await knowledgeLinks({ path: "Projects/overview.md" }, c.forCall({})));
  assert.match(out, /^main\/Projects\/overview\.md$/m);
  assert.match(out, /outgoing:\n  \[\[connector\]\] → main\/Projects\/connector\.md/);
  assert.match(out, /backlinks \(0\): \(none\)/);
  const back = output(await knowledgeLinks({ path: "connector", direction: "back" }, c.forCall({})));
  assert.match(back, /backlinks \(1\): main\/Projects\/overview\.md/);
});

// ── structure / conventions ───────────────────────────────────────────────

test("conventions answers the format question from the neighbours of one root", async (t) => {
  const f = makeTree(t);
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(f.main, "Knowledge", `kebab-note-${i}.md`), "---\ntitle: x\n---\n[[topic]]\n");
  }
  const c = createContext();
  const out = output(await knowledgeStructure({ action: "conventions", scope: "Knowledge" }, c.forCall({})));
  assert.match(out, /scope: Knowledge  \(sampled 4 notes\)/);
  assert.match(out, /naming: kebab-case/);
  assert.match(out, /frontmatter: 100% of neighbours; common keys: title, updated/);
  assert.match(out, /→ write \[\[wikilinks\]\]/);
  assert.match(out, /guidance: new notes here → kebab-case filename, frontmatter with title\/updated keys, \[\[wikilinks\]\]\./);
});

test("inventory lists per-folder counts, label-prefixed for a multi-root source", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const out = output(await knowledgeStructure({ action: "inventory" }, c.forCall({})));
  assert.match(out, /^vault: work \(main, archive\)$/m);
  assert.match(out, /notes: 4   frontmatter coverage: 75% \(sampled 4\)/);
  assert.match(out, /git: NO \(no version history — retire\/supersede markers are the only undo\)   qmd: –/);
  assert.match(out, /  2  main\/Projects\//);
  assert.match(out, /  1  main\/Knowledge\//);
  assert.match(out, /  1  archive\/Old\//);
});

// ── repo map ──────────────────────────────────────────────────────────────

test("knowledge_repo lists matching task workspaces, concept notes and the catalog", async (t) => {
  const f = makeTree(t);
  const ws = join(f.main, "tasks", "PLAN-1");
  mkdirSync(join(ws, "iterations"), { recursive: true });
  writeFileSync(join(ws, "_task_index.md"), "---\nformat: numados-task-index-v1\ntask_id: PLAN-1\ntitle: Alpha fix\nstatus: implementing\nrepository: service-a\nupdated: 2026-02-03\n---\nCurrent state: mid\n");
  writeFileSync(join(ws, "iterations", "0001-planning.md"), "---\nstatus: ready\n---\nhistorical\n");
  writeFileSync(join(f.main, "Knowledge", "service-a.md"), "see [[service-a]] service notes\n");
  mkdirSync(join(f.main, "knowledge-index", "repo-index"), { recursive: true });
  writeFileSync(join(f.main, "knowledge-index", "repo-index", "catalog.jsonl"), `{"repo": "service-a", "note": "Knowledge/topic.md"}\n{"repo": "other"}\n`);
  const c = createContext();
  const out = output(await knowledgeRepo({ repo: "service-a" }, c.forCall({})));
  assert.match(out, /repo: service-a   \(vault: work\)/);
  assert.match(out, /task workspaces \(1\):\n  2026-02-03  implementing PLAN-1 — Alpha fix/);
  assert.match(out, /concept notes mentioning it \(1\):\n  main\/Knowledge\/service-a\.md/);
  assert.match(out, /repo-index catalog: 1 entry/);
});

// ── task two-phase on the multi-root fixture ──────────────────────────────

test("task workspaces resolve in the taskVault write root and init preview writes nothing", async (t) => {
  const f = makeTree(t);
  const c = createContext();
  const before = snap(f.base);
  const args = { action: "init", ticket: "TKT-1", title: "First" };
  const preview = await knowledgeTask(args, c.forTask(args));
  assert.match(output(preview), /op: task-init   target: tasks\/TKT-1\/_task_index\.md/);
  assert.match(output(preview), /vault: work/);
  assert.match(output(preview), /root: main/);
  assert.ok(sameTree(before, snap(f.base)));
  await knowledgeTask({ ...args, confirm: true }, c.forTask({ ...args, confirm: true }));
  assert.equal(existsSync(join(f.main, "tasks", "TKT-1", "_task_index.md")), true);
  assert.equal(existsSync(join(f.archive, "tasks")), false, "read-only root untouched");
  const status = output(await knowledgeTask({ ticket: "TKT-1" }, c.forTask({ ticket: "TKT-1" })));
  assert.match(status, /task_id: TKT-1/);
  assert.match(status, /workspace: tasks\/TKT-1\/_task_index\.md$/m);

  // a phase is a filename token, never a path (source behaviour)
  for (const phase of ["../../../../outside", "sub/token", ".hidden"]) {
    const bad = await knowledgeTask(
      { action: "iteration", ticket: "TKT-1", stage: "implementation", phase, confirm: true },
      c.forTask({ action: "iteration", ticket: "TKT-1", stage: "implementation", phase, confirm: true }),
    );
    assert.equal(bad.isError, true, phase);
    assert.match(output(bad), /phase must contain only/);
  }
  assert.equal(existsSync(join(f.main, "outside.md")), false);
  assert.equal(existsSync(join(f.main, "tasks", "TKT-1", "iterations")), false, "no event written");
  const nullPhase = output(await knowledgeTask(
    { action: "iteration", ticket: "TKT-1", stage: "implementation", phase: null },
    c.forTask({ action: "iteration", ticket: "TKT-1", stage: "implementation", phase: null }),
  ));
  assert.match(nullPhase, /target: .*0001-implementation\.md/);
  assert.doesNotMatch(nullPhase, /implementation-null/);
});

// ── move ──────────────────────────────────────────────────────────────────

test("move rewrites wikilinks across the whole source and verifies the destination", async (t) => {
  const f = makeTree(t);
  for (let i = 0; i < 3; i++) writeFileSync(join(f.main, "Knowledge", `link-${i}.md`), `see [[topic]] and [[Knowledge/topic]]\n`);
  const c = createContext();
  const preview = output(await knowledgeMove({ from: "Knowledge/topic.md", to: "Knowledge/renamed-topic.md" }, c.forCall({})));
  assert.match(preview, /move: main\/Knowledge\/topic\.md → main\/Knowledge\/renamed-topic\.md/);
  assert.match(preview, /link rewrite: 3 files reference \[\[topic\]\]/);
  assert.match(preview, /affected:\n(  main\/Knowledge\/link-\d\.md\n){2}  main\/Knowledge\/link-\d\.md/);
  const done = output(await knowledgeMove({ from: "Knowledge/topic.md", to: "Knowledge/renamed-topic.md", confirm: true }, c.forCall({})));
  assert.match(done, /moved: main\/Knowledge\/topic\.md → main\/Knowledge\/renamed-topic\.md/);
  assert.match(done, /links rewritten in 3\/3 files/);
  assert.match(done, /verification: destination re-read \d+ chars OK/);
  const relinker = readFileSync(join(f.main, "Knowledge", "link-0.md"), "utf8");
  assert.match(relinker, /\[\[renamed-topic\]\]/);
  assert.equal(existsSync(join(f.main, "Knowledge", "topic.md")), false);
});
