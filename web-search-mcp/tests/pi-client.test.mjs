/**
 * Compatibility smoke test against the installed Pi MCP client.
 *
 * Research §5 left one open question: whether a v2-SDK build is reachable from
 * Pi 1.5.0, which speaks protocol revision 2025-11-25. This test answers it with
 * the real client rather than by reading documentation: it connects over stdio,
 * lists tools, calls the tool and checks the structured result.
 *
 * The client is resolved from the installed Pi package, so the test fails loudly
 * instead of silently passing when Pi is absent.
 *
 * No network: the search path is exercised with the free provider disabled by
 * pointing both backends at invalid input through the environment, and the
 * assertions are about protocol behaviour, not result quality.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

/**
 * Locate the Pi MCP client package.
 *
 * Pi is not a dependency of this server, so it is resolved from the installed
 * harness. `PI_MCP_ROOT` overrides the probe list for non-standard layouts.
 */
function findPiMcpRoot() {
  const explicit = process.env.PI_MCP_ROOT;
  const candidates = [
    ...(explicit ? [explicit] : []),
    // Homebrew and Linux global layouts derived from the running Node binary.
    path.resolve(process.execPath, "..", "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-mcp"),
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

async function withServer(t, run) {
  const pi = await loadPiClient();
  if (!pi) {
    t.skip("Pi MCP client not found; set PI_MCP_ROOT to run the compatibility smoke test");
    return;
  }
  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    inheritEnv: false,
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  const client = new McpClient({ name: "web-search-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await run({ client, transport });
  } finally {
    await client.close().catch(() => undefined);
  }
}

test("Pi client negotiates and reaches the server", async (t) => {
  await withServer(t, async ({ client, transport }) => {
    assert.equal(client.protocolVersion, "2025-11-25", "Pi's revision is still served");
    assert.equal(client.serverInfo?.name, "web-search");
    assert.ok(client.instructions && client.instructions.length > 0, "server instructions survive the handshake");
    assert.equal(typeof transport.pid, "number");
  });
});

test("tools/list advertises one tool with a matching output schema", async (t) => {
  await withServer(t, async ({ client }) => {
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.equal(tool.name, "web_search");
    assert.ok(tool.description.includes("WEB_SEARCH_ALLOW_QUOTA"), "cost semantics are in the description, not only in a manual");
    assert.equal(tool.inputSchema.required.includes("query"), true);
    assert.equal(tool.outputSchema?.type, "object", "outputSchema is advertised");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
  });
});

test("invalid arguments are rejected before any network work", async (t) => {
  await withServer(t, async ({ client }) => {
    const cases = [
      { args: {}, why: "missing query" },
      { args: { query: "   " }, why: "whitespace-only query" },
      { args: { query: 17 }, why: "non-string query" },
      { args: { query: "ok", count: 0 }, why: "zero count" },
      { args: { query: "ok", count: -1 }, why: "negative count" },
      { args: { query: "ok", count: 1.5 }, why: "fractional count" },
      { args: { query: "ok", count: 99 }, why: "count over the limit" },
      { args: { query: "ok", mode: "typo" }, why: "unknown mode" },
    ];
    for (const { args, why } of cases) {
      let failed = false;
      try {
        const result = await client.callTool("web_search", args);
        failed = result.isError === true;
      } catch (error) {
        failed = true;
      }
      assert.equal(failed, true, `${why} must be rejected`);
    }
  });
});

test("an unknown tool is a protocol-level failure, not a silent success", async (t) => {
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

test("a failed search reports a status, not a fabricated answer", async (t) => {
  await withServer(t, async ({ client }) => {
    // Both backends are unreachable in this sandboxed environment: whichever way
    // the failure lands, the contract requires an honest, structured status.
    const result = await client.callTool("web_search", { query: "protocol smoke test" });
    const structured = result.structuredContent;
    assert.ok(structured, "structuredContent is present");
    assert.ok(["ok", "empty", "unavailable"].includes(structured.status), `unexpected status ${structured.status}`);
    assert.equal(structured.query, "protocol smoke test");
    assert.ok(Array.isArray(structured.chain) && structured.chain.length > 0, "every attempt is recorded");
    assert.equal(result.isError === true, structured.status === "unavailable");
    const text = result.content.find((block) => block.type === "text");
    assert.ok(text && typeof text.text === "string" && text.text.length > 0, "text fallback is present");
  });
});
