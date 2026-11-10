/**
 * Compatibility smoke test against the installed Pi MCP client.
 *
 * The child gets an allowlisted environment, a temporary HOME and a fixture
 * config that disables the paid and service-backed providers, so the test does
 * not depend on a subscription, a Spotlight index or a running zoekt service.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

const TOOL_NAMES = [
  "providers",
  "search",
  "search_crossrepo",
  "search_docs",
  "search_files",
  "search_machine",
  "search_semantic",
  "search_structure",
  "search_text",
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

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "search-mcp-smoke-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src", "app.ts"),
    "export function needleFinder(haystack: string) {\n  return haystack.includes('needle');\n}\n",
  );
  writeFileSync(path.join(root, "notes.md"), "# Notes\nThe needleFinder lives in src/app.ts\n");
  writeFileSync(
    path.join(root, "providers.json"),
    JSON.stringify({ providers: { auggie: { enabled: false }, serena: { enabled: false }, zoekt: { enabled: false } } }),
  );
  return { root, config: path.join(root, "providers.json") };
}

async function withServer(t, run) {
  const pi = await loadPiClient();
  if (!pi) {
    t.skip("Pi MCP client not found; set PI_MCP_ROOT to run the compatibility smoke test");
    return;
  }
  const { root, config } = makeFixture();
  const home = mkdtempSync(path.join(tmpdir(), "search-mcp-smoke-home-"));
  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: root,
    inheritEnv: false,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      SEARCH_MCP_CONFIG: config,
    },
    stderr: "pipe",
  });
  const client = new McpClient({ name: "search-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await run({ client, root });
  } finally {
    await client.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("Pi client negotiates and reaches the search server", async (t) => {
  await withServer(t, async ({ client }) => {
    assert.equal(client.protocolVersion, "2025-11-25", "Pi's revision is still served");
    assert.equal(client.serverInfo?.name, "search");
    assert.ok(client.instructions && client.instructions.length > 0, "server instructions survive the handshake");
  });
});

test("tools/list advertises the nine inherited tools, all read-only", async (t) => {
  await withServer(t, async ({ client }) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} advertises an output schema`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is read-only`);
      assert.equal(tool.annotations?.openWorldHint, true, `${tool.name} reads the world`);
    }
    const structure = tools.find((tool) => tool.name === "search_structure");
    assert.deepEqual(structure.inputSchema.required, ["query", "lang"]);
  });
});

test("routed text search finds the fixture file through rg", async (t) => {
  await withServer(t, async ({ client, root }) => {
    const result = await client.callTool("search", { intent: "text", query: "needleFinder", roots: [root] });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.provider, "rg");
    assert.ok(result.structuredContent.results.some((hit) => /app\.ts$/.test(hit.path)));
    assert.match(result.content[0].text, /needleFinder/);
  });
});

test("filename search finds a file by name", async (t) => {
  await withServer(t, async ({ client, root }) => {
    const result = await client.callTool("search_files", { query: "notes", roots: [root] });
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent.results.some((hit) => /notes\.md$/.test(hit.path)));
  });
});

test("a too-broad root is refused with the contract wording", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("search_text", { query: "x", roots: ["/"] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /search_text failed: root too broad, rejected: \//);
  });
});

test("providers reports the table, and doctor reports the machine", async (t) => {
  await withServer(t, async ({ client }) => {
    const status = await client.callTool("providers", {});
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /rg/);
    assert.match(status.content[0].text, /auggie \[semantic\] — disabled by config/);
    assert.ok(Array.isArray(status.structuredContent.providers));

    const doctor = await client.callTool("providers", { action: "doctor" });
    assert.equal(doctor.isError, undefined);
    assert.match(doctor.content[0].text, /ast-grep/);
    assert.ok(Array.isArray(doctor.structuredContent.requirements));
    const zoekt = doctor.structuredContent.requirements.find((entry) => entry.provider === "zoekt");
    assert.equal(zoekt.verdict, "disabled");
  });
});

test("an unknown tool is a protocol-level failure", async (t) => {
  await withServer(t, async ({ client }) => {
    await assert.rejects(
      () => client.callTool("not_a_tool", {}),
      (error) => {
        assert.match(String(error.message ?? error), /not_a_tool|not found|Method not found/i);
        return true;
      },
    );
  });
});
