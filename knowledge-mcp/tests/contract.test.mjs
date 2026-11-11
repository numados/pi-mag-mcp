/**
 * Contract test: the nine tools, their titles and descriptions (copied
 * verbatim from the source server's src/tools.ts — they are user-visible and
 * quoted by the knowledge-vault skill), the annotations, the schema
 * behaviour (documented arguments accepted, unknown keys stripped, limits
 * clamped in code instead of rejected) and the absence of output schemas
 * (the text is the contract).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { LIMITS, TOOLS, toolByName } from "../dist/contract.js";

// ── titles and descriptions, verbatim from agent-toolkit …/src/tools.ts ────

const SOURCE_TEXTS = {
  "knowledge_status": {
    title: "Knowledge status",
    description:
      "Vault routing table, per-vault readiness (notes count, git, qmd), write gate, config sources. Run first when blaming routing or setup.",
  },
  "knowledge_search": {
    title: "Knowledge search",
    description:
      "Search the knowledge vault. Use FIRST for past-work/task-history/domain questions (task indexes and research notes live there). Modes: hybrid (qmd BM25→rg, default), lexical (rg with context), graph (find a note, then one-hop links+backlinks).",
  },
  "knowledge_read": {
    title: "Knowledge read",
    description:
      "Read a note bounded: part=meta (frontmatter+outline+summary) | outline | body | section (pass section name). Cites the vault-relative path.",
  },
  "knowledge_links": {
    title: "Knowledge links",
    description: "Outgoing wikilinks (with resolution) and backlinks of a note. One hop — the graph primitive.",
  },
  "knowledge_structure": {
    title: "Knowledge structure",
    description:
      'action=inventory: per-folder note counts, frontmatter coverage, git/qmd state. action=conventions: detected format of a scope (naming, frontmatter keys, link style) — the answer to "what format to write in here".',
  },
  "knowledge_write": {
    title: "Knowledge write",
    description:
      "Write a note — two-phase: without confirm:true returns a preview (rendered note / diff + warnings: duplicates, unresolved links, conventions, secrets); with confirm:true executes and re-validates. ops: create | update (body/content/frontmatter patch) | retire (status marker) | supersede (redirect). Never deletes.",
  },
  "knowledge_move": {
    title: "Knowledge move",
    description:
      "Rename/move a note with wikilink rewriting across the vault. Two-phase: preview lists affected files; confirm:true executes. Obsidian app is not required.",
  },
  "knowledge_task": {
    title: "Task tracking",
    description:
      "Repo task workspace protocol (numados-task-*): _task_index.md + immutable iterations/. Actions: status (recover latest state fast — read this FIRST when resuming a task), init (create workspace), iteration (append ONE event per meaningful workflow step: stage/status/intent/verified/changes/verification/handoff — this is what a small agent calls during brainstorm/implementation), update (index projection fields). Writes are two-phase (confirm:true executes). Task notes live in the CENTRAL vault under taskRoot (per-repo .knowledge-mcp.json declares it).",
  },
  "knowledge_repo": {
    title: "Repo knowledge map",
    description:
      "Knowledge network around a repository: task workspaces whose index lists the repo (progress history), concept notes mentioning/linking it, repo-index catalog entry if present. Answers 'what do we know about this repo / what happened here'.",
  },
};

const EXPECTED = Object.keys(SOURCE_TEXTS).sort();

test("the tool surface is exactly the nine inherited tools", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name).sort(), EXPECTED);
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 9);
});

test("titles and descriptions are verbatim from the source tools.ts", () => {
  for (const tool of TOOLS) {
    const source = SOURCE_TEXTS[tool.name];
    assert.ok(source, `${tool.name} is known`);
    assert.equal(tool.title, source.title, tool.name);
    assert.equal(tool.description, source.description, tool.name);
    assert.equal(tool.annotations.title, tool.title, `${tool.name} annotation carries the title`);
  }
});

test("annotations: read tools read-only and idempotent, writes destructive, task neither", () => {
  const readOnly = ["knowledge_status", "knowledge_search", "knowledge_read", "knowledge_links", "knowledge_structure", "knowledge_repo"];
  for (const name of readOnly) {
    const a = toolByName(name).annotations;
    assert.deepEqual(
      { readOnlyHint: a.readOnlyHint, idempotentHint: a.idempotentHint, openWorldHint: a.openWorldHint, destructiveHint: a.destructiveHint },
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
      name,
    );
  }
  for (const name of ["knowledge_write", "knowledge_move"]) {
    const a = toolByName(name).annotations;
    assert.deepEqual(
      { readOnlyHint: a.readOnlyHint, destructiveHint: a.destructiveHint, idempotentHint: a.idempotentHint, openWorldHint: a.openWorldHint },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      name,
    );
  }
  const task = toolByName("knowledge_task").annotations;
  assert.deepEqual(
    { readOnlyHint: task.readOnlyHint, destructiveHint: task.destructiveHint, idempotentHint: task.idempotentHint },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  );
});

test("no tool advertises an output schema — the text is the contract", () => {
  for (const tool of TOOLS) {
    assert.equal("outputSchema" in tool, false, tool.name);
    assert.equal(Object.hasOwn(tool, "structuredContent"), false, tool.name);
  }
});

test("documented arguments are accepted", () => {
  assert.equal(toolByName("knowledge_search").inputSchema.safeParse({ query: "alpha" }).success, true);
  assert.equal(
    toolByName("knowledge_search").inputSchema.safeParse({ query: "alpha", mode: "graph", scope: "Knowledge", limit: 10, vault: ["work", "personal"] }).success,
    true,
  );
  assert.equal(
    toolByName("knowledge_read").inputSchema.safeParse({ path: "a.md", part: "section", section: "Alpha", maxChars: 500, vault: "work" }).success,
    true,
  );
  assert.equal(toolByName("knowledge_links").inputSchema.safeParse({ path: "a.md", direction: "back" }).success, true);
  assert.equal(toolByName("knowledge_structure").inputSchema.safeParse({ action: "conventions", scope: "Knowledge" }).success, true);
  assert.equal(
    toolByName("knowledge_write").inputSchema.safeParse({ op: "update", target: "a.md", title: "T", frontmatter: { status: null, pinned: true }, body: "b", content: "c", superseded_by: "x", reason: "r", confirm: true, vault: "work" }).success,
    true,
  );
  assert.equal(toolByName("knowledge_move").inputSchema.safeParse({ from: "a.md", to: "b.md", updateLinks: false, confirm: true }).success, true);
  assert.equal(
    toolByName("knowledge_task").inputSchema.safeParse({ action: "iteration", ticket: "ABC-1", title: "T", repos: ["/work/r"], stage: "planning", status: "ready", taskStatus: "blocked", phase: "p1", intent: "i", verified: "v", changes: "c", verification: "V", handoff: "h", next: "n", blocker: "b", taskRoot: "tasks", confirm: true }).success,
    true,
  );
  assert.equal(toolByName("knowledge_repo").inputSchema.safeParse({ repo: "service-a", limit: 5 }).success, true);
  assert.equal(toolByName("knowledge_status").inputSchema.safeParse({}).success, true);
});

test("required arguments stay required", () => {
  assert.equal(toolByName("knowledge_search").inputSchema.safeParse({}).success, false);
  assert.equal(toolByName("knowledge_read").inputSchema.safeParse({}).success, false);
  assert.equal(toolByName("knowledge_write").inputSchema.safeParse({}).success, false);
  assert.equal(toolByName("knowledge_move").inputSchema.safeParse({ from: "a.md" }).success, false);
  assert.equal(toolByName("knowledge_task").inputSchema.safeParse({}).success, false);
});

test("unknown keys are stripped, never rejected", () => {
  const parsed = toolByName("knowledge_search").inputSchema.safeParse({ query: "x", bogus: 1, another: "y" });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, { query: "x" });
  const write = toolByName("knowledge_write").inputSchema.safeParse({ target: "a.md", nope: true });
  assert.equal(write.success, true);
  assert.equal("nope" in write.data, false);
});

test("limits and maxChars are clamped in code, not rejected by the schema", () => {
  assert.equal(toolByName("knowledge_search").inputSchema.safeParse({ query: "x", limit: 100_000 }).success, true);
  assert.equal(toolByName("knowledge_repo").inputSchema.safeParse({ repo: "x", limit: -3 }).success, true);
  assert.equal(toolByName("knowledge_read").inputSchema.safeParse({ path: "a", maxChars: 10_000_000 }).success, true);
  assert.equal(LIMITS.limitDefault, 20);
  assert.equal(LIMITS.limitMax, 100);
  assert.equal(LIMITS.maxCharsDefault, 6000);
});

test("enums reject unknown values at the schema, as documented", () => {
  assert.equal(toolByName("knowledge_search").inputSchema.safeParse({ query: "x", mode: "semantic" }).success, false);
  assert.equal(toolByName("knowledge_write").inputSchema.safeParse({ target: "a", op: "delete" }).success, false);
  assert.equal(toolByName("knowledge_task").inputSchema.safeParse({ ticket: "t", stage: "design" }).success, false);
  assert.equal(toolByName("knowledge_task").inputSchema.safeParse({ ticket: "t", status: "archived" }).success, false);
  assert.equal(toolByName("knowledge_task").inputSchema.safeParse({ ticket: "t", taskStatus: "active" }).success, false);
  // phase stays a free token (validated in the handler against a filename charset)
  assert.equal(toolByName("knowledge_task").inputSchema.safeParse({ ticket: "t", phase: "../../evil" }).success, true);
  assert.equal(toolByName("knowledge_task").inputSchema.safeParse({ ticket: "t", phase: null }).success, true, "null phase = no suffix");
});

test("vault accepts an array only on knowledge_search", () => {
  assert.equal(toolByName("knowledge_search").inputSchema.safeParse({ query: "x", vault: ["a", "b"] }).success, true);
  assert.equal(toolByName("knowledge_read").inputSchema.safeParse({ path: "a", vault: ["a"] }).success, false);
  assert.equal(toolByName("knowledge_write").inputSchema.safeParse({ target: "a", vault: ["a"] }).success, false);
});
