/**
 * Compatibility smoke test against the installed Pi MCP client: spawn the
 * built server through Pi's own client (connect → tools/list → tools/call)
 * on a temp tree with two sources — one of them multi-root (a writable root
 * plus a read-only root) — qmd disabled by config and a prepared task
 * workspace. The live vault is never touched (KNOWLEDGE_MCP_CONFIG points at
 * the fixture, HOME is a temp dir, no network).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

const TOOL_NAMES = [
  "knowledge_links",
  "knowledge_move",
  "knowledge_read",
  "knowledge_repo",
  "knowledge_search",
  "knowledge_status",
  "knowledge_structure",
  "knowledge_task",
  "knowledge_write",
];

function findPiMcpRoot() {
  const explicit = process.env.PI_MCP_ROOT;
  const candidates = [
    ...(explicit ? [explicit] : []),
    path.resolve(
      process.execPath,
      "..",
      "..",
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@earendil-works",
      "pi-mcp",
    ),
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "dist", "client.js")));
}

async function loadPiClient() {
  const root = findPiMcpRoot();
  if (!root) return null;
  const client = await import(path.join(root, "dist", "client.js"));
  const stdio = await import(path.join(root, "dist", "transports", "stdio.js"));
  return { McpClient: client.McpClient, StdioTransport: stdio.StdioTransport };
}

/** Two sources: work = writable main + read-only archive, personal = one root. */
function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "knowledge-mcp-smoke-"));
  const main = path.join(root, "work-main");
  const archive = path.join(root, "work-archive");
  const personal = path.join(root, "personal");
  mkdirSync(path.join(main, "Knowledge"), { recursive: true });
  mkdirSync(path.join(main, "tasks", "SMOKE-1", "iterations"), { recursive: true });
  mkdirSync(path.join(archive, "Old"), { recursive: true });
  mkdirSync(path.join(personal, "notes"), { recursive: true });
  writeFileSync(
    path.join(main, "Knowledge", "alpha.md"),
    "---\ntitle: Projects\nupdated: 2026-11-11\n---\n# Projects\n\nsmoke needle notes, see [[retry]]\n",
  );
  writeFileSync(path.join(main, "Knowledge", "retry.md"), "retry policy notes\n");
  writeFileSync(path.join(archive, "Old", "archive.md"), "archived smoke needle\n");
  writeFileSync(path.join(personal, "notes", "personal.md"), "plain personal notes\n");
  writeFileSync(
    path.join(main, "tasks", "SMOKE-1", "_task_index.md"),
    "---\nformat: numados-task-index-v1\ntask_id: SMOKE-1\ntitle: Smoke task\nstatus: planning\nrepository: smoke-repo\nrepos: [{name: smoke-repo}]\ncurrent_phase: none\ncreated: 2026-11-11\nupdated: 2026-11-11\nlatest_iteration: iterations/0001-planning.md\n---\nCurrent state: prepared\nNext: smoke\nBlocker: none\n",
  );
  writeFileSync(
    path.join(main, "tasks", "SMOKE-1", "iterations", "0001-planning.md"),
    '---\nformat: "numados-task-iteration-v1"\ntask_id: SMOKE-1\niteration: "0001"\nstage: planning\nstatus: active\nprevious: null\ncreated: 2026-11-11\n---\n# Iteration 0001 — planning\n\n## Intent\n\nprepare the fixture\n',
  );
  const config = path.join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      vaults: {
        work: {
          paths: [
            { path: main, label: "main" },
            { path: archive, label: "archive", writable: false, qmd: false },
          ],
        },
        personal,
      },
      defaultVaults: ["work", "personal"],
      taskVault: "work",
      knowledgeRoot: "Knowledge",
      defaultTaskRoot: "tasks",
      allowWrite: true,
      qmd: { enabled: false },
    }),
  );
  return { root, config, main, archive, personal };
}

async function withServer(t, run) {
  const pi = await loadPiClient();
  if (!pi) {
    t.skip("Pi MCP client not found; set PI_MCP_ROOT to run the compatibility smoke test");
    return;
  }
  const fixture = makeFixture();
  const home = mkdtempSync(path.join(tmpdir(), "knowledge-mcp-smoke-home-"));
  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: fixture.root,
    inheritEnv: false,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      KNOWLEDGE_MCP_CONFIG: fixture.config,
    },
    stderr: "pipe",
  });
  const client = new McpClient({ name: "knowledge-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await run({ client, ...fixture });
  } finally {
    await client.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const textOf = (result) => result.content[0].text;

test("Pi client negotiates with the knowledge server", async (t) => {
  await withServer(t, async ({ client }) => {
    assert.equal(client.serverInfo?.name, "knowledge");
    assert.ok(client.serverInfo?.version && client.serverInfo.version !== "0.0.0");
    assert.ok(client.instructions && client.instructions.length > 0, "server instructions survive the handshake");
  });
});

test("tools/list advertises exactly the nine tools with their annotations", async (t) => {
  await withServer(t, async ({ client }) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
    const write = tools.find((tool) => tool.name === "knowledge_write");
    assert.equal(write.annotations.destructiveHint, true);
    assert.equal(write.annotations.readOnlyHint, false);
    const read = tools.find((tool) => tool.name === "knowledge_read");
    assert.equal(read.annotations.readOnlyHint, true);
    assert.equal(read.annotations.idempotentHint, true);
    assert.equal(read.outputSchema, undefined, "no output schema — the text is the contract");
    assert.deepEqual(read.inputSchema.required, ["path"], "only path is required");
  });
});

test("knowledge_status reports both sources through the doctor", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("knowledge_status", {});
    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.match(text, /config: .*config\.json - ok/);
    assert.match(text, /work - 2 roots \(default, taskVault\)/);
    assert.match(text, /main: ok - .*\(\d+ notes/);
    assert.match(text, /archive: ok - .*read-only/);
    assert.match(text, /personal - 1 root/);
    assert.match(text, /qmd.*disabled|qmd.*off/, text);
  });
});

test("knowledge_search finds the note through rg (qmd disabled by config)", async (t) => {
  await withServer(t, async ({ client }) => {
    const grouped = await client.callTool("knowledge_search", { query: "smoke needle" });
    assert.equal(grouped.isError, undefined);
    const text = textOf(grouped);
    assert.match(text, /vaults: work \(2 roots\), personal/);
    assert.match(text, /work \/ main \(\d+ hits?, rg\)/);
    assert.match(text, /Knowledge\/alpha\.md/);
    assert.match(text, /note: degraded: lexical only/);

    const single = await client.callTool("knowledge_search", { query: "smoke needle", vault: "personal" });
    assert.equal(textOf(single).split("\n")[0], "rg\nno matches (try other terms, or mode=graph)".split("\n")[0]);
    assert.match(textOf(single), /no matches \(try other terms, or mode=graph\)/);
  });
});

test("knowledge_read returns meta with frontmatter, outline and summary", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("knowledge_read", { path: "alpha" });
    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.match(text, /main\/Knowledge\/alpha\.md/);
    assert.match(text, /--- frontmatter ---\ntitle: Projects\nupdated: 2026-11-11\n--- outline ---\n- Projects \(:1\)\n--- summary ---\nsmoke needle notes, see \[\[retry\]\]/);
  });
});

test("knowledge_task status recovers the prepared workspace; init without confirm writes nothing", async (t) => {
  await withServer(t, async ({ client, main }) => {
    const status = await client.callTool("knowledge_task", { action: "status", ticket: "SMOKE-1" });
    assert.equal(status.isError, undefined);
    const text = textOf(status);
    assert.match(text, /task_id: SMOKE-1   status: planning/);
    assert.match(text, /iterations: 1 \(last: 0001-planning\.md\)/);
    assert.match(text, /latest: iterations\/0001-planning\.md\n  stage: planning  status: active  iteration: 0001/);

    const preview = await client.callTool("knowledge_task", { action: "init", ticket: "SMOKE-2", title: "Second" });
    assert.equal(preview.isError, undefined);
    assert.match(textOf(preview), /op: task-init   target: tasks\/SMOKE-2\/_task_index\.md/);
    assert.match(textOf(preview), /re-call with confirm:true to execute/);
    assert.equal(existsSync(path.join(main, "tasks", "SMOKE-2")), false, "preview must not create a workspace");
  });
});

test("knowledge_write: preview does not write, confirm:true writes inside the temp root", async (t) => {
  await withServer(t, async ({ client, main, archive }) => {
    const args = { op: "create", target: "Knowledge/created.md", body: "created over the wire [[alpha]]" };
    const preview = await client.callTool("knowledge_write", args);
    assert.equal(preview.isError, undefined);
    assert.match(textOf(preview), /op: create   target: Knowledge\/created\.md/);
    assert.match(textOf(preview), /vault: work/);
    assert.match(textOf(preview), /root: main/);
    assert.match(textOf(preview), /re-call with confirm:true to execute/);
    assert.equal(existsSync(path.join(main, "Knowledge", "created.md")), false, "preview must not write");

    const done = await client.callTool("knowledge_write", { ...args, confirm: true });
    assert.equal(done.isError, undefined);
    assert.match(textOf(done), /create OK: Knowledge\/created\.md/);
    const written = readFileSync(path.join(main, "Knowledge", "created.md"), "utf8");
    assert.match(written, /created over the wire/);
    assert.equal(existsSync(path.join(archive, "Knowledge")), false, "the read-only root stays untouched");
  });
});

test("a read-only root refuses a write over the wire", async (t) => {
  await withServer(t, async ({ client }) => {
    const refused = await client.callTool("knowledge_write", {
      op: "create",
      target: "archive:New.md",
      body: "x",
      confirm: true,
    });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /knowledge_write failed: source root "archive" is read-only by config/);
  });
});
